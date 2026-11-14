import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { applyAction, idempotencyKey } from "../src/approval/apply.js";
import { createPlan } from "../src/approval/plans.js";
import { loadConfig } from "../src/config/env.js";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE } from "../src/config/scopes.js";
import { getAction } from "../src/ledger/actions.js";
import { queryEvents } from "../src/ledger/events.js";
import { LedgerDb } from "../src/ledger/db.js";
import { createGoogleCalendarProvider } from "../src/providers/google/calendar.js";
import { GOOGLE_ENDPOINTS } from "../src/providers/google/oauth.js";
import { writeToken } from "../src/providers/google/token-store.js";
import { makeTempHome } from "./helpers/home.js";
import { replayFetch, type Replay } from "./helpers/replay-fetch.js";
import { validPlan } from "./helpers/seed.js";

const NOW = new Date("2026-11-10T09:00:00.000Z");
const ACTION_ID = "act_01JC3Z8K4V7Q2W9X5R6T1N0BHM";
const KEY = "088afa7571116bd6a8f7b781318e85bd9a37eed81b5140bfe630e9f752558fa8";

let home: ReturnType<typeof makeTempHome>;
let db: LedgerDb;
let replay: Replay | undefined;

function login(scopes: string[]): void {
  writeToken(home.home, {
    version: 1,
    client_id: "cid.apps.googleusercontent.com",
    scopes,
    refresh_token: "1//REFRESH-SECRET",
    access_token: "ya29.OLD-ACCESS-TOKEN",
    expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    obtained_at: "2026-11-09T10:00:00.000Z",
  });
}

beforeEach(() => {
  home = makeTempHome();
  db = LedgerDb.open(join(home.home, "ledger.db"));
  login([SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE]);
});
afterEach(() => {
  try {
    replay?.verify();
  } finally {
    replay = undefined;
    db.close();
    home.cleanup();
  }
});

/**
 * A real ledger and apply engine over the Google provider, served by recordings. `intercept` may answer a request
 * itself (return a promise) before the recordings see it; it returns undefined to pass the request on.
 */
function setup(
  names: string[],
  intercept?: (method: string, url: URL) => Promise<Response> | undefined,
): { ctx: AppContext; id: string } {
  replay = replayFetch(names);
  const served = replay.fetch;
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return intercept?.((init?.method ?? "GET").toUpperCase(), new URL(raw)) ?? served(input, init);
  }) as typeof fetch;
  const provider = createGoogleCalendarProvider({
    fetch: f,
    configDir: home.home,
    now: () => NOW,
    oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW },
  });
  const ctx: AppContext = {
    config: loadConfig({ ...home.env, DESKHAND_ALLOW_WRITES: "1" }),
    db,
    clock: () => NOW,
    ids: { newActionId: () => ACTION_ID },
    provider,
    actor: "tester",
  };
  const plan = validPlan(
    { observed: { slotFree: true, etags: {} } },
    { attendees: ["a@example.com", "b@example.com"], sendUpdates: "none", timeZone: "UTC" },
  );
  const { actionId, planHash } = createPlan(ctx, { tool: "calendar_propose_event", input: {}, plan });
  db.run(
    `UPDATE actions SET status = 'approved', approved_by = 'tester', approved_at = ?, approval_method = 'cli_tty',
       approved_plan_hash = ? WHERE id = ?`,
    [NOW.toISOString(), planHash, actionId],
  );
  return { ctx, id: actionId };
}

const DIFFERS = "an event with this action's id exists but differs from the approved plan";
const DELETED = "an event with this action's id was created and later deleted";
const rowsOf = (id: string) => queryEvents(db, { limit: 100, actionId: id }).reverse();
const dump = (): string => JSON.stringify([db.all("SELECT * FROM actions"), db.all("SELECT * FROM events")]);
const inserts = () => replay!.seen.filter((r) => r.method === "POST" && r.url.includes("/events"));

