import { z } from "zod";
import type { EventLookup, EventRef, Providers } from "../providers/types.js";
import { untrusted } from "../util/untrusted.js";
import { canonicalTimeZone, formatLocalRange, isIanaTimeZone } from "../util/local-time.js";
import { isPlainLine, VISIBLE_ASCII } from "../util/sanitize.js";
import { omittedMarker } from "../ledger/redact.js";
import { EVENT_DELETED } from "../providers/errors.js";
import { mailCreateDraftReply } from "./mail-draft-kind.js";

export type RecheckResult = { ok: true } | { ok: false; reason: string };

/** The `result` of an `action_apply` success. Its shape is enforced by action_apply's output schema. */
export type ApplyOutputResult = Record<string, unknown>;

/** What a provider holds under an action's idempotency key: nothing, a deleted write, or a value. */
export type Lookup<R> = { state: "absent" } | { state: "cancelled" } | { state: "present"; value: R };

/**
 * Who reads a diff. `approver`: the human at `deskhand pending` / `deskhand approve`, who sees everything that will
 * be written. `agent`: anything that goes back over MCP or into the ledger, where a kind may omit text (a drafted
 * body). The default is `agent`, so a forgotten call site omits rather than leaks.
 */
export type DiffAudience = "approver" | "agent";

/**
 * A plan kind: everything the plan store, approval and the apply engine need to know about one kind of write.
 * `P` is the validated plan, `R` what the provider returns for the write (an event, a draft).
 */
export interface PlanKind<P, R> {
  kind: string;
  schema: z.ZodType<P>;
  /**
   * Fixed phrases (no content) for a write under the action's id that is not the approved one (`differs`) and for
   * one that was created and later deleted (`deleted`). They become the STALE_PLAN message.
   */
  phrases: { differs: string; deleted: string };
  /**
   * Deterministic for a given plan, viewer zone and audience; built only from validated plan fields, printed
   * verbatim. The schema is what makes that safe: every field shown is single lines of visible text with no hidden
   * character, so what the approver reads is exactly what is stored and written. `viewerTimeZone` is the reader's
   * zone, never the plan's.
   */
  renderDiff(plan: P, viewerTimeZone: string, audience: DiffAudience): string[];
  recheck(plan: P, p: Providers): Promise<RecheckResult>;
  /** What the provider holds under the idempotency key: absent, cancelled (deleted) or present. */
  lookupExisting(plan: P, key: string, p: Providers): Promise<Lookup<R>>;
  /**
   * True only when `r` is the approved plan's own write: our id and every approved field. The apply engine calls
   * it for every value it would accept (recovery, the re-lookups, and the value `execute` returns, which may be an
   * existing one), so a foreign or edited write under our id is never recorded as applied.
   */
  matches(plan: P, key: string, r: R): boolean;
  execute(plan: P, key: string, p: Providers): Promise<R>;
  /** What is stored as `result_json` (canonical JSON of it). Never holds text the ledger must not keep. */
  store(r: R): unknown;
  /** The `action_apply` `result`, built from the parsed `result_json`: the first apply and a replay alike. */
  output(plan: P, stored: unknown): ApplyOutputResult;
  /** What `action_explain` returns as `plan`. */
  explainPlan(plan: P): unknown;
  /**
   * Optional integrity check on the RAW stored plan, run by approve and apply right after the hash check and before
   * the schema parse: true when the plan was edited in a way the hash does not cover (a drafted body that no longer
   * matches its stored length and hash). Approve refuses PLAN_MODIFIED (status unchanged); apply fails PLAN_MODIFIED.
   */
  tampered?(raw: unknown): boolean;
  /**
   * Optional: false when a valid plan can no longer be written (a draft whose body was swept). Approve refuses
   * PLAN_MODIFIED after its expiry check; apply fails PLAN_MODIFIED after recovery and expiry (gate 7a), before the
   * re-check, so the provider is never asked to write.
   */
  writable?(plan: P): boolean;
  /**
   * Optional: true when the provider has no unique key that refuses a second write, so apply must hold a ledger write
   * claim around it (gate 8b, src/approval/write-claim.ts).
   */
  needsWriteClaim?: boolean;
  /** Optional lines `deskhand approve` prints between the diff and the prompt (approver only, display only). */
  approveSummary?(plan: P): string[];
}

/** Fixed phrase (no event content): an event is under the action's id but it is not the approved one. */
export const EVENT_DIFFERS = "an event with this action's id exists but differs from the approved plan";

/** Attendee addresses compared as a set, case-insensitively, repeats collapsed. */
function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  const norm = (xs: readonly string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].sort();
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * The plan's attendees against a found event: the event's attendees (owner excluded) as they are, or with the owner
 * added when the plan invited the owner explicitly. The owner Google adds on its own is never a difference; an
 * extra address that is not the owner always is.
 */
