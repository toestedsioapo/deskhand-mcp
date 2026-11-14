import { suggest } from "@marvinliem/tempo-core";
import type { PartyRules } from "./rules.js";

export { partyRulesSchema, type PartyRules } from "./rules.js";

/** A meeting slot: local-zone ISO strings plus the same instants in UTC. */
export interface Slot {
  start: string;
  end: string;
  startUtc: string;
  endUtc: string;
}

export interface SlotQuery {
  date: string;
  start: string;
  end: string;
  timeZone: string;
  /** 2 to 50 participants, caller first. */
  participants: PartyRules[];
  now: Date;
  minNoticeMinutes?: number;
  searchHorizonDays?: number;
  maxSuggestions?: number;
}

export type SlotResult =
  | {
      ok: true;
      decision: "book" | "counter_offer";
      requested: Slot;
      slots: Slot[];
      reasons: { code: string; participantId?: string; message: string }[];
    }
  | { ok: false; code: string; message: string };

const toSlot = (s: Slot): Slot => ({ start: s.start, end: s.end, startUtc: s.startUtc, endUtc: s.endUtc });

/** Tempo wants `YYYY-MM-DDTHH:mm:ssZ`: no milliseconds. */
const toTempoInstant = (d: Date): string => d.toISOString().slice(0, 19) + "Z";

/** Asks Tempo whether the requested slot fits every participant, with ranked alternatives. Never throws. */
export function findSlots(q: SlotQuery): SlotResult {
  if (Number.isNaN(q.now.getTime())) return { ok: false, code: "INVALID_INPUT", message: "`now` is not a valid date." };
  const options: { now: string; minNoticeMinutes?: number; searchHorizonDays?: number; maxSuggestions?: number } = {
    now: toTempoInstant(q.now),
  };
  if (q.minNoticeMinutes !== undefined) options.minNoticeMinutes = q.minNoticeMinutes;
  if (q.searchHorizonDays !== undefined) options.searchHorizonDays = q.searchHorizonDays;
  if (q.maxSuggestions !== undefined) options.maxSuggestions = q.maxSuggestions;

  const r = suggest({
    request: { date: q.date, start: q.start, end: q.end, timeZone: q.timeZone },
    participants: q.participants,
    options,
  });
  if (!r.ok) return { ok: false, code: r.error.code, message: r.error.message };
  return {
    ok: true,
    decision: r.decision,
    requested: toSlot(r.requested),
    slots: r.slots.map(toSlot),
    reasons: r.reasons.map((x) => ({
      code: x.code,
      ...(x.participantId !== undefined ? { participantId: x.participantId } : {}),
      message: x.message,
    })),
  };
}
