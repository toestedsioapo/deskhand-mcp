import { z } from "zod";
import type { CalendarProvider, EventRef } from "../providers/types.js";

export type RecheckResult = { ok: true } | { ok: false; reason: string };

export interface PlanKind<P> {
  kind: string;
  schema: z.ZodType<P>;
  /** Deterministic; built only from validated plan fields. Raw strings: sanitising is CLI-side. */
  renderDiff(plan: P): string[];
  recheck(plan: P, provider: CalendarProvider): Promise<RecheckResult>;
  lookupExisting(plan: P, idempotencyKey: string, provider: CalendarProvider): Promise<EventRef | null>;
  execute(plan: P, idempotencyKey: string, provider: CalendarProvider): Promise<EventRef>;
}

const instant = z.iso.datetime();

const newEventSchema = z
  .object({
    title: z.string().min(1),
    start: instant,
    end: instant,
    attendees: z.array(z.string()),
    sendUpdates: z.enum(["none", "all", "externalOnly"]),
    calendarId: z.string().min(1),
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

export const calendarCreateEvent: PlanKind<CalendarCreateEventPlan> = {
  kind: "calendar.create_event",
  schema: calendarCreateEventPlanSchema,

  renderDiff(plan) {
    const e = plan.event;
    const n = e.attendees.length;
    const lines = [
      `create event: ${e.title}`,
      `when: ${e.start} to ${e.end}`,
      `calendar: ${e.calendarId}`,
      `${n} attendees`,
    ];
    lines.push(
      e.sendUpdates !== "none" && n > 0
        ? `will email ${n} attendees`
        : "no attendee notifications (sendUpdates=none)",
    );
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

/** Diff lines for a stored plan; unknown or invalid plans give a fixed marker. */
export function renderDiff(planJson: unknown): string[] {
  const unknownKind = ["(unknown plan kind)"];
  if (typeof planJson !== "object" || planJson === null) return unknownKind;
  const k = (planJson as { kind?: unknown }).kind;
  const pk = typeof k === "string" ? getPlanKind(k) : undefined;
  if (!pk) return unknownKind;
  const parsed = pk.schema.safeParse(planJson);
  return parsed.success ? pk.renderDiff(parsed.data) : ["(invalid plan)"];
}
