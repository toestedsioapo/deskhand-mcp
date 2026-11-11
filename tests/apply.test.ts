import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { applyAction, idempotencyKey } from "../src/approval/apply.js";
import { loadConfig } from "../src/config/env.js";
import { getAction } from "../src/ledger/actions.js";
import { LedgerDb } from "../src/ledger/db.js";
import { createIdGenerator } from "../src/ledger/ids.js";
import { queryEvents, type EventRow } from "../src/ledger/events.js";
import type { FixtureProvider } from "../src/providers/fixture/provider.js";
import { createFixtureProvider } from "../src/providers/fixture/provider.js";
import type { CalendarProvider, EventRef } from "../src/providers/types.js";
import { makeTempHome } from "./helpers/home.js";
import { makeWorld, seedAction, validPlan } from "./helpers/seed.js";

const NOW = "2026-11-10T09:00:00.000Z";
const AFTER_EXPIRY = "2026-11-11T09:00:00.001Z"; // plans expire 24h after NOW
const SLOT = { start: "2026-11-12T10:10:00.000Z", end: "2026-11-12T10:20:00.000Z" };

let home: ReturnType<typeof makeTempHome>;
let db: LedgerDb;
let provider: FixtureProvider;
let now: string;
let ctx: AppContext;

function makeCtx(over: Partial<AppContext> = {}, env: NodeJS.ProcessEnv = { DESKHAND_ALLOW_WRITES: "1" }): AppContext {
  return {
    config: loadConfig({ ...home.env, ...env }),
    db,
    clock: () => new Date(now),
    ids: createIdGenerator(),
    provider,
    actor: "tester",
    ...over,
  };
}

const events = (id: string): EventRow[] => queryEvents(db, { limit: 100, actionId: id }).reverse();
const kinds = (id: string) => events(id).map((e) => e.kind);
const status = (id: string) => getAction(db, id)!.status;
const eventCount = () => db.get<{ n: number }>("SELECT count(*) AS n FROM events")!.n;

beforeEach(() => {
  home = makeTempHome();
  db = LedgerDb.open(join(home.home, "ledger.db"));
  provider = createFixtureProvider(makeWorld());
  now = NOW;
  ctx = makeCtx();
});
afterEach(() => {
  db.close();
  home.cleanup();
});

/** Asserts a gate refusal: code, one apply_refused row, status unchanged, no write. */
async function expectRefused(c: AppContext, id: string, code: string, before: string) {
  const r = await applyAction(c, id);
  expect(r).toMatchObject({ ok: false, errorCode: code });
  expect(status(id)).toBe(before);
  const last = events(id).at(-1)!;
  expect(last).toMatchObject({ kind: "apply_refused", outcome: "rejected", error_code: code, tool: "action_apply" });
  expect(provider.writes).toHaveLength(0);
  return r;
}

/** Asserts a failure that moves the plan to failed: code, one apply_failed row, error set, no write. */
async function expectFailed(c: AppContext, id: string, code: string) {
  const r = await applyAction(c, id);
  expect(r).toMatchObject({ ok: false, errorCode: code });
  const a = getAction(db, id)!;
  expect(a.status).toBe("failed");
  expect(a.error).toEqual(expect.any(String));
  expect(a.error!.length).toBeGreaterThan(0);
  expect(a.approved_by).toBe("tester"); // failed keeps its approval columns
  expect(events(id).filter((e) => e.kind === "apply_failed")).toEqual([
    expect.objectContaining({ outcome: "error", error_code: code, tool: "action_apply" }),
  ]);
  expect(provider.writes).toHaveLength(0);
  return r;
}

