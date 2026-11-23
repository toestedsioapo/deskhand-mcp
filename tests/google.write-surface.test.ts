import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE } from "../src/config/scopes.js";
import { createGoogleCalendarProvider } from "../src/providers/google/calendar.js";
import { GOOGLE_ENDPOINTS } from "../src/providers/google/oauth.js";
import { writeToken } from "../src/providers/google/token-store.js";
import type { CalendarProvider } from "../src/providers/types.js";

/**
 * Behavioural guard for the only write (complements the text guards in safety.structure.test.ts, which an alias
 * import or a spread request object can get past). Every read method of the real Google provider is driven against
 * a recording fake fetch that answers every request with a minimal valid response, so a hidden extra request is
 * recorded instead of failing early.
 */
const NOW = new Date("2026-11-14T10:00:00.000Z");
const KEY = "088afa7571116bd6a8f7b781318e85bd9a37eed81b5140bfe630e9f752558fa8";
const RANGE = { start: "2026-11-12T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskhand-surface-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

const event = (id: string) => ({
  id,
  etag: '"1"',
  status: "confirmed",
  summary: "Sync",
  organizer: { self: true },
  start: { dateTime: "2026-11-12T10:00:00Z" },
  end: { dateTime: "2026-11-12T10:30:00Z" },
  attendees: [{ email: "a@example.com" }],
});

/** Answers anything with a minimal valid body and records method + URL. */
function recordingProvider(): { provider: CalendarProvider; seen: { method: string; url: URL }[] } {
  const seen: { method: string; url: URL }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // A Request carries its own method; init wins when both are given, as in fetch.
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    seen.push({ method, url });
    let body: unknown = {};
    if (url.pathname.endsWith("/freeBusy")) body = { calendars: { primary: { busy: [] } } };
    else if (method === "GET" && url.pathname.endsWith("/events")) body = { items: [event("evt1")] };
    else if (url.pathname.includes("/events/")) body = event(decodeURIComponent(url.pathname.split("/").at(-1)!));
    else if (method === "POST" && url.pathname.endsWith("/events")) body = event(KEY);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const provider = createGoogleCalendarProvider({
    fetch: f,
    configDir: dir,
    now: () => NOW,
    oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW },
  });
  return { provider, seen };
}

const isInsert = (r: { method: string; url: URL }) => r.method === "POST" && /\/events\/?$/.test(r.url.pathname);

describe("Google write surface (behavioural)", () => {
  // Both tokens: with a read-only token a write-scope request throws before fetch, so a read that tried one and
  // swallowed the error would send nothing; with an upgraded token (the normal state at action_apply) it would send.
  for (const [label, scopes] of [
    ["a read-only token", [SCOPE_CALENDAR_READ]],
    ["a read and write token", [SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE]],
  ] as const) {
    it(`every read method, with ${label}: no POST but POST /freeBusy, never POST /events`, async () => {
      login([...scopes]);
      const { provider, seen } = recordingProvider();
      await provider.listEvents("primary", RANGE, 10);
      await provider.freeBusy("primary", RANGE);
      await provider.getEvent("primary", "evt1");
      await provider.lookupEvent("primary", KEY);
      expect(seen.length).toBeGreaterThanOrEqual(4);
      const posts = seen.filter((r) => r.method !== "GET");
      expect(posts.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["POST /calendar/v3/freeBusy"]);
      expect(seen.filter(isInsert)).toEqual([]);
      expect(seen.every((r) => r.url.hostname === "www.googleapis.com")).toBe(true);
    });
  }

  it("createEvent sends exactly one POST /events and nothing else", async () => {
    login([SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE]);
    const { provider, seen } = recordingProvider();
    await provider.createEvent(
      {
        title: "Sync",
        start: "2026-11-12T10:00:00.000Z",
        end: "2026-11-12T10:30:00.000Z",
        attendees: ["a@example.com"],
        sendUpdates: "none",
        calendarId: "primary",
      },
      KEY,
    );
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["POST /calendar/v3/calendars/primary/events"]);
  });
});

describe("Gmail write surface", () => {
  const source = (name: string) => readFileSync(fileURLToPath(new URL(`../src/providers/google/${name}`, import.meta.url)), "utf8");

  for (const name of ["gmail.ts", "mime.ts"]) {
    it(`${name} holds no send path string`, () => {
      const text = source(name);
      expect(text).not.toMatch(/\/send\b/i);
      expect(text).not.toMatch(/["'`]send["'`]/i);
    });
  }

  it("gmail.ts builds its one POST inside createDraft, with the compose scope and singleSend", () => {
    const text = source("gmail.ts");
    expect(text.match(/["'`]POST["'`]/g)).toHaveLength(1);
    const start = text.indexOf("async createDraft(");
    expect(start).toBeGreaterThan(0);
    const body = text.slice(start, text.indexOf("\n    },\n", start));
    expect(body).toMatch(/method: "POST",\s*url: `\$\{BASE\}\/drafts`/);
    expect(body).toMatch(/requiredScope: SCOPE_GMAIL_COMPOSE/);
    expect(body).toMatch(/singleSend: true/);
  });
});
