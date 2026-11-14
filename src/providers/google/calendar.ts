import { SCOPE_CALENDAR_READ } from "../../config/scopes.js";
import { ProviderError } from "../errors.js";
import type { CalendarProvider, EventRef, TimeRange } from "../types.js";
import { googleRequest, type GoogleHttpDeps, type GoogleResponse } from "./http.js";

const PROVIDER = "google calendar";
const BASE = "https://www.googleapis.com/calendar/v3";
const LIST_FIELDS = "items(id,etag,status,summary,start,end,attendees/email),nextPageToken";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** A real calendar date: rejects 2026-13-45 and 2026-02-30. */
function validDate(s: string): boolean {
  if (!DATE_ONLY.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
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
  const attendees = Array.isArray(item.attendees)
    ? item.attendees.flatMap((a) => (isObj(a) && typeof a.email === "string" ? [a.email] : []))
    : [];
  return {
    id: item.id,
    etag: item.etag,
    title: typeof item.summary === "string" ? item.summary : "",
    ...mapTimes(op, item.start, item.end),
    attendees,
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
  const read = (op: string, method: "GET" | "POST", url: string, reqBody?: unknown) =>
    googleRequest(deps, op, { method, url, body: reqBody, requiredScope: SCOPE_CALENDAR_READ });

  return {
    async freeBusy(calendarId: string, range: TimeRange) {
      const op = "freebusy";
      const res = await read(op, "POST", `${BASE}/freeBusy`, {
        timeMin: range.start,
        timeMax: range.end,
        items: [{ id: calendarId }],
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
      const op = "events.get";
      const res = await read(op, "GET", `${cal(calendarId)}/events/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      return mapEvent(op, body(op, res));
    },

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
      const res = await read(op, "GET", `${cal(calendarId)}/events?${params.toString()}`);
      const json = body(op, res);
      const items = Array.isArray(json.items) ? json.items : [];
      const events = items.flatMap((item: unknown) => {
        const e = mapEvent(op, item);
        return e === null ? [] : [e];
      });
      events.sort((a, b) => startInstant(a) - startInstant(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { events, truncated: typeof json.nextPageToken === "string" && json.nextPageToken !== "" };
    },

    // Replaced in Task 6.
    createEvent() {
      return Promise.reject(new ProviderError(PROVIDER, "events.insert", { phrase: "not implemented" }));
    },
  };
}
