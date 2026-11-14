import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { SCOPE_CALENDAR_READ } from "../src/config/scopes.js";
import { ProviderError } from "../src/providers/errors.js";
import { createGoogleCalendarProvider } from "../src/providers/google/calendar.js";
import type { GoogleHttpDeps } from "../src/providers/google/http.js";
import { GOOGLE_ENDPOINTS } from "../src/providers/google/oauth.js";
import { writeToken } from "../src/providers/google/token-store.js";
import { calendarListEventsHandler } from "../src/tools/calendar-list-events.js";
import { replayFetch, type Replay } from "./helpers/replay-fetch.js";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const RANGE = { start: "2026-11-12T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" };

let dir: string;
let replay: Replay | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskhand-cal-"));
  writeToken(dir, {
    version: 1,
    client_id: "cid.apps.googleusercontent.com",
    scopes: [SCOPE_CALENDAR_READ],
    refresh_token: "1//REFRESH-SECRET",
    access_token: "ya29.OLD-ACCESS-TOKEN",
    expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    obtained_at: "2026-11-10T10:00:00.000Z",
  });
});
afterEach(() => {
  try {
    replay?.verify();
  } finally {
    replay = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});

function deps(f: typeof fetch): GoogleHttpDeps {
  return { fetch: f, configDir: dir, now: () => NOW, oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW } };
}
function provider(names: string[]) {
  replay = replayFetch(names);
  return createGoogleCalendarProvider(deps(replay.fetch));
}
const stub = (body: unknown, status = 200): typeof fetch =>
  (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;
const reject = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};

describe("listEvents", () => {
  it("maps timed events to UTC instants with milliseconds and all-day events to dates; drops cancelled", async () => {
    const r = await provider(["events-list-page"]).listEvents("primary", RANGE, 50);
    expect(r.truncated).toBe(false);
    expect(r.events).toEqual([
      { id: "evt-holiday-3", etag: '"3100000000000003"', title: "Company holiday", start: "2026-11-12", end: "2026-11-13", attendees: [], allDay: true },
      {
        id: "evt-standup-1",
        etag: '"3100000000000001"',
        title: "Team standup",
        start: "2026-11-12T08:00:00.000Z",
        end: "2026-11-12T08:30:00.000Z",
        attendees: ["ana@example.com", "ben@example.com"],
        allDay: false,
      },
      {
        id: "evt-offsite-2",
        etag: '"3100000000000002"',
        title: "Offsite planning",
        start: "2026-11-12T14:00:00.000Z",
        end: "2026-11-12T15:15:00.000Z",
        attendees: [],
        allDay: false,
      },
    ]);
  });

  it("truncated is true when nextPageToken is present", async () => {
    const r = await provider(["events-list-truncated"]).listEvents("primary", RANGE, 2);
    expect(r.truncated).toBe(true);
    expect(r.events).toHaveLength(2);
  });

  it("the request asks for the documented parameters", async () => {
    const p = provider(["events-list-page"]);
    await p.listEvents("primary", RANGE, 50);
    const u = new URL(replay!.seen[0]!.url);
    expect(u.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(u.searchParams.get("singleEvents")).toBe("true");
    expect(u.searchParams.get("orderBy")).toBe("startTime");
    expect(u.searchParams.get("maxResults")).toBe("50");
    expect(u.searchParams.get("timeMin")).toBe(RANGE.start);
  });

  it("percent-encodes the calendar id in the path", async () => {
    let seen = "";
    const f = ((u: string) => {
      seen = u;
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    }) as unknown as typeof fetch;
    await createGoogleCalendarProvider(deps(f)).listEvents("team/room@x", RANGE, 5);
    expect(new URL(seen).pathname).toBe("/calendar/v3/calendars/team%2Froom%40x/events");
  });

  it("an item with neither dateTime nor date, or mixing the two, is ProviderError 'unreadable event time'", async () => {
    const bad = [
      { id: "a", etag: "e", start: {}, end: {} },
      { id: "b", etag: "e", start: { date: "2026-11-12" }, end: { dateTime: "2026-11-12T10:00:00Z" } },
      { id: "c", etag: "e", start: { dateTime: "not a time" }, end: { dateTime: "2026-11-12T10:00:00Z" } },
    ];
    for (const item of bad) {
      const e = await reject(createGoogleCalendarProvider(deps(stub({ items: [item] }))).listEvents("primary", RANGE, 5));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).toBe("google calendar events.list failed: unreadable event time");
    }
  });

  it("an offset-less dateTime, or a non-existent all-day date, is unreadable", async () => {
    const bad = [
      { id: "a", etag: "e", start: { dateTime: "2026-11-12T10:00:00" }, end: { dateTime: "2026-11-12T11:00:00Z" } },
      { id: "b", etag: "e", start: { dateTime: "2026-11-12" }, end: { dateTime: "2026-11-12T11:00:00Z" } },
      { id: "c", etag: "e", start: { date: "2026-13-45" }, end: { date: "2026-13-46" } },
      { id: "d", etag: "e", start: { date: "2026-02-30" }, end: { date: "2026-03-01" } },
    ];
    for (const item of bad) {
      const e = await reject(createGoogleCalendarProvider(deps(stub({ items: [item] }))).listEvents("primary", RANGE, 5));
      expect(e.message).toBe("google calendar events.list failed: unreadable event time");
    }
  });

  it("a missing summary is the empty string", async () => {
    const f = stub({
      items: [{ id: "a", etag: "e", start: { dateTime: "2026-11-12T10:00:00Z" }, end: { dateTime: "2026-11-12T11:00:00Z" } }],
    });
    const r = await createGoogleCalendarProvider(deps(f)).listEvents("primary", RANGE, 5);
    expect(r.events[0]!.title).toBe("");
  });

  it("a non-2xx answer is a ProviderError", async () => {
    const e = await reject(createGoogleCalendarProvider(deps(stub({ error: {} }, 404))).listEvents("nope", RANGE, 5));
    expect(e.message).toBe("google calendar events.list failed: HTTP 404");
  });

  it("through calendar_list_events the all-day item is all_day true with the same dates", async () => {
    const ctx = { provider: provider(["events-list-page"]) } as unknown as AppContext;
    const out = await calendarListEventsHandler(ctx, {
      calendar_id: "primary",
      time_min: RANGE.start,
      time_max: RANGE.end,
      limit: 50,
    });
    if ("isError" in out) throw new Error("tool failed");
    const holiday = out.structuredContent.events.find((e) => e.id === "evt-holiday-3")!;
    expect(holiday.all_day).toBe(true);
    expect(holiday.start).toBe("2026-11-12");
    expect(holiday.end).toBe("2026-11-13");
    expect(out.structuredContent.events.find((e) => e.id === "evt-standup-1")!.all_day).toBe(false);
  });
});

