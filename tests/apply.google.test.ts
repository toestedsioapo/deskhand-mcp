import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { applyAction, idempotencyKey } from "../src/approval/apply.js";
import { createPlan } from "../src/approval/plans.js";
import { loadConfig } from "../src/config/env.js";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE } from "../src/config/scopes.js";
import { getAction } from "../src/ledger/actions.js";
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

/** A real ledger and apply engine over the Google provider, served by recordings. */
function setup(names: string[]): { ctx: AppContext; id: string } {
  replay = replayFetch(names);
  const f = replay.fetch;
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

  it("insert 500 then lookup 404 -> failed with PROVIDER_ERROR and no token anywhere in the ledger", async () => {
    const { ctx, id } = setup(["events-get-key-404", "freebusy-empty", "events-insert-500", "events-get-key-404"]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    const a = getAction(db, id)!;
    expect(a.status).toBe("failed");
    expect(a.error).toContain("PROVIDER_ERROR");
    expect(dump()).not.toContain("FAKE-TOKEN");
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
    expect(r).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(getAction(db, id)!.status).toBe("failed");
    expect(getAction(db, id)!.error).toContain("an event with this action's id was created and later deleted");
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