describe("apply with the Google provider", () => {
  it("uses the sha256 of the action id as the event id", () => {
    expect(idempotencyKey(ACTION_ID)).toBe(KEY);
  });

  it("a normal apply: lookup 404, free/busy empty, insert 200 -> applied", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-200"]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: true, replayed: false, result: { id: KEY } });
    expect(getAction(db, id)!.status).toBe("applied");
    expect(replay!.seen.map((q) => q.method)).toEqual(["GET", "POST", "POST"]);
    expect(inserts()).toHaveLength(1);
  });

  it("a retry after a crash: the lookup finds the event -> applied, replayed, no insert", async () => {
    const { ctx, id } = setup(["events-get-key-200"]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: true, replayed: true, result: { id: KEY } });
    expect(getAction(db, id)!.status).toBe("applied");
    expect(inserts()).toHaveLength(0);
  });

  it("insert 409 then the event is found -> applied with no second insert", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-409", "events-get-key-200"]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: true, result: { id: KEY } });
    expect(getAction(db, id)!.status).toBe("applied");
    expect(inserts()).toHaveLength(1);
  });

  it("insert 500 then lookup 404 -> PROVIDER_ERROR refusal, status stays approved (retryable), no token in the ledger", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-500", "events-get-key-404"]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    const a = getAction(db, id)!;
    expect(a.status).toBe("approved");
    expect(a.error).toBeNull();
    expect(rowsOf(id).at(-1)).toMatchObject({ kind: "apply_refused", outcome: "error", error_code: "PROVIDER_ERROR" });
    expect(rowsOf(id).map((e) => e.kind)).not.toContain("apply_failed");
    expect(dump()).not.toContain("FAKE-TOKEN");
  });

  it("insert 500 then lookup 404 -> approved; the retry's recovery lookup finds the event (it landed) -> applied, no second insert", async () => {
    const { ctx, id } = setup([
      "events-get-key-404",
      "freebusy-empty",
      "events-insert-500",
      "events-get-key-404",
      "events-get-key-200",
    ]);
    expect(await applyAction(ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(getAction(db, id)!.status).toBe("approved");
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: true, replayed: true, result: { id: KEY } });
    expect(getAction(db, id)!.status).toBe("applied");
    expect((rowsOf(id).at(-1)!.preview as { note: unknown }).note).toBe("recovered");
    expect(inserts()).toHaveLength(1);
  });

  it("insert 503 then lookup 404 -> approved; the retry's insert gets 409 then GET -> applied", async () => {
    const { ctx, id } = setup([
      "events-get-key-404",
      "freebusy-empty",
      "events-insert-503",
      "events-get-key-404",
      "events-get-key-404",
      "freebusy-empty",
      "events-insert-409",
      "events-get-key-200",
    ]);
    expect(await applyAction(ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(getAction(db, id)!.status).toBe("approved");
    expect(await applyAction(ctx, id)).toMatchObject({ ok: true, result: { id: KEY } });
    expect(getAction(db, id)!.status).toBe("applied");
    expect(inserts()).toHaveLength(2);
  });

  it("insert times out, lookup 404 -> approved; it lands; the retry recovers it with no second insert", async () => {
    let attempts = 0;
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-get-key-404", "events-get-key-200"], (m, u) => {
      if (m !== "POST" || !u.pathname.endsWith("/events")) return undefined;
      attempts += 1;
      return Promise.reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    });
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(r.ok ? "" : r.message).toContain("timed out");
    expect(getAction(db, id)!.status).toBe("approved");
    expect(await applyAction(ctx, id)).toMatchObject({ ok: true, replayed: true, result: { id: KEY } });
    expect(getAction(db, id)!.status).toBe("applied");
    expect(attempts).toBe(1);
  });

  it("insert network error, lookup 404 -> approved", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-get-key-404"], (m, u) =>
      m === "POST" && u.pathname.endsWith("/events") ? Promise.reject(new TypeError("fetch failed")) : undefined,
    );
    expect(await applyAction(ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(getAction(db, id)!.status).toBe("approved");
  });

  it("insert 429 rateLimitExceeded, lookup 404 -> approved (nothing was written; retry later)", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-429", "events-get-key-404"]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(r.ok ? "" : r.message).toContain("HTTP 429 rateLimitExceeded");
    expect(getAction(db, id)!.status).toBe("approved");
  });

  it("insert 400 (a definite rejection), lookup 404 -> failed with PROVIDER_ERROR", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-400", "events-get-key-404"]);
    expect(await applyAction(ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    const a = getAction(db, id)!;
    expect(a.status).toBe("failed");
    expect(a.error).toContain("HTTP 400");
  });

  it("insert 409 then 404 (definite), lookup 404 -> failed, no second insert", async () => {
    const { ctx, id } = setup([
      "events-get-key-404",
      "freebusy-empty",
      "events-insert-409",
      "events-get-key-404",
      "events-get-key-404",
    ]);
    expect(await applyAction(ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(getAction(db, id)!.status).toBe("failed");
    expect(getAction(db, id)!.error).toContain("id conflict but the event is not readable");
    expect(inserts()).toHaveLength(1);
  });

  it("insert 200 with an id other than ours -> failed with the different-id phrase", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-200-other-id", "events-get-key-404"]);
    expect(await applyAction(ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(getAction(db, id)!.status).toBe("failed");
    expect(getAction(db, id)!.error).toContain("Google returned a different event id");
  });

  it("insert 409 then cancelled -> failed with the deleted-event phrase", async () => {
    const { ctx, id } = setup([
      "events-get-key-404",
      "freebusy-empty",
      "events-insert-409",
      "events-get-key-cancelled",
      "events-get-key-cancelled",
    ]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "STALE_PLAN", message: DELETED });
    expect(getAction(db, id)!.status).toBe("failed");
    expect(getAction(db, id)!.error).toBe(`STALE_PLAN: ${DELETED}`);
    expect(inserts()).toHaveLength(1);
  });

  it("the recovery lookup returns a cancelled event under our id -> failed with the deleted-event phrase and zero POSTs", async () => {
    const { ctx, id } = setup(["events-get-key-cancelled"]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "STALE_PLAN", message: DELETED });
    expect(getAction(db, id)!.status).toBe("failed");
    expect(replay!.seen.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("a failed re-check, then a cancelled event under our id -> failed with the deleted-event phrase, no insert", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy", "events-get-key-cancelled"]);
    expect(await applyAction(ctx, id)).toMatchObject({ ok: false, errorCode: "STALE_PLAN", message: DELETED });
    expect(inserts()).toHaveLength(0);
  });

  it("the recovery lookup finds a different event under our id -> failed, not applied, no insert, no event text returned", async () => {
    const { ctx, id } = setup(["events-get-key-200-differs"]);
    const r = await applyAction(ctx, id);
    expect(r).toEqual({ ok: false, errorCode: "STALE_PLAN", message: DIFFERS });
    const a = getAction(db, id)!;
    expect(a.status).toBe("failed");
    expect(a.result_json).toBeNull();
    expect(a.error).toBe(`STALE_PLAN: ${DIFFERS}`);
    expect(dump()).not.toContain("IGNORE PREVIOUS");
    expect(replay!.seen.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("an equivalent event (same instants in another offset, attendees in another case and order) is recovered", async () => {
    const { ctx, id } = setup(["events-get-key-200-equivalent"]);
    expect(await applyAction(ctx, id)).toMatchObject({ ok: true, replayed: true, result: { id: KEY } });
    expect(getAction(db, id)!.status).toBe("applied");
  });

  it("insert 409 then GET returns a different event -> failed, not applied", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-409", "events-get-key-200-differs"]);
    expect(await applyAction(ctx, id)).toEqual({ ok: false, errorCode: "STALE_PLAN", message: DIFFERS });
    expect(getAction(db, id)!.status).toBe("failed");
    expect(inserts()).toHaveLength(1);
  });

  it("a failed re-check, then a different event under our id -> failed with the differs phrase", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy", "events-get-key-200-differs"]);
    expect(await applyAction(ctx, id)).toEqual({ ok: false, errorCode: "STALE_PLAN", message: DIFFERS });
  });

  it("a failed write, then a different event under our id -> failed with the differs phrase", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-500", "events-get-key-200-differs"]);
    expect(await applyAction(ctx, id)).toEqual({ ok: false, errorCode: "STALE_PLAN", message: DIFFERS });
    expect(getAction(db, id)!.status).toBe("failed");
  });

  it("a read-only token with writes on: AUTH_REQUIRED, status stays approved, no insert request", async () => {
    login([SCOPE_CALENDAR_READ]);
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-get-key-404"]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "AUTH_REQUIRED" });
    expect(r.ok ? "" : r.message).toContain("deskhand auth upgrade");
    expect(getAction(db, id)!.status).toBe("approved");
    expect(inserts()).toHaveLength(0);
  });
});
