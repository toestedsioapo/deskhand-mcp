import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { createPlan, listPending } from "../src/approval/plans.js";
import { getPlanKind, renderDiff } from "../src/approval/plan-kinds.js";
import { loadConfig } from "../src/config/env.js";
import { planHash } from "../src/ledger/canonical.js";
import { LedgerDb } from "../src/ledger/db.js";
import { getAction } from "../src/ledger/actions.js";
import { queryEvents } from "../src/ledger/events.js";
import { last4 } from "../src/ledger/ids.js";
import type { FixtureProvider } from "../src/providers/fixture/provider.js";
import { createFixtureProvider } from "../src/providers/fixture/provider.js";
import { makeTempHome } from "./helpers/home.js";
import { makeWorld, validPlan } from "./helpers/seed.js";

const NOW = "2026-11-10T09:00:00.000Z";

let home: ReturnType<typeof makeTempHome>;
let db: LedgerDb;
let seq: string[];
let provider: FixtureProvider;
let n = 0;
function ctxWith(env: NodeJS.ProcessEnv = {}): AppContext {
  return {
    config: loadConfig({ ...home.env, ...env }),
    db,
    clock: () => new Date(NOW),
    ids: { newActionId: () => seq.shift() ?? `act_FALLBACK00000000000${String(++n).padStart(5, "0")}` },
    provider,
    actor: "tester",
  };
}
const plan0 = (c: AppContext, plan: unknown = validPlan()) =>
  createPlan(c, { tool: "calendar_propose_event", input: {}, plan });

beforeEach(() => {
  home = makeTempHome();
  db = LedgerDb.open(join(home.home, "ledger.db"));
  seq = [];
  provider = createFixtureProvider(makeWorld());
});
afterEach(() => {
  db.close();
  home.cleanup();
});

describe("createPlan", () => {
  it("stores hash, status, 24h expiry and one plan_created event", () => {
    seq = ["act_AAAA0000000000000000WXYZ"];
    const plan = validPlan();
    const r = createPlan(ctxWith(), { tool: "calendar_propose_event", input: { title: "Sync" }, plan });
    expect(r.actionId).toBe("act_AAAA0000000000000000WXYZ");
    expect(r.expiresAt).toBe("2026-11-11T09:00:00.000Z");
    const a = getAction(db, r.actionId)!;
    expect(a.status).toBe("planned");
    expect(a.tool).toBe("calendar_propose_event");
    expect(a.plan_hash).toBe(planHash(a.plan_json));
    expect(r.planHash).toBe(a.plan_hash);
    expect(a.expires_at).toBe("2026-11-11T09:00:00.000Z");
    const ev = queryEvents(db, { limit: 10, actionId: r.actionId });
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "plan_created", outcome: "ok", tool: "calendar_propose_event" });
  });

  it("honours a 168h ttl", () => {
    const r = plan0(ctxWith({ DESKHAND_PLAN_TTL_HOURS: "168" }));
    expect(r.expiresAt).toBe("2026-11-17T09:00:00.000Z");
  });

  it("stores input_json with plain redaction (no cascading preview omission)", () => {
    const r = createPlan(ctxWith(), { tool: "t", input: { title: "x", token: "s3cret" }, plan: validPlan() });
    expect(getAction(db, r.actionId)!.input_json).toEqual({ title: "x", token: "[redacted]" });
  });

  it("throws on invalid plans and writes nothing", () => {
    const bad = [
      validPlan({}, { end: "2026-11-12T09:00:00.000Z" }),
      { kind: "mail.send", event: {} },
      validPlan({ extra: 1 }),
      validPlan({ observed: { slotFree: false, etags: {} } }),
    ];
    for (const plan of bad) expect(() => plan0(ctxWith(), plan)).toThrow();
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM actions")!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM events")!.n).toBe(0);
  });

  it("regenerates ids whose last 4 collide with a planned action", () => {
    seq = [
      "act_AAAA0000000000000000ABCD",
      "act_BBBB0000000000000000ABCD",
      "act_CCCC0000000000000000ABCD",
      "act_DDDD0000000000000000WXYZ",
    ];
    const first = plan0(ctxWith());
    expect(first.actionId.endsWith("ABCD")).toBe(true);
    const second = plan0(ctxWith());
    expect(last4(second.actionId)).toBe("WXYZ");
    expect(second.actionId).not.toBe(first.actionId);
  });

  it("also avoids approved ids, but applied/rejected free the last 4", () => {
    seq = ["act_AAAA0000000000000000ABCD"];
    const first = plan0(ctxWith());
    db.run("UPDATE actions SET status = 'approved' WHERE id = ?", [first.actionId]);
    seq = ["act_BBBB0000000000000000ABCD", "act_CCCC0000000000000000WXYZ"];
    expect(last4(plan0(ctxWith()).actionId)).toBe("WXYZ");
    db.run("UPDATE actions SET status = 'applied' WHERE id = ?", [first.actionId]);
    seq = ["act_EEEE0000000000000000ABCD"];
    const reused = plan0(ctxWith());
    expect(reused.actionId.endsWith("ABCD")).toBe(true);
    db.run("UPDATE actions SET status = 'rejected' WHERE id = ?", [reused.actionId]);
    seq = ["act_FFFF0000000000000000ABCD"];
    expect(plan0(ctxWith()).actionId.endsWith("ABCD")).toBe(true);
  });

  it("throws if the generator cannot produce a free id", () => {
    const ctx = ctxWith();
    ctx.ids = { newActionId: () => "act_ZZZZ0000000000000000ABCD" };
    plan0(ctx);
    ctx.ids = { newActionId: () => "act_YYYY0000000000000000ABCD" };
    expect(() => plan0(ctx)).toThrow(/id/i);
  });

  it("sendUpdates changes the plan hash", () => {
    const a = plan0(ctxWith());
    const b = plan0(ctxWith(), validPlan({}, { sendUpdates: "none" }));
    expect(a.planHash).not.toBe(b.planHash);
  });
});