describe("freeBusy", () => {
  it("returns the busy blocks sorted and posts the documented body", async () => {
    const p = provider(["freebusy"]);
    const r = await p.freeBusy("primary", RANGE);
    expect(r.busy).toEqual([
      { start: "2026-11-12T08:00:00.000Z", end: "2026-11-12T08:30:00.000Z" },
      { start: "2026-11-12T15:00:00.000Z", end: "2026-11-12T16:00:00.000Z" },
    ]);
    expect(JSON.parse(replay!.seen[0]!.body!)).toEqual({ timeMin: RANGE.start, timeMax: RANGE.end, items: [{ id: "primary" }] });
  });

  it("a calendar error is ProviderError with its validated reason", async () => {
    const e = await reject(provider(["freebusy-notfound"]).freeBusy("primary", RANGE));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar freebusy failed: calendar error notFound");
  });
});

describe("getEvent", () => {
  it("maps a found event", async () => {
    const e = await provider(["events-get"]).getEvent("primary", "evt-standup-1");
    expect(e).toMatchObject({
      id: "evt-standup-1",
      allDay: false,
      start: "2026-11-12T08:00:00.000Z",
      attendees: ["ana@example.com", "ben@example.com"],
    });
  });
  it("404 is null", async () => {
    expect(await provider(["events-get-404"]).getEvent("primary", "evt-missing")).toBeNull();
  });
  it("a cancelled event is null", async () => {
    expect(await provider(["events-get-cancelled"]).getEvent("primary", "evt-gone-4")).toBeNull();
  });
});

describe("lookupEvent", () => {
  it("404 is absent", async () => {
    expect(await provider(["events-get-404"]).lookupEvent("primary", "evt-missing")).toEqual({ state: "absent" });
  });
  it("a cancelled event is cancelled, not absent", async () => {
    expect(await provider(["events-get-cancelled"]).lookupEvent("primary", "evt-gone-4")).toEqual({ state: "cancelled" });
  });
  it("a live event is present and mapped as getEvent maps it", async () => {
    const r = await provider(["events-get"]).lookupEvent("primary", "evt-standup-1");
    expect(r).toMatchObject({ state: "present", event: { id: "evt-standup-1", start: "2026-11-12T08:00:00.000Z" } });
  });
});