describe("idempotencyKey", () => {
  it("is the lowercase hex sha256 of the action id", () => {
    const id = "act_01JC3Z8K4V7Q2W9X5R6T1N0BHM";
    expect(idempotencyKey(id)).toBe(createHash("sha256").update(id, "utf8").digest("hex"));
    expect(idempotencyKey(id)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("apply without approval", () => {
  for (const state of ["planned", "rejected", "failed"] as const) {
    it(`${state} -> NOT_APPROVED`, async () => {
      const id = seedAction(ctx, state);
      await expectRefused(ctx, id, "NOT_APPROVED", state);
    });
  }
});

describe("writes disabled", () => {
  it("writesEnabled=false on an approved plan -> WRITES_DISABLED", async () => {
    const id = seedAction(ctx, "approved");
    const off = makeCtx({}, {});
    expect(off.config.writesEnabled).toBe(false);
    await expectRefused(off, id, "WRITES_DISABLED", "approved");
  });

  it('env value "true" through loadConfig is still disabled', async () => {
    const id = seedAction(ctx, "approved");
    const off = makeCtx({}, { DESKHAND_ALLOW_WRITES: "true" });
    await expectRefused(off, id, "WRITES_DISABLED", "approved");
  });

  it("is checked before replay: an applied plan with writes off is refused", async () => {
    const id = seedAction(ctx, "applied");
    await expectRefused(makeCtx({}, {}), id, "WRITES_DISABLED", "applied");
  });
});

describe("no provider configured", () => {
  it("writes on, approved plan, provider null -> PROVIDER_NOT_CONFIGURED: one rejected apply_refused row, status approved", async () => {
    const id = seedAction(ctx, "approved");
    const none = makeCtx({ provider: null });
    expect(none.config.writesEnabled).toBe(true);
    const r = await applyAction(none, id);
    expect(r).toMatchObject({ ok: false, errorCode: "PROVIDER_NOT_CONFIGURED" });
    expect(status(id)).toBe("approved");
    const refused = events(id).filter((e) => e.kind === "apply_refused");
    expect(refused).toEqual([
      expect.objectContaining({ outcome: "rejected", error_code: "PROVIDER_NOT_CONFIGURED", tool: "action_apply" }),
    ]);
    expect(provider.writes).toHaveLength(0);
  });

  it("is also refused for an unknown id, with action_id NULL on the row", async () => {
    const r = await applyAction(makeCtx({ provider: null }), "act_DOESNOTEXIST0000000000000");
    expect(r).toMatchObject({ ok: false, errorCode: "PROVIDER_NOT_CONFIGURED" });
    expect(queryEvents(db, { limit: 10 })[0]).toMatchObject({ kind: "apply_refused", outcome: "rejected", action_id: null });
  });

  it("with writes off as well, WRITES_DISABLED answers first", async () => {
    const id = seedAction(ctx, "approved");
    const r = await applyAction(makeCtx({ provider: null }, {}), id);
    expect(r).toMatchObject({ ok: false, errorCode: "WRITES_DISABLED" });
    expect(status(id)).toBe("approved");
  });
});

describe("unknown id", () => {
  it("-> UNKNOWN_ACTION, apply_refused row with action_id NULL and the id in the preview", async () => {
    const r = await applyAction(ctx, "act_DOESNOTEXIST0000000000000");
    expect(r).toMatchObject({ ok: false, errorCode: "UNKNOWN_ACTION" });
    const rows = queryEvents(db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "apply_refused", outcome: "rejected", error_code: "UNKNOWN_ACTION", action_id: null });
    expect((rows[0]!.preview as { input: unknown }).input).toEqual({ action_id: "act_DOESNOTEXIST0000000000000" });
    expect(provider.writes).toHaveLength(0);
  });
});

describe("expired plan", () => {
  it("approved, clock past expires_at -> PLAN_EXPIRED", async () => {
    const id = seedAction(ctx, "approved");
    now = AFTER_EXPIRY;
    await expectRefused(ctx, id, "PLAN_EXPIRED", "approved");
  });
});

describe("tampered after approval", () => {
  it("edited plan_json -> PLAN_MODIFIED, failed, apply_failed, no write", async () => {
    const id = seedAction(ctx, "approved");
    db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [
      JSON.stringify(validPlan({}, { attendees: ["evil@example.com"] })),
      id,
    ]);
    await expectFailed(ctx, id, "PLAN_MODIFIED");
  });

  it("plan_json that is not JSON -> PLAN_MODIFIED", async () => {
    const id = seedAction(ctx, "approved");
    db.run("UPDATE actions SET plan_json = '{not json' WHERE id = ?", [id]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    // getAction would throw parsing plan_json, so read the raw columns.
    expect(db.get<{ status: string }>("SELECT status FROM actions WHERE id = ?", [id])!.status).toBe("failed");
    expect(events(id).filter((e) => e.kind === "apply_failed")).toHaveLength(1);
    expect(provider.writes).toHaveLength(0);
  });

  it("edited plan_hash only -> PLAN_MODIFIED", async () => {
    const id = seedAction(ctx, "approved");
    db.run("UPDATE actions SET plan_hash = ? WHERE id = ?", ["0".repeat(64), id]);
    await expectFailed(ctx, id, "PLAN_MODIFIED");
  });

  it("edited approved_plan_hash only -> PLAN_MODIFIED", async () => {
    const id = seedAction(ctx, "approved");
    db.run("UPDATE actions SET approved_plan_hash = ? WHERE id = ?", ["0".repeat(64), id]);
    await expectFailed(ctx, id, "PLAN_MODIFIED");
  });

  it("plan_json and plan_hash both rewritten consistently still fail on approved_plan_hash", async () => {
    const id = seedAction(ctx, "approved");
    const { planHash } = await import("../src/ledger/canonical.js");
    const evil = validPlan({}, { sendUpdates: "none", title: "Other" });
    db.run("UPDATE actions SET plan_json = ?, plan_hash = ? WHERE id = ?", [JSON.stringify(evil), planHash(evil), id]);
    await expectFailed(ctx, id, "PLAN_MODIFIED");
  });
});

describe("stale slot", () => {
  it("addBusy over the slot after approval -> STALE_PLAN, failed, no write", async () => {
    const id = seedAction(ctx, "approved");
    provider.addBusy("primary", SLOT);
    await expectFailed(ctx, id, "STALE_PLAN");
  });

  it("touchEvent on an observed etag -> STALE_PLAN", async () => {
    const id = seedAction(ctx, "approved");
    provider.touchEvent("primary", "evt_standup");
    await expectFailed(ctx, id, "STALE_PLAN");
  });
});

describe("happy path", () => {
  it("applies once, stores the result, one applied event, key is sha256 of the id", async () => {
    const id = seedAction(ctx, "approved");
    const r = await applyAction(ctx, id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.replayed).toBe(false);
    const a = getAction(db, id)!;
    expect(a.status).toBe("applied");
    expect(a.applied_at).toBe(NOW);
    expect(a.result_json).toEqual(r.result);
    expect(a.error).toBeNull();
    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]!.id).toBe(createHash("sha256").update(id, "utf8").digest("hex"));
    expect(r.result).toMatchObject({ id: idempotencyKey(id), title: "Sync", start: "2026-11-12T10:00:00.000Z" });
    const applied = events(id).filter((e) => e.kind === "applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ outcome: "ok", error_code: null, tool: "action_apply" });
    expect((applied[0]!.preview as { note: unknown }).note).toBeNull();
    expect(kinds(id)).toEqual(["plan_created", "applied"]);
  });
});

describe("double apply", () => {
  it("second call replays: same result, one write, one applied event, no new rows", async () => {
    const id = seedAction(ctx, "approved");
    const first = await applyAction(ctx, id);
    const rowsAfterFirst = eventCount();
    const second = await applyAction(ctx, id);
    expect(second).toEqual({ ok: true, replayed: true, result: (first as { result: EventRef }).result });
    expect(provider.writes).toHaveLength(1);
    expect(events(id).filter((e) => e.kind === "applied")).toHaveLength(1);
    expect(eventCount()).toBe(rowsAfterFirst); // replay writes no lifecycle row
  });

  it("replay works after the plan's expiry", async () => {
    const id = seedAction(ctx, "approved");
    const first = await applyAction(ctx, id);
    now = AFTER_EXPIRY;
    const again = await applyAction(ctx, id);
    expect(again).toEqual({ ok: true, replayed: true, result: (first as { result: EventRef }).result });
    expect(provider.writes).toHaveLength(1);
  });
});

describe("concurrent apply", () => {
  it("two connections, one provider: one write, one applied event, equal results", async () => {
    // Both contexts share ONE fixture provider instance (the "same calendar"); its
    // createEvent is idempotent per key, and the ledger CAS lets only one commit.
    provider = createFixtureProvider(makeWorld({ settings: { latency_ms: 15 } }));
    const dbB = LedgerDb.open(join(home.home, "ledger.db"));
    try {
      const ctxA = makeCtx({ provider });
      const ctxB = makeCtx({ provider, db: dbB });
      const id = seedAction(ctxA, "approved");
      const [a, b] = await Promise.all([applyAction(ctxA, id), applyAction(ctxB, id)]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.result).toEqual(b.result);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(provider.writes).toHaveLength(1);
      expect(events(id).filter((e) => e.kind === "applied")).toHaveLength(1);
      expect(events(id).filter((e) => e.kind === "apply_failed" || e.kind === "apply_refused")).toHaveLength(0);
      expect(status(id)).toBe("applied");
    } finally {
      dbB.close();
    }
  });
});

describe("crash between provider write and ledger update", () => {
  const SENTINEL = new Error("simulated crash before commit");
  let id: string;
  let original: EventRef;

  beforeEach(async () => {
    id = seedAction(ctx, "approved");
    const crashing = makeCtx({ hooks: { beforeCommit: () => { throw SENTINEL; } } });
    await expect(applyAction(crashing, id)).rejects.toBe(SENTINEL);
    expect(provider.writes).toHaveLength(1);
    // Copy now: later addBusy/touchEvent must not change what we compare against.
    original = structuredClone(provider.writes[0]!);
  });

  it("the sentinel propagates and nothing was committed", () => {
    const a = getAction(db, id)!;
    expect(a.status).toBe("approved");
    expect(a.applied_at).toBeNull();
    expect(a.result_json).toBeNull();
    expect(kinds(id)).toEqual(["plan_created"]); // no applied, no apply_failed
  });

  async function expectRecovered() {
    const r = await applyAction(ctx, id);
    expect(r).toEqual({ ok: true, replayed: true, result: original });
    expect(provider.writes).toHaveLength(1);
    const a = getAction(db, id)!;
    expect(a.status).toBe("applied");
    expect(a.result_json).toEqual(original);
    expect(a.applied_at).toBe(now);
    const applied = events(id).filter((e) => e.kind === "applied");
    expect(applied).toHaveLength(1);
    expect((applied[0]!.preview as { note: unknown }).note).toBe("recovered");
    expect(kinds(id)).toEqual(["plan_created", "applied"]);
  }

  it("(a) plain retry recovers", async () => {
    await expectRecovered();
  });

  it("(b) retry after the slot is taken recovers (re-check alone would say STALE_PLAN)", async () => {
    provider.addBusy("primary", SLOT);
    await expectRecovered();
  });

  it("(c) retry after expiry recovers (expiry gate alone would say PLAN_EXPIRED)", async () => {
    now = AFTER_EXPIRY;
    await expectRecovered();
  });

  it("a tampered plan after the crash still gives PLAN_MODIFIED (hash gate precedes recovery)", async () => {
    db.run("UPDATE actions SET plan_hash = ? WHERE id = ?", ["f".repeat(64), id]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    expect(status(id)).toBe("failed");
    expect(events(id).filter((e) => e.kind === "applied")).toHaveLength(0);
    expect(provider.writes).toHaveLength(1);
  });

  it("writes disabled after the crash is WRITES_DISABLED, not a recovery", async () => {
    const r = await applyAction(makeCtx({}, {}), id);
    expect(r).toMatchObject({ ok: false, errorCode: "WRITES_DISABLED" });
    expect(status(id)).toBe("approved");
    expect(kinds(id)).toEqual(["plan_created", "apply_refused"]);
    expect(provider.writes).toHaveLength(1);
  });
});

describe("recovery does not bypass gates when nothing was written", () => {
  it("expired plan, no prior write -> PLAN_EXPIRED", async () => {
    const id = seedAction(ctx, "approved");
    now = AFTER_EXPIRY;
    await expectRefused(ctx, id, "PLAN_EXPIRED", "approved");
  });

  it("taken slot, no prior write -> STALE_PLAN", async () => {
    const id = seedAction(ctx, "approved");
    provider.addBusy("primary", SLOT);
    await expectFailed(ctx, id, "STALE_PLAN");
  });

  it("someone else's event under a different id does not count as ours", async () => {
    const other = seedAction(ctx, "approved");
    const id = seedAction(ctx, "approved", validPlan({}, { start: "2026-11-13T10:00:00.000Z", end: "2026-11-13T10:30:00.000Z" }));
    await applyAction(ctx, other);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: true, replayed: false });
    expect(provider.writes).toHaveLength(2);
  });
});

describe("provider failure", () => {
  it("createEvent rejects -> PROVIDER_ERROR, failed, apply_failed", async () => {
    const failing: CalendarProvider = {
      freeBusy: (c, r) => provider.freeBusy(c, r),
      getEvent: (c, i) => provider.getEvent(c, i),
      createEvent: async () => {
        throw new Error("backend unavailable");
      },
    };
    const id = seedAction(ctx, "approved");
    const r = await expectFailed(makeCtx({ provider: failing }), id, "PROVIDER_ERROR");
    expect((r as { message: string }).message).toContain("backend unavailable");
  });

  it("a long provider error is stored through the redactor (cut and hashed)", async () => {
    const long = `secret-ish detail ${"x".repeat(500)}`;
    const failing: CalendarProvider = {
      freeBusy: (c, r) => provider.freeBusy(c, r),
      getEvent: (c, i) => provider.getEvent(c, i),
      createEvent: async () => {
        throw new Error(long);
      },
    };
    const id = seedAction(ctx, "approved");
    const r = await expectFailed(makeCtx({ provider: failing }), id, "PROVIDER_ERROR");
    const err = getAction(db, id)!.error!;
    expect(err).toContain("…[truncated sha256:");
    expect(err).not.toContain(long);
    expect((r as { message: string }).message).not.toContain(long);
  });

  it("an ambiguous write failure (event recorded, then the call throws) finalizes applied, not failed", async () => {
    const ambiguous: CalendarProvider = {
      freeBusy: (c, r) => provider.freeBusy(c, r),
      getEvent: (c, i) => provider.getEvent(c, i),
      createEvent: async (e, k) => {
        await provider.createEvent(e, k);
        throw new Error("timeout after the server accepted the event");
      },
    };
    const id = seedAction(ctx, "approved");
    const r = await applyAction(makeCtx({ provider: ambiguous }), id);
    expect(r).toEqual({ ok: true, replayed: true, result: expect.objectContaining({ id: idempotencyKey(id) }) });
    expect(status(id)).toBe("applied");
    expect(provider.writes).toHaveLength(1);
    expect(kinds(id)).toEqual(["plan_created", "applied"]);
    expect((events(id)[1]!.preview as { note: unknown }).note).toBe("recovered");
  });
});

/** A provider read error is retryable: apply_refused PROVIDER_ERROR, status unchanged, no write. */
describe("provider read errors are not terminal", () => {
  async function expectReadRefused(p: CalendarProvider, id: string) {
    const r = await applyAction(makeCtx({ provider: p }), id);
    expect(r).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    const a = getAction(db, id)!;
    expect(a.status).toBe("approved");
    expect(a.error).toBeNull();
    expect(events(id).at(-1)).toMatchObject({ kind: "apply_refused", outcome: "error", error_code: "PROVIDER_ERROR" });
    expect(provider.writes).toHaveLength(0);
  }

  it("getEvent throws during the recovery lookup -> refused, still approved, retry applies", async () => {
    const id = seedAction(ctx, "approved");
    await expectReadRefused(
      {
        freeBusy: (c, r) => provider.freeBusy(c, r),
        getEvent: async () => {
          throw new Error("getEvent down");
        },
        createEvent: (e, k) => provider.createEvent(e, k),
      },
      id,
    );
    expect(await applyAction(ctx, id)).toMatchObject({ ok: true, replayed: false });
  });

  it("freeBusy throws during the re-check -> refused, still approved", async () => {
    const id = seedAction(ctx, "approved");
    await expectReadRefused(
      {
        freeBusy: async () => {
          throw new Error("freeBusy down");
        },
        getEvent: (c, i) => provider.getEvent(c, i),
        createEvent: (e, k) => provider.createEvent(e, k),
      },
      id,
    );
  });
});

describe("concurrent apply where our event lands between the other caller's lookup and re-check", () => {
  it("ends applied with one event and equal results (re-lookup before STALE_PLAN)", async () => {
    // A: createEvent records the write, then returns late (a slow real API).
    // B: its recovery lookup runs before A's write; its re-check runs after it,
    // so B's slot check sees A's event. Without the re-lookup B would fail the
    // plan while our event exists.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const slowReturn: CalendarProvider = {
      freeBusy: (c, r) => provider.freeBusy(c, r),
      getEvent: (c, i) => provider.getEvent(c, i),
      createEvent: async (e, k) => {
        const ev = await provider.createEvent(e, k);
        await sleep(40);
        return ev;
      },
    };
    const lateRecheck: CalendarProvider = {
      freeBusy: async (c, r) => {
        await sleep(15);
        return provider.freeBusy(c, r);
      },
      getEvent: (c, i) => provider.getEvent(c, i),
      createEvent: (e, k) => provider.createEvent(e, k),
    };
    const dbB = LedgerDb.open(join(home.home, "ledger.db"));
    try {
      const ctxA = makeCtx({ provider: slowReturn });
      const ctxB = makeCtx({ provider: lateRecheck, db: dbB });
      const id = seedAction(ctxA, "approved");
      const [a, b] = await Promise.all([applyAction(ctxA, id), applyAction(ctxB, id)]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.result).toEqual(b.result);
      expect(status(id)).toBe("applied");
      expect(provider.writes).toHaveLength(1);
      expect(events(id).filter((e) => e.kind === "applied")).toHaveLength(1);
      expect(events(id).filter((e) => e.kind === "apply_failed" || e.kind === "apply_refused")).toHaveLength(0);
    } finally {
      dbB.close();
    }
  });
});

describe("stored plan oddities", () => {
  it("hash-consistent plan with an unknown kind -> apply_refused INTERNAL, status unchanged", async () => {
    const { planHash } = await import("../src/ledger/canonical.js");
    const id = seedAction(ctx, "approved");
    const odd = { kind: "mail.send", to: "x@example.com" };
    const h = planHash(odd);
    db.run("UPDATE actions SET plan_json = ?, plan_hash = ?, approved_plan_hash = ? WHERE id = ?", [JSON.stringify(odd), h, h, id]);
    const r = await applyAction(ctx, id);
    expect(r).toMatchObject({ ok: false, errorCode: "INTERNAL" });
    expect(status(id)).toBe("approved");
    expect(events(id).at(-1)).toMatchObject({ kind: "apply_refused", outcome: "error", error_code: "INTERNAL" });
    expect(provider.writes).toHaveLength(0);
  });

  it("unparseable expires_at fails closed -> PLAN_EXPIRED", async () => {
    const id = seedAction(ctx, "approved");
    db.run("UPDATE actions SET expires_at = 'not a date' WHERE id = ?", [id]);
    await expectRefused(ctx, id, "PLAN_EXPIRED", "approved");
  });
});
