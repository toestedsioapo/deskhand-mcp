import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { requireProvider } from "./provider-guard.js";
import { toolError, toolOk, type ToolErrorResult, type ToolOkResult } from "./result.js";
import { loadOwnRules } from "../config/own-rules.js";
import { findSlots, partyRulesSchema, type PartyRules, type Slot } from "../tempo/index.js";
import { isIanaTimeZone } from "../util/local-time.js";

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const calendarFindSlotsInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start: clockTime,
    end: clockTime,
    time_zone: z.string().max(64).optional(),
    participants: z.array(partyRulesSchema).min(1).max(49),
    own_rules: partyRulesSchema.optional(),
    calendar_id: z.string().min(1).max(256).default("primary"),
    max_suggestions: z.number().int().min(1).max(10).default(3),
    min_notice_minutes: z.number().int().min(0).max(525600).default(0),
    search_horizon_days: z.number().int().min(1).max(90).default(14),
  })
  .strict();

const slotSchema = z.object({ start: z.string(), end: z.string(), startUtc: z.string(), endUtc: z.string() });

export const calendarFindSlotsOutputSchema = z.object({
  decision: z.enum(["book", "counter_offer", "none"]),
  requested: slotSchema,
  slots: z.array(slotSchema),
  busy_dropped: z.number().int(),
  reasons: z.array(z.object({ code: z.string(), participant_id: z.string().nullable(), message: z.string() })),
  note: z.string().nullable(),
});

export const CALENDAR_FIND_SLOTS_DESCRIPTION =
  "Find meeting slots that fit everyone's working-hours rules and are free in the caller's calendar. " +
  "Returns book (the requested slot works), counter_offer (alternatives) or none (every candidate is busy). " +
  "Read-only: has no side effects.";

type Output = z.infer<typeof calendarFindSlotsOutputSchema>;

/** Tempo is asked for the most suggestions it allows; the calendar then thins them, so more than max_suggestions are needed. */
const TEMPO_SUGGESTIONS = 10;

const overlapsAny = (s: Slot, busy: { start: string; end: string }[]): boolean => {
  const start = Date.parse(s.startUtc);
  const end = Date.parse(s.endUtc);
  return busy.some((b) => start < Date.parse(b.end) && end > Date.parse(b.start));
};

export async function calendarFindSlotsHandler(
  ctx: AppContext,
  input: z.infer<typeof calendarFindSlotsInputSchema>,
): Promise<ToolOkResult<Output> | ToolErrorResult> {
  const provider = requireProvider(ctx);
  if ("isError" in provider) return provider;

  const timeZone = input.time_zone ?? ctx.config.timeZone;
  if (!isIanaTimeZone(timeZone)) {
    return toolError("INVALID_INPUT", `time_zone must be an IANA zone name such as "Europe/Berlin", got "${timeZone}".`);
  }

  let own: PartyRules;
  if (input.own_rules !== undefined) {
    own = input.own_rules;
  } else {
    const loaded = loadOwnRules(ctx.config.rulesPath);
    if (!loaded.ok) return toolError("INVALID_INPUT", loaded.message);
    own = loaded.rules;
  }

  const found = findSlots({
    date: input.date,
    start: input.start,
    end: input.end,
    timeZone,
    participants: [own, ...input.participants],
    now: ctx.clock(),
    minNoticeMinutes: input.min_notice_minutes,
    searchHorizonDays: input.search_horizon_days,
    maxSuggestions: TEMPO_SUGGESTIONS,
  });
  if (!found.ok) return toolError("INVALID_INPUT", `Tempo ${found.code}: ${found.message}`);

  // On a Tempo `book`, slots[0] is the requested slot and the rest are ranked alternatives.
  const candidates = found.slots;
  let busy: { start: string; end: string }[] = [];
  if (candidates.length > 0) {
    const from = Math.min(...candidates.map((s) => Date.parse(s.startUtc)));
    const to = Math.max(...candidates.map((s) => Date.parse(s.endUtc)));
    try {
      busy = (
        await provider.freeBusy(input.calendar_id, { start: new Date(from).toISOString(), end: new Date(to).toISOString() })
      ).busy;
    } catch {
      return toolError("PROVIDER_ERROR", "The calendar provider failed to read free/busy.");
    }
  }

  const survivors = candidates.filter((s) => !overlapsAny(s, busy));
  const requestedFree = found.decision === "book" && survivors[0]?.startUtc === found.requested.startUtc;
  const decision: Output["decision"] = requestedFree ? "book" : survivors.length === 0 ? "none" : "counter_offer";
  const slots = requestedFree ? [survivors[0]!] : survivors.slice(0, input.max_suggestions);

  return toolOk({
    decision,
    requested: found.requested,
    slots,
    busy_dropped: requestedFree ? 0 : candidates.length - survivors.length,
    reasons: found.reasons.map((r) => ({ code: r.code, participant_id: r.participantId ?? null, message: r.message })),
    note: decision === "none" ? `All suggested slots are busy in calendar ${input.calendar_id}.` : null,
  });
}
