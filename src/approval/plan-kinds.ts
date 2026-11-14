import { z } from "zod";
import type { CalendarProvider, EventRef } from "../providers/types.js";
import { formatLocalRange, isIanaTimeZone } from "../util/local-time.js";
import { isPlainLine, VISIBLE_ASCII } from "../util/sanitize.js";

export type RecheckResult = { ok: true } | { ok: false; reason: string };

export interface PlanKind<P> {
  kind: string;
  schema: z.ZodType<P>;
  /**
   * Deterministic for a given plan and viewer zone; built only from validated plan fields, printed verbatim. The
   * schema is what makes that safe: the title, the calendar id and every attendee are single lines of visible
   * text with no hidden character, so what the approver reads is exactly what is stored and written.
   * `viewerTimeZone` is the reader's zone, never the plan's.
   */
  renderDiff(plan: P, viewerTimeZone: string): string[];
  recheck(plan: P, provider: CalendarProvider): Promise<RecheckResult>;
  lookupExisting(plan: P, idempotencyKey: string, provider: CalendarProvider): Promise<EventRef | null>;
  execute(plan: P, idempotencyKey: string, provider: CalendarProvider): Promise<EventRef>;
}

// Exactly the form the plan tools store (Date.toISOString of a validated input): UTC, milliseconds, Z.
const instant = z.iso
  .datetime()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, { message: "must be a UTC instant with milliseconds" });

const newEventSchema = z
  .object({
    // Display equals write: a title the sanitiser would alter (control or invisible characters, odd whitespace)
    // or cut (over 200) is not a valid plan, so approve and apply refuse it instead of showing something else.
    title: z.string().min(1).max(200).refine(isPlainLine, { message: "must be one line of visible text" }),
    start: instant,
    end: instant,
    // Same rule as the tool input: an address, not any visible text.
    attendees: z.array(z.email().max(254).regex(VISIBLE_ASCII)).max(50),
    sendUpdates: z.enum(["none", "all", "externalOnly"]),
    calendarId: z.string().max(256).regex(VISIBLE_ASCII),
    timeZone: z.string().max(64).refine(isIanaTimeZone, { message: "must be an IANA time zone name" }).optional(),
  })
  .strict()
  .refine((e) => Date.parse(e.end) > Date.parse(e.start), { message: "end must be after start", path: ["end"] });

export const calendarCreateEventPlanSchema = z
  .object({
    kind: z.literal("calendar.create_event"),
    rationale: z.string().optional(),
    event: newEventSchema,
    observed: z
      .object({ slotFree: z.literal(true), etags: z.record(z.string(), z.string()) })
      .strict(),
  })
  .strict();

export type CalendarCreateEventPlan = z.infer<typeof calendarCreateEventPlanSchema>;

/** Always names the stored `sendUpdates` value when it is not the plain case, so the line never says `none` for a plan that stores `all`. */
function notificationLine(sendUpdates: "none" | "all" | "externalOnly", n: number): string {
  if (sendUpdates === "none") return "no attendee notifications (sendUpdates=none)";
  if (n === 0) return `no attendee notifications (sendUpdates=${sendUpdates}, no attendees)`;
  if (sendUpdates === "all") return `will email ${n} attendees`;
  return `will email the attendees outside your organisation, up to ${n} (sendUpdates=externalOnly)`;
}

export const calendarCreateEvent: PlanKind<CalendarCreateEventPlan> = {
  kind: "calendar.create_event",
  schema: calendarCreateEventPlanSchema,

  renderDiff(plan, viewerTimeZone) {
    const e = plan.event;
    const n = e.attendees.length;
    const lines = [`create event: ${e.title}`, `when: ${formatLocalRange(e.start, e.end, viewerTimeZone)}`];
    if (e.timeZone !== undefined && e.timeZone !== viewerTimeZone) {
      lines.push(`event zone: ${formatLocalRange(e.start, e.end, e.timeZone)}`);
    }
    lines.push(`utc: ${e.start} to ${e.end}`, `calendar: ${e.calendarId}`, `${n} attendees`);
    for (const a of e.attendees) lines.push(`  ${a}`);
    lines.push(notificationLine(e.sendUpdates, n));
    return lines;
  },

  async recheck(plan, provider) {
    const { event, observed } = plan;
    const { busy } = await provider.freeBusy(event.calendarId, { start: event.start, end: event.end });
    if (busy.length > 0) return { ok: false, reason: "the slot is no longer free" };
    for (const id of Object.keys(observed.etags).sort()) {
      const cur = await provider.getEvent(event.calendarId, id);
      if (!cur || cur.etag !== observed.etags[id]) {
        return { ok: false, reason: `event ${id} changed since planning` };
      }
    }
    return { ok: true };
  },

  lookupExisting: (plan, key, provider) => provider.getEvent(plan.event.calendarId, key),

  execute: (plan, key, provider) => provider.createEvent(plan.event, key),
};

const KINDS = new Map<string, PlanKind<unknown>>([
  [calendarCreateEvent.kind, calendarCreateEvent as unknown as PlanKind<unknown>],
]);

export function getPlanKind(kind: string): PlanKind<unknown> | undefined {
  return KINDS.get(kind);
}

// Escapes only: line feed, carriage return, line separator, paragraph separator.
const LINE_BREAKS = /[\n\r\u2028\u2029]+/g;

/**
 * Diff lines for a stored plan, times shown in `viewerTimeZone` (the caller passes `Config.timeZone`); unknown or
 * invalid plans give a fixed marker. Backstop for every plan kind: a returned line never contains a line break, so a
 * field a kind forgot to flatten still cannot start a new diff line in `deskhand pending` or `deskhand approve`.
 */
export function renderDiff(planJson: unknown, viewerTimeZone: string): string[] {
  const unknownKind = ["(unknown plan kind)"];
  if (typeof planJson !== "object" || planJson === null) return unknownKind;
  const k = (planJson as { kind?: unknown }).kind;
  const pk = typeof k === "string" ? getPlanKind(k) : undefined;
  if (!pk) return unknownKind;
  const parsed = pk.schema.safeParse(planJson);
  if (!parsed.success) return ["(invalid plan)"];
  return pk.renderDiff(parsed.data, viewerTimeZone).map((line) => line.replace(LINE_BREAKS, " "));
}
