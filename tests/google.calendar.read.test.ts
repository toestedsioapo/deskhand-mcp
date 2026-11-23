import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { SCOPE_CALENDAR_READ } from "../src/config/scopes.js";
import { ProviderError } from "../src/providers/errors.js";
import { createGoogleCalendarProvider } from "../src/providers/google/calendar.js";
import { googleRequest, type GoogleHttpDeps } from "../src/providers/google/http.js";
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

  it("drops the calendar owner Google adds to attendees (self: true); other attendees stay", async () => {
    const item = {
      id: "evt-1",
      etag: '"1"',
      status: "confirmed",
      summary: "Sync",
      start: { dateTime: "2026-11-12T10:00:00Z" },
      end: { dateTime: "2026-11-12T10:30:00Z" },
      attendees: [
        { email: "owner@example.com", self: true, organizer: true, responseStatus: "accepted" },
        { email: "ana@example.com", self: false },
        { email: "ben@example.com", organizer: true },
      ],
    };
    const r = await createGoogleCalendarProvider(deps(stub({ items: [item] }))).listEvents("primary", RANGE, 5);
    expect(r.events[0]!.attendees).toEqual(["ana@example.com", "ben@example.com"]);
    const g = await createGoogleCalendarProvider(deps(stub(item))).getEvent("primary", "evt-1");
    expect(g!.attendees).toEqual(["ana@example.com", "ben@example.com"]);
    expect(g!.ownerEmail).toBe("owner@example.com");
    expect(g!.organizerSelf).toBeUndefined();
  });

  it("keeps organizer.self and a recurrence marker for the plan match (never shown by the read tools)", async () => {
    const base = {
      id: "evt-1",
      etag: '"1"',
      status: "confirmed",
      start: { dateTime: "2026-11-12T10:00:00Z" },
      end: { dateTime: "2026-11-12T10:30:00Z" },
    };
    const get = (item: object) => createGoogleCalendarProvider(deps(stub(item))).getEvent("primary", "evt-1");
    expect(await get({ ...base, organizer: { email: "me@example.com", self: true } })).toMatchObject({ organizerSelf: true });
    const plain = await get({ ...base, organizer: { email: "x@example.com" } });
    expect(plain).not.toHaveProperty("organizerSelf");
    expect(plain).not.toHaveProperty("recurring");
    expect(plain).not.toHaveProperty("ownerEmail");
    expect(await get({ ...base, recurrence: ["RRULE:FREQ=DAILY"] })).toMatchObject({ recurring: true });
    expect(await get({ ...base, recurringEventId: "abc" })).toMatchObject({ recurring: true });
  });

  it("the list fields mask asks for organizer(self), attendees(email,self), recurrence and recurringEventId", async () => {
    const p = provider(["events-list-page"]);
    await p.listEvents("primary", RANGE, 50);
    expect(new URL(replay!.seen[0]!.url).searchParams.get("fields")).toBe(
      "items(id,etag,status,summary,start,end,attendees(email,self),organizer(self),recurrence,recurringEventId),nextPageToken",
    );
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

describe("calendar request targets (M4b fix wave E)", () => {
  const REFUSED = "refused request to an endpoint outside the allowlist";
  const recording = () => {
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    return { urls, f, p: createGoogleCalendarProvider(deps(f)) };
  };

  it.each([".", "..", "../../gmail/v1/users/me/drafts/send", "a/../b", "..\\..\\gmail"])("calendar id %s is refused with no fetch", async (id) => {
    const { urls, p } = recording();
    const e = await reject(p.listEvents(id, RANGE, 10));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toContain(REFUSED);
    expect(urls).toHaveLength(0);
  });

  it.each([".", ".."])("calendar id %s is refused by every call that takes one", async (id) => {
    const { urls, p } = recording();
    const calls = [
      () => p.getEvent(id, "evt-standup-1"),
      () => p.lookupEvent(id, "evt-standup-1"),
      () => p.freeBusy(id, RANGE),
      () => p.createEvent({ calendarId: id, title: "t", start: RANGE.start, end: RANGE.end, attendees: [], sendUpdates: "none" }, "abcde12345"),
    ];
    for (const call of calls) expect((await reject(call())).message).toContain(REFUSED);
    expect(urls).toHaveLength(0);
  });

  it.each([".", ".."])("event id %s is refused with no fetch", async (id) => {
    const { urls, p } = recording();
    expect((await reject(p.lookupEvent("primary", id))).message).toContain(REFUSED);
    expect(urls).toHaveLength(0);
  });

  it.each([
    "..",
    ".",
    "..%2F..%2Fgmail%2Fv1%2Fusers%2Fme%2Fdrafts%2Fsend",
    "a%2F..%2Fb",
    "..%5C..%5Cgmail",
    "%2E%2E%2f",
    "%2e",
    "a%5c.%5cb",
    "..\\x",
    ".\t.",
    "%ZZ",
  ])("the calendar guard refuses the segment %j, before the token is read", async (seg) => {
    rmSync(join(dir, "token.json"));
    const { urls, f } = recording();
    const e = await reject(
      googleRequest(deps(f), "t", {
        service: "calendar",
        method: "GET",
        url: `https://www.googleapis.com/calendar/v3/calendars/${seg}/events`,
        requiredScope: SCOPE_CALENDAR_READ,
      }),
    );
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toContain(REFUSED);
    expect(urls).toHaveLength(0);
  });

  it.each([" ", "\u0001", "\u001f ", "\u0000"])("a final .. followed by %j is refused, as URL parsing strips it", async (tail) => {
    rmSync(join(dir, "token.json"));
    const { urls, f } = recording();
    const e = await reject(
      googleRequest(deps(f), "t", {
        service: "calendar",
        method: "GET",
        url: `https://www.googleapis.com/calendar/v3/calendars/..${tail}`,
        requiredScope: SCOPE_CALENDAR_READ,
      }),
    );
    expect(e.message).toContain(REFUSED);
    expect(urls).toHaveLength(0);
  });

  it("leading controls and spaces do not hide a dot segment or refuse a good URL", async () => {
    const { urls, f } = recording();
    const request = (url: string) => googleRequest(deps(f), "t", { service: "calendar", method: "GET", url, requiredScope: SCOPE_CALENDAR_READ });
    expect((await reject(request(" \u0001https://www.googleapis.com/calendar/v3/calendars/../x"))).message).toContain(REFUSED);
    expect(urls).toHaveLength(0);
    await request(" \u0001https://www.googleapis.com/calendar/v3/calendars/primary/events \u0001");
    expect(urls).toHaveLength(1);
  });

  it.each(["team%2Froom%40x", "a%5Cb", "user%40example.com", "...%23...", "v1..2", "a.b", "...", "%252E%252E"])(
    "the calendar guard allows the segment %s",
    async (seg) => {
      const { urls, f } = recording();
      await googleRequest(deps(f), "t", {
        service: "calendar",
        method: "GET",
        url: `https://www.googleapis.com/calendar/v3/calendars/${seg}/events`,
        requiredScope: SCOPE_CALENDAR_READ,
      });
      expect(urls).toHaveLength(1);
    },
  );

  it.each([
    ["primary", "primary"],
    ["en.usa#holiday@group.v.calendar.google.com", "en.usa%23holiday%40group.v.calendar.google.com"],
    ["a.b@example.com", "a.b%40example.com"],
    ["...", "..."],
    ["team/room@x", "team%2Froom%40x"],
    ["a\\b", "a%5Cb"],
    ["v1..2", "v1..2"],
  ])("real id %s keeps working", async (id, encoded) => {
    const { urls, p } = recording();
    await p.listEvents(id, RANGE, 10);
    expect(new URL(urls[0]!).pathname).toBe(`/calendar/v3/calendars/${encoded}/events`);
  });

  it("a dot segment in a query value is not a path", async () => {
    const { urls, f } = recording();
    await googleRequest(deps(f), "t", {
      service: "calendar",
      method: "GET",
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events?q=..%2F..%2Fb",
      requiredScope: SCOPE_CALENDAR_READ,
    });
    expect(urls).toHaveLength(1);
  });
});
