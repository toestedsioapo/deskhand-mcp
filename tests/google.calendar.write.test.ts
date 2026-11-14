import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE } from "../src/config/scopes.js";
import { AuthRequiredError, ProviderError } from "../src/providers/errors.js";
import { createGoogleCalendarProvider } from "../src/providers/google/calendar.js";
import type { GoogleHttpDeps } from "../src/providers/google/http.js";
import { GOOGLE_ENDPOINTS } from "../src/providers/google/oauth.js";
import { writeToken } from "../src/providers/google/token-store.js";
import type { NewCalendarEvent } from "../src/providers/types.js";
import { replayFetch, type Replay } from "./helpers/replay-fetch.js";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const KEY = "088afa7571116bd6a8f7b781318e85bd9a37eed81b5140bfe630e9f752558fa8";
const EVENT: NewCalendarEvent = {
  calendarId: "primary",
  title: "Sync",
  start: "2026-11-12T10:00:00.000Z",
  end: "2026-11-12T10:30:00.000Z",
  timeZone: "UTC",
  attendees: ["a@example.com", "b@example.com"],
  sendUpdates: "none",
};

let dir: string;
let replay: Replay | undefined;
function login(scopes: string[]): void {
  writeToken(dir, {
    version: 1,
    client_id: "cid.apps.googleusercontent.com",
    scopes,
    refresh_token: "1//REFRESH-SECRET",
    access_token: "ya29.OLD-ACCESS-TOKEN",
    expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    obtained_at: "2026-11-10T10:00:00.000Z",
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskhand-calw-"));
  login([SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE]);
});
afterEach(() => {
  try {
    replay?.verify();
  } finally {
    replay = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});

function provider(names: string[]) {
  replay = replayFetch(names);
  const f = replay.fetch;
  const deps: GoogleHttpDeps = { fetch: f, configDir: dir, now: () => NOW, oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW } };
  return createGoogleCalendarProvider(deps);
}
const reject = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};

const CREATED = {
  id: KEY,
  etag: '"3100000000000010"',
  title: "Sync",
  start: "2026-11-12T10:00:00.000Z",
  end: "2026-11-12T10:30:00.000Z",
  attendees: ["a@example.com", "b@example.com"],
  allDay: false,
};

describe("createEvent", () => {
  it("POSTs the exact body and query (sendUpdates=none) and maps the 200 response", async () => {
    const p = provider(["events-insert-200"]);
    expect(await p.createEvent(EVENT, KEY)).toEqual(CREATED);
    expect(replay!.seen).toHaveLength(1);
    const req = replay!.seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none");
    expect(JSON.parse(req.body!)).toEqual({
      id: KEY,
      summary: "Sync",
      start: { dateTime: "2026-11-12T10:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-11-12T10:30:00.000Z", timeZone: "UTC" },
      attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
    });
  });

  it("sends sendUpdates=all when planned, and omits timeZone when the plan has none", async () => {
    const p = provider(["events-insert-200-all"]);
    const { timeZone: _tz, ...noZone } = EVENT;
    await p.createEvent({ ...noZone, sendUpdates: "all" }, KEY);
    expect(replay!.seen[0]!.url).toContain("sendUpdates=all");
    const sent = JSON.parse(replay!.seen[0]!.body!) as { start: object; end: object };
    expect(sent.start).toEqual({ dateTime: "2026-11-12T10:00:00.000Z" });
    expect(sent.end).toEqual({ dateTime: "2026-11-12T10:30:00.000Z" });
  });

  it("409 then a found, live event returns it: exactly two requests, no second insert", async () => {
    const p = provider(["events-insert-409", "events-get-key-200"]);
    expect(await p.createEvent(EVENT, KEY)).toEqual(CREATED);
    expect(replay!.seen.map((r) => r.method)).toEqual(["POST", "GET"]);
    expect(replay!.seen[1]!.url).toBe(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${KEY}`);
  });

  it("409 then a cancelled event is a ProviderError naming the deleted event", async () => {
    const p = provider(["events-insert-409", "events-get-key-cancelled"]);
    const e = await reject(p.createEvent(EVENT, KEY));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toContain("an event with this action's id was created and later deleted");
    expect(replay!.seen).toHaveLength(2);
  });

  it("409 then 404 is a ProviderError saying the conflict is not readable", async () => {
    const p = provider(["events-insert-409", "events-get-key-404"]);
    const e = await reject(p.createEvent(EVENT, KEY));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toContain("id conflict but the event is not readable");
  });

  it("a read-only token throws the upgrade AuthRequiredError and makes zero requests", async () => {
    login([SCOPE_CALENDAR_READ]);
    const p = provider([]);
    const e = await reject(p.createEvent(EVENT, KEY));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe("Google write access is not granted. Run: deskhand auth upgrade");
    expect(replay!.seen).toHaveLength(0);
  });

  it("an insufficientPermissions 403 on the insert gives the upgrade sentence", async () => {
    const p = provider(["events-insert-403-insufficient"]);
    const e = await reject(p.createEvent(EVENT, KEY));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toContain("deskhand auth upgrade");
  });

  it("a 500 is a ProviderError that carries the status but nothing from the body", async () => {
    const p = provider(["events-insert-500"]);
    const e = await reject(p.createEvent(EVENT, KEY));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toContain("500");
    expect(e.message).not.toContain("FAKE-TOKEN");
  });

  for (const bad of ["ABC123", "abcd", "abc-def", "w".repeat(10), "a".repeat(1025), ""]) {
    it(`rejects the key of ${bad.length} chars starting ${JSON.stringify(bad.slice(0, 6))} as an invalid event id with zero requests`, async () => {
      const p = provider([]);
      const e = await reject(p.createEvent(EVENT, bad));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).toContain("invalid event id");
      expect(replay!.seen).toHaveLength(0);
    });
  }

  it("no recording and no request URL contains /send", async () => {
    const dirPath = new URL("./recorded/google/", import.meta.url);
    for (const f of readdirSync(dirPath)) {
      const j = JSON.parse(readFileSync(new URL(f, dirPath), "utf8")) as { request: { url: string } };
      expect(j.request.url, f).not.toContain("/send");
    }
    const p = provider(["events-insert-200"]);
    await p.createEvent(EVENT, KEY);
    expect(replay!.seen.every((r) => !r.url.includes("/send"))).toBe(true);
  });
});
