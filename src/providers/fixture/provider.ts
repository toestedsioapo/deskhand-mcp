import { appendFileSync } from "node:fs";
import { redactPreview } from "../../ledger/redact.js";
import type { CalendarProvider, EventRef, NewCalendarEvent, TimeRange } from "../types.js";
import type { FixtureWorld } from "./world.js";

export interface FixtureProvider extends CalendarProvider {
  readonly writes: readonly EventRef[];
  addBusy(calendarId: string, range: TimeRange): void;
  touchEvent(calendarId: string, id: string): void;
}

export interface FixtureProviderOptions {
  /** Called after a real write is recorded (and logged), never for an idempotent replay. */
  afterWrite?: () => void;
}

/** An event as an instant range; an all-day event spans UTC midnight to UTC midnight. */
const span = (e: EventRef): TimeRange =>
  e.allDay
    ? { start: `${e.start}T00:00:00.000Z`, end: `${e.end}T00:00:00.000Z` }
    : { start: e.start, end: e.end };

const copy = (e: EventRef): EventRef => ({ ...e, attendees: [...e.attendees] });

const overlaps = (a: TimeRange, b: TimeRange): boolean =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

/** In-memory fake world. State is copied from the world once; the file is never rewritten. */
export function createFixtureProvider(
  world: FixtureWorld,
  opts: FixtureProviderOptions = {},
): FixtureProvider {
  const calendars = new Map<string, Map<string, EventRef>>();
  for (const [calId, cal] of Object.entries(world.calendars)) {
    calendars.set(
      calId,
      new Map(
        cal.events.map(({ all_day, ...e }) => [
          e.id,
          { ...e, attendees: [...e.attendees], allDay: all_day === true } satisfies EventRef,
        ]),
      ),
    );
  }
  const extraBusy = new Map<string, TimeRange[]>();
  const writes: EventRef[] = [];
  const latency = world.settings.latency_ms;
  const writeLog = world.settings.write_log;
  let seq = 0;

  const delay = async (): Promise<void> => {
    if (latency > 0) await new Promise<void>((r) => setTimeout(r, latency));
  };
  const calendar = (id: string): Map<string, EventRef> => {
    let c = calendars.get(id);
    if (!c) {
      c = new Map();
      calendars.set(id, c);
    }
    return c;
  };

  return {
    get writes() {
      return writes;
    },

    async freeBusy(calendarId, range) {
      await delay();
      const busy: TimeRange[] = [];
      for (const e of calendars.get(calendarId)?.values() ?? []) {
        if (!e.allDay && overlaps(e, range)) busy.push({ start: e.start, end: e.end });
      }
      for (const b of extraBusy.get(calendarId) ?? []) {
        if (overlaps(b, range)) busy.push({ ...b });
      }
      busy.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return { busy };
    },

    async getEvent(calendarId, id) {
      await delay();
      const e = calendars.get(calendarId)?.get(id);
      return e ? copy(e) : null;
    },

    async listEvents(calendarId, range, limit) {
      await delay();
      const hits = [...(calendars.get(calendarId)?.values() ?? [])]
        .filter((e) => overlaps(span(e), range))
        .sort(
          (a, b) =>
            Date.parse(span(a).start) - Date.parse(span(b).start) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      return { events: hits.slice(0, limit).map(copy), truncated: hits.length > limit };
    },

    async createEvent(event: NewCalendarEvent, idempotencyKey: string) {
      await delay();
      const cal = calendar(event.calendarId);
      const existing = cal.get(idempotencyKey);
      if (existing) return copy(existing);
      const created: EventRef = {
        id: idempotencyKey,
        etag: "e1",
        title: event.title,
        start: event.start,
        end: event.end,
        attendees: [...event.attendees],
        allDay: false,
      };
      cal.set(created.id, created);
      writes.push(created);
      if (writeLog !== undefined) {
        seq += 1;
        const line = JSON.stringify({
          seq,
          ts: world.now,
          op: "calendar.createEvent",
          idempotency_key: idempotencyKey,
          request: redactPreview(event),
        });
        appendFileSync(writeLog, `${line}\n`);
      }
      opts.afterWrite?.();
      return copy(created);
    },

    addBusy(calendarId, range) {
      const list = extraBusy.get(calendarId) ?? [];
      list.push({ ...range });
      extraBusy.set(calendarId, list);
    },

    touchEvent(calendarId, id) {
      const e = calendars.get(calendarId)?.get(id);
      if (!e) throw new Error(`touchEvent: unknown event ${calendarId}/${id}`);
      e.etag = `${e.etag}+`;
    },
  };
}
