import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE } from "../../config/scopes.js";
import { EVENT_DELETED, ProviderError } from "../errors.js";
import type { CalendarProvider, EventLookup, EventRef, NewCalendarEvent, TimeRange } from "../types.js";
import { googleRequest, type GoogleHttpDeps, type GoogleResponse } from "./http.js";

const PROVIDER = "google calendar";
const BASE = "https://www.googleapis.com/calendar/v3";
// The plan-match fields are requested too (see mapEvent): attendee `self`, `organizer.self`, and the recurrence markers.
const LIST_FIELDS =
  "items(id,etag,status,summary,start,end,attendees(email,self),organizer(self),recurrence,recurringEventId),nextPageToken";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** A real calendar date: rejects 2026-13-45 and 2026-02-30. */
function validDate(s: string): boolean {
  if (!DATE_ONLY.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
/** Google event ids: base32hex characters, 5 to 1024 of them. */
const EVENT_ID = /^[a-v0-9]{5,1024}$/;
const REASON = /^[A-Za-z]{1,40}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

const unreadable = (op: string, phrase: string): ProviderError => new ProviderError(PROVIDER, op, { phrase });

/** Timed: `dateTime` to a UTC instant with milliseconds. All-day: `date` passed through (Google's end is already exclusive). */
function mapTimes(op: string, start: unknown, end: unknown): Pick<EventRef, "start" | "end" | "allDay"> {
  if (!isObj(start) || !isObj(end)) throw unreadable(op, "unreadable event time");
  const timed = start.dateTime !== undefined || end.dateTime !== undefined;
  const dated = start.date !== undefined || end.date !== undefined;
  if (timed === dated) throw unreadable(op, "unreadable event time");
  if (dated) {
    const { date: s } = start;
    const { date: e } = end;
    if (typeof s !== "string" || typeof e !== "string" || !validDate(s) || !validDate(e)) {
      throw unreadable(op, "unreadable event time");
    }
    return { start: s, end: e, allDay: true };
  }
  const s = typeof start.dateTime === "string" && RFC3339.test(start.dateTime) ? Date.parse(start.dateTime) : NaN;
  const e = typeof end.dateTime === "string" && RFC3339.test(end.dateTime) ? Date.parse(end.dateTime) : NaN;
  if (Number.isNaN(s) || Number.isNaN(e)) throw unreadable(op, "unreadable event time");
  return { start: new Date(s).toISOString(), end: new Date(e).toISOString(), allDay: false };
}

/** null for a cancelled item. */
function mapEvent(op: string, item: unknown): EventRef | null {
  if (!isObj(item)) throw unreadable(op, "unreadable event");
  if (item.status === "cancelled") return null;
  if (typeof item.id !== "string" || typeof item.etag !== "string") throw unreadable(op, "unreadable event");
  // Google lists the calendar owner among the attendees (`self: true`) of an event that has attendees, on insert,
  // get and list. The owner is kept apart as `ownerEmail` (the plan match decides whether the plan invited them)
  // and left out of `attendees`, which the read tools show.
  const list = Array.isArray(item.attendees) ? item.attendees.filter(isObj) : [];
  const attendees = list.flatMap((a) => (typeof a.email === "string" && a.self !== true ? [a.email] : []));
  const owner = list.find((a) => a.self === true && typeof a.email === "string")?.email;
  const recurring =
    (Array.isArray(item.recurrence) && item.recurrence.length > 0) ||
    (typeof item.recurringEventId === "string" && item.recurringEventId !== "");
  return {
    id: item.id,
    etag: item.etag,
    title: typeof item.summary === "string" ? item.summary : "",
    ...mapTimes(op, item.start, item.end),
    attendees,
    ...(typeof owner === "string" ? { ownerEmail: owner } : {}),
    ...(isObj(item.organizer) && item.organizer.self === true ? { organizerSelf: true } : {}),
    ...(recurring ? { recurring: true } : {}),
  };
}

/** An all-day event spans UTC midnight to UTC midnight for ordering, as in the fixture provider. */
const startInstant = (e: EventRef): number => Date.parse(e.allDay ? `${e.start}T00:00:00.000Z` : e.start);

function body(op: string, res: GoogleResponse): Obj {
  if (res.status < 200 || res.status >= 300) throw new ProviderError(PROVIDER, op, { status: res.status });
  if (!isObj(res.json)) throw unreadable(op, "unreadable response");
  return res.json;
}

const instant = (op: string, v: unknown): string => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw unreadable(op, "unreadable response");
  return new Date(t).toISOString();
};

export function createGoogleCalendarProvider(deps: GoogleHttpDeps): CalendarProvider {
  const cal = (id: string): string => `${BASE}/calendars/${encodeURIComponent(id)}`;
  /** A read: GET only, under the read scope. The two POSTs (freeBusy, insert) are spelled out where they are sent. */
  const get = (op: string, url: string) => googleRequest(deps, op, { method: "GET", url, requiredScope: SCOPE_CALENDAR_READ });

  /** One event by id: 404 is absent, `status: cancelled` is cancelled (a deleted event), anything else is mapped. */
  const lookup = async (op: string, calendarId: string, id: string): Promise<EventLookup> => {
    const res = await get(op, `${cal(calendarId)}/events/${encodeURIComponent(id)}`);
    if (res.status === 404) return { state: "absent" };
    const event = mapEvent(op, body(op, res));
    return event === null ? { state: "cancelled" } : { state: "present", event };
  };

  return {
    async freeBusy(calendarId: string, range: TimeRange) {
      const op = "freebusy";
      // A query, not a write: POST is how the API takes it, under the read scope.
      const res = await googleRequest(deps, op, {
        method: "POST",
        url: `${BASE}/freeBusy`,
        body: { timeMin: range.start, timeMax: range.end, items: [{ id: calendarId }] },
        requiredScope: SCOPE_CALENDAR_READ,
      });
      const calendars = body(op, res).calendars;
      const entry = isObj(calendars) ? calendars[calendarId] : undefined;
      if (!isObj(entry)) throw unreadable(op, "unreadable response");
      if (Array.isArray(entry.errors) && entry.errors.length > 0) {
        const reason = isObj(entry.errors[0]) ? entry.errors[0].reason : undefined;
        const valid = typeof reason === "string" && REASON.test(reason) ? reason : "unknown";
        throw unreadable(op, `calendar error ${valid}`);
      }
      const busy = (Array.isArray(entry.busy) ? entry.busy : []).map((b: unknown) => {
        if (!isObj(b)) throw unreadable(op, "unreadable response");
        return { start: instant(op, b.start), end: instant(op, b.end) };
      });
      busy.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return { busy };
    },

    async getEvent(calendarId: string, id: string) {
      const found = await lookup("events.get", calendarId, id);
      return found.state === "present" ? found.event : null;
    },

    lookupEvent: (calendarId: string, id: string) => lookup("events.get", calendarId, id),

    async listEvents(calendarId: string, range: TimeRange, limit: number) {
      const op = "events.list";
      const params = new URLSearchParams({
        timeMin: range.start,
        timeMax: range.end,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(limit),
        fields: LIST_FIELDS,
      });
      const res = await get(op, `${cal(calendarId)}/events?${params.toString()}`);
      const json = body(op, res);
      const items = Array.isArray(json.items) ? json.items : [];
      const events = items.flatMap((item: unknown) => {
        const e = mapEvent(op, item);
        return e === null ? [] : [e];
      });
      events.sort((a, b) => startInstant(a) - startInstant(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { events, truncated: typeof json.nextPageToken === "string" && json.nextPageToken !== "" };
    },

    async createEvent(event: NewCalendarEvent, idempotencyKey: string) {
      const op = "events.insert";
      if (!EVENT_ID.test(idempotencyKey)) throw unreadable(op, "invalid event id");
      const url = `${cal(event.calendarId)}/events?${new URLSearchParams({ sendUpdates: event.sendUpdates }).toString()}`;
      // No spread inside the request's arguments (a structural guard forbids it): build the times here.
      const at = (dateTime: string) => (event.timeZone === undefined ? { dateTime } : { dateTime, timeZone: event.timeZone });
      const res = await googleRequest(deps, op, {
        method: "POST",
        url,
        body: {
          id: idempotencyKey,
          summary: event.title,
          start: at(event.start),
          end: at(event.end),
          attendees: event.attendees.map((email) => ({ email })),
        },
        requiredScope: SCOPE_CALENDAR_WRITE,
      });
      if (res.status >= 200 && res.status < 300) {
        // A 2xx means Google created the event; a body we cannot read does not undo that. Retryable: the follow-up
        // lookup (or the retry's recovery) decides.
        let created: EventRef | null = null;
        try {
          created = mapEvent(op, res.json);
        } catch {
          created = null;
        }
        if (created === null) throw new ProviderError(PROVIDER, op, { phrase: "unreadable response", retryable: true });
        // Recovery and every later lookup use our id: an event stored under another id could never be found again.
        if (created.id !== idempotencyKey) throw unreadable(op, "Google returned a different event id");
        return created;
      }
      if (res.status !== 409) throw new ProviderError(PROVIDER, op, { status: res.status });
      // 409: the id exists, so an earlier attempt created it. Never insert again, never use a new id.
      // The event is returned as stored; the apply engine checks that it is the approved one.
      const getOp = "events.get";
      const existing = await lookup(getOp, event.calendarId, idempotencyKey);
      if (existing.state === "absent") throw unreadable(getOp, "id conflict but the event is not readable");
      if (existing.state === "cancelled") throw unreadable(getOp, EVENT_DELETED);
      return existing.event;
    },
  };
}