function sameAttendees(planned: readonly string[], ev: EventRef): boolean {
  if (sameAddresses(planned, ev.attendees)) return true;
  return ev.ownerEmail !== undefined && sameAddresses(planned, [...ev.attendees, ev.ownerEmail]);
}

/** Two instants compared as times, not strings (`10:00Z` equals `11:00+01:00`); an unparseable one never matches. */
const sameInstant = (a: string, b: string): boolean => {
  const x = Date.parse(a);
  return !Number.isNaN(x) && x === Date.parse(b);
};

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

/** `1 attendee`, otherwise `<n> attendees`. */
function attendeeCount(n: number): string {
  return `${n} ${n === 1 ? "attendee" : "attendees"}`;
}

/** Always names the stored `sendUpdates` value when it is not the plain case, so the line never says `none` for a plan that stores `all`. */
function notificationLine(sendUpdates: "none" | "all" | "externalOnly", n: number): string {
  if (sendUpdates === "none") return "no attendee notifications (sendUpdates=none)";
  if (n === 0) return `no attendee notifications (sendUpdates=${sendUpdates}, no attendees)`;
  if (sendUpdates === "all") return `will email ${attendeeCount(n)}`;
  return `will email the attendees outside your organisation, up to ${n} (sendUpdates=externalOnly)`;
}

/** An `EventLookup` in the generic shape the apply engine reads. */
function toLookup(l: EventLookup): Lookup<EventRef> {
  return l.state === "present" ? { state: "present", value: l.event } : l;
}