describe("listPending", () => {
  it("returns planned actions oldest first, expired included", () => {
    let t = NOW;
    const mk = (id: string) => {
      const c = ctxWith();
      c.clock = () => new Date(t);
      c.ids = { newActionId: () => id };
      return plan0(c);
    };
    const a = mk("act_AAAA0000000000000000AAA1");
    t = "2026-11-10T10:00:00.000Z";
    const b = mk("act_BBBB0000000000000000BBB2");
    t = "2026-11-10T11:00:00.000Z";
    const c = mk("act_CCCC0000000000000000CCC3");
    db.run("UPDATE actions SET status = 'applied' WHERE id = ?", [b.actionId]);
    const ctx = ctxWith();
    ctx.clock = () => new Date("2027-01-01T00:00:00.000Z");
    expect(listPending(ctx).map((x) => x.id)).toEqual([a.actionId, c.actionId]);
  });
});

describe("renderDiff", () => {
  it("lists title, range, attendees and email count", () => {
    const d = renderDiff(validPlan());
    expect(d).toContain("will email 3 attendees");
    const text = d.join("\n");
    expect(text).toContain("Sync");
    expect(text).toContain("2026-11-12T10:00:00.000Z");
    expect(text).toContain("3 attendees");
  });
  it("says no notifications for sendUpdates=none or zero attendees", () => {
    expect(renderDiff(validPlan({}, { sendUpdates: "none" }))).toContain(
      "no attendee notifications (sendUpdates=none)",
    );
    expect(renderDiff(validPlan({}, { attendees: [] }))).toContain(
      "no attendee notifications (sendUpdates=none)",
    );
  });
  it("keeps raw control characters and is deterministic", () => {
    const p = validPlan({}, { title: "\u001b[31mred" });
    expect(renderDiff(p).join("\n")).toContain("\u001b[31mred");
    expect(renderDiff(p)).toEqual(renderDiff(p));
  });
  it("unknown kind", () => {
    expect(renderDiff({ kind: "nope" })).toEqual(["(unknown plan kind)"]);
    expect(renderDiff("x")).toEqual(["(unknown plan kind)"]);
    expect(getPlanKind("nope")).toBeUndefined();
  });
});

describe("calendar.create_event kind", () => {
  const kind = () => getPlanKind("calendar.create_event")!;
  const plan = () => kind().schema.parse(validPlan());
  it("recheck ok when slot free and etags unchanged", async () => {
    expect(await kind().recheck(plan(), provider)).toEqual({ ok: true });
  });
  it("recheck fails when an etag changed", async () => {
    provider.touchEvent("primary", "evt_standup");
    expect((await kind().recheck(plan(), provider)).ok).toBe(false);
  });
  it("recheck fails when the slot is busy", async () => {
    provider.addBusy("primary", { start: "2026-11-12T10:10:00.000Z", end: "2026-11-12T10:20:00.000Z" });
    expect((await kind().recheck(plan(), provider)).ok).toBe(false);
  });
  it("execute then lookupExisting by idempotency key", async () => {
    expect(await kind().lookupExisting(plan(), "key1", provider)).toBeNull();
    const ref = await kind().execute(plan(), "key1", provider);
    expect((await kind().lookupExisting(plan(), "key1", provider))?.id).toBe(ref.id);
  });
});