export const calendarCreateEvent: PlanKind<CalendarCreateEventPlan, EventRef> = {
  kind: "calendar.create_event",
  schema: calendarCreateEventPlanSchema,
  phrases: { differs: EVENT_DIFFERS, deleted: EVENT_DELETED },

  // Nothing in a calendar plan is withheld from the agent: both audiences see the same lines.
  renderDiff(plan, viewerTimeZone) {
    const e = plan.event;
    const n = e.attendees.length;
    const lines = [`create event: ${e.title}`, `when: ${formatLocalRange(e.start, e.end, viewerTimeZone)}`];
    // Compare canonical forms: a plan stored with `europe/berlin` (hashed that way) is not a different zone.
    if (e.timeZone !== undefined && (canonicalTimeZone(e.timeZone) ?? e.timeZone) !== (canonicalTimeZone(viewerTimeZone) ?? viewerTimeZone)) {
      lines.push(`event zone: ${formatLocalRange(e.start, e.end, e.timeZone)}`);
    }
    lines.push(`utc: ${e.start} to ${e.end}`, `calendar: ${e.calendarId}`, attendeeCount(n));
    for (const a of e.attendees) lines.push(`  ${a}`);
    lines.push(notificationLine(e.sendUpdates, n));
    return lines;
  },

  async recheck(plan, { calendar: provider }) {
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

  lookupExisting: async (plan, key, p) => toLookup(await p.calendar.lookupEvent(plan.event.calendarId, key)),

  // The calendar is fixed by where it is looked up (lookupExisting and execute both use plan.event.calendarId).
  // The organiser must be the calendar owner (a foreign invite under our id is not our write), and a recurring
  // series or instance never matches a single-event plan.
  matches: (plan, key, ev) =>
    ev.id === key &&
    ev.organizerSelf === true &&
    ev.recurring !== true &&
    !ev.allDay &&
    ev.title === plan.event.title &&
    sameInstant(ev.start, plan.event.start) &&
    sameInstant(ev.end, plan.event.end) &&
    sameAttendees(plan.event.attendees, ev),

  execute: (plan, key, p) => p.calendar.createEvent(plan.event, key),

  store: (ev) => ev,

  // The event as the calendar holds it, shaped like a calendar_list_events item; its text is untrusted data from
  // the plan's calendar.
  output(plan, stored) {
    const e = stored as EventRef;
    const source = `calendar:${plan.event.calendarId}`;
    return {
      id: e.id,
      etag: e.etag,
      all_day: e.allDay,
      start: e.start,
      end: e.end,
      title: untrusted(source, e.title),
      attendees: e.attendees.map((a) => untrusted(source, a)),
    };
  },

  explainPlan: (plan) => plan,
};

/** A plan kind with its plan and result types erased, as the registry holds it. */
export type AnyPlanKind = PlanKind<unknown, unknown>;

const KINDS = new Map<string, AnyPlanKind>([
  [calendarCreateEvent.kind, calendarCreateEvent as unknown as AnyPlanKind],
  [mailCreateDraftReply.kind, mailCreateDraftReply as unknown as AnyPlanKind],
]);

export function getPlanKind(kind: string): AnyPlanKind | undefined {
  return KINDS.get(kind);
}

/**
 * An invalid draft plan names no thread that can be trusted, so its wrappers carry this fixed source.
 */
const INVALID_PLAN_SOURCE = "mail:invalid-plan";
const DRAFT_KEYS = new Set([
  "threadId",
  "messageIdHeader",
  "inReplyTo",
  "references",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "bodyChars",
  "bodySha256",
]);
const OBSERVED_KEYS = new Set(["latestMessageId", "messageIdsSha256", "onThread"]);
const PLAN_KEYS = new Set(["rationale", "rationaleSha256"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const wrapInvalid = (s: string) => untrusted(INVALID_PLAN_SOURCE, s);

/** Strings and arrays of strings wrapped as untrusted; an object as one wrapped JSON text; numbers, booleans, null kept. */
function wrapStored(v: unknown): unknown {
  if (typeof v === "string") return wrapInvalid(v);
  if (Array.isArray(v)) return v.map(wrapStored);
  return isRecord(v) ? wrapInvalid(JSON.stringify(v)) : v;
}

/** `value`'s known keys with wrapped values; every other key (its name may be mail text too) in one wrapped text. */
function wrapKnown(value: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const other: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (known.has(k)) out[k] = wrapStored(v);
    else other[k] = v;
  }
  if (Object.keys(other).length > 0) out["unrecognised"] = wrapInvalid(JSON.stringify(other));
  return out;
}

/** An invalid plan's `draft`: as wrapKnown, with the body (of any type) only ever an omitted marker. */
function wrapInvalidDraft(draft: unknown): unknown {
  if (!isRecord(draft)) return wrapStored(draft);
  const { body, bodyRemoved, ...rest } = draft;
  const marker = (v: unknown) => omittedMarker(typeof v === "string" ? v : (JSON.stringify(v) ?? "null"));
  return {
    ...wrapKnown(rest, DRAFT_KEYS),
    ...(body === undefined ? {} : { body: marker(body) }),
    ...(bodyRemoved === undefined ? {} : { bodyRemoved: bodyRemoved === true ? true : marker(bodyRemoved) }),
  };
}

/**
 * An invalid draft plan (edited, or stored before a rule tightened; whatever its kind says) as action_explain returns
 * it: every field that can hold mailbox text wrapped as untrusted, and the body an omitted marker (ADR 0010).
 */
function explainInvalidDraft(plan: Record<string, unknown>): unknown {
  const { kind, draft, observed, ...rest } = plan;
  return {
    ...(kind === undefined ? {} : { kind: kind === mailCreateDraftReply.kind ? kind : wrapStored(kind) }),
    ...wrapKnown(rest, PLAN_KEYS),
    ...(draft === undefined ? {} : { draft: wrapInvalidDraft(draft) }),
    ...(observed === undefined ? {} : { observed: isRecord(observed) ? wrapKnown(observed, OBSERVED_KEYS) : wrapStored(observed) }),
  };
}

/**
 * What `action_explain` returns as `plan`: the kind's `explainPlan` of a valid stored plan. It is given the stored
 * object itself (which the schema accepted), so the output keeps the stored key order. An unknown or invalid plan
 * that is draft-shaped (the draft kind, or any plan with a `draft` key) goes through explainInvalidDraft; any other is
 * returned as stored.
 */
export function explainStoredPlan(planJson: unknown): unknown {
  if (typeof planJson !== "object" || planJson === null) return planJson;
  const k = (planJson as { kind?: unknown }).kind;
  const pk = typeof k === "string" ? getPlanKind(k) : undefined;
  if (pk?.schema.safeParse(planJson).success) return pk.explainPlan(planJson);
  if (isRecord(planJson) && (k === mailCreateDraftReply.kind || Object.hasOwn(planJson, "draft"))) {
    return explainInvalidDraft(planJson);
  }
  return planJson;
}

// Escapes only: line feed, carriage return, line separator, paragraph separator.
const LINE_BREAKS = /[\n\r\u2028\u2029]+/g;

/**
 * Diff lines for a stored plan, times shown in `viewerTimeZone` (the caller passes `Config.timeZone`); unknown or
 * invalid plans give a fixed marker. Backstop for every plan kind: a returned line never contains a line break, so a
 * field a kind forgot to flatten still cannot start a new diff line in `deskhand pending` or `deskhand approve`.
 * `audience` defaults to `agent` (omit, never leak); only `deskhand pending` and `deskhand approve` pass `approver`.
 */
export function renderDiff(planJson: unknown, viewerTimeZone: string, audience: DiffAudience = "agent"): string[] {
  const unknownKind = ["(unknown plan kind)"];
  if (typeof planJson !== "object" || planJson === null) return unknownKind;
  const k = (planJson as { kind?: unknown }).kind;
  const pk = typeof k === "string" ? getPlanKind(k) : undefined;
  if (!pk) return unknownKind;
  const parsed = pk.schema.safeParse(planJson);
  if (!parsed.success) return ["(invalid plan)"];
  return pk.renderDiff(parsed.data, viewerTimeZone, audience).map((line) => line.replace(LINE_BREAKS, " "));
}
