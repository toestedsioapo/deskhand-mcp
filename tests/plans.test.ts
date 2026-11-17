import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { createPlan, listPending } from "../src/approval/plans.js";
import { calendarCreateEvent, getPlanKind, renderDiff } from "../src/approval/plan-kinds.js";
import { loadConfig } from "../src/config/env.js";
import { canonicalJson, hashablePlan, planHash } from "../src/ledger/canonical.js";
import { LedgerDb } from "../src/ledger/db.js";
import { getAction } from "../src/ledger/actions.js";
import { queryEvents } from "../src/ledger/events.js";
import { last4 } from "../src/ledger/ids.js";
import type { FixtureProvider } from "../src/providers/fixture/provider.js";
import { createFixtureMailProvider, createFixtureProvider } from "../src/providers/fixture/index.js";
import { makeTempHome } from "./helpers/home.js";
import { DRAFT_BODY, makeWorld, validDraftPlan, validPlan } from "./helpers/seed.js";

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
    mail: createFixtureMailProvider(),
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

  it("reads the clock once: expires_at is exactly created_at + ttl even with a ticking clock", () => {
    let t = Date.parse(NOW);
    const c = ctxWith();
    let reads = 0;
    c.clock = () => {
      reads++;
      return new Date((t += 7));
    };
    const r = plan0(c);
    const a = getAction(db, r.actionId)!;
    expect(Date.parse(a.expires_at) - Date.parse(a.created_at)).toBe(24 * 3_600_000);
    expect(reads).toBe(1);
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
  const MANILA = "Asia/Manila";
  const UTC_LINE = "utc: 2026-11-12T10:00:00.000Z to 2026-11-12T10:30:00.000Z";
  it("lists title, local range, utc range, calendar, attendees and email count in order", () => {
    expect(renderDiff(validPlan(), MANILA)).toEqual([
      "create event: Sync",
      "when: Thu 12 Nov 2026, 18:00 to 18:30 GMT+8 (Asia/Manila)",
      UTC_LINE,
      "calendar: primary",
      "3 attendees",
      "  a@example.com",
      "  b@example.com",
      "  c@example.com",
      "will email 3 attendees",
    ]);
  });
  it("says no notifications for sendUpdates=none or zero attendees, naming the stored value", () => {
    expect(renderDiff(validPlan({}, { sendUpdates: "none" }), MANILA)).toContain(
      "no attendee notifications (sendUpdates=none)",
    );
    const none = renderDiff(validPlan({}, { attendees: [] }), MANILA);
    expect(none).toContain("no attendee notifications (sendUpdates=all, no attendees)");
    expect(none).toContain("0 attendees");
    expect(none.filter((l) => l.startsWith("  "))).toEqual([]);
  });
  it("prints the title verbatim and is deterministic", () => {
    const p = validPlan({}, { title: "Q4 review: budget & hiring" });
    expect(renderDiff(p, MANILA)[0]).toBe("create event: Q4 review: budget & hiring");
    expect(renderDiff(p, MANILA)).toEqual(renderDiff(p, MANILA));
  });
  // A title, calendar id or attendee that the sanitiser would alter is an invalid plan, not a flattened line:
  // see tests/diff-forgery.test.ts ("a plan row written around the tool cannot be shown as something else").
  it("the calendar diff is the same for the approver and the agent audience, and the agent is the default", () => {
    const p = validPlan({}, { timeZone: "Europe/Berlin" });
    const approver = renderDiff(p, MANILA, "approver");
    expect(renderDiff(p, MANILA, "agent")).toEqual(approver);
    expect(renderDiff(p, MANILA)).toEqual(approver);
  });

  it("unknown kind", () => {
    expect(renderDiff({ kind: "nope" }, MANILA)).toEqual(["(unknown plan kind)"]);
    expect(renderDiff("x", MANILA)).toEqual(["(unknown plan kind)"]);
    expect(getPlanKind("nope")).toBeUndefined();
  });

  it("viewer zone: when line in the viewer zone, then the event zone line, then utc", () => {
    const d = renderDiff(validPlan({}, { timeZone: "Europe/Berlin" }), MANILA);
    expect(d[1]).toBe("when: Thu 12 Nov 2026, 18:00 to 18:30 GMT+8 (Asia/Manila)");
    expect(d[2]).toBe("event zone: Thu 12 Nov 2026, 11:00 to 11:30 CET (Europe/Berlin)");
    expect(d[3]).toBe(UTC_LINE);
  });
  it("no event zone line when the event zone is the viewer zone", () => {
    const d = renderDiff(validPlan({}, { timeZone: "Europe/Berlin" }), "Europe/Berlin");
    expect(d[1]).toBe("when: Thu 12 Nov 2026, 11:00 to 11:30 CET (Europe/Berlin)");
    expect(d.some((l) => l.startsWith("event zone:"))).toBe(false);
    expect(d).toContain(UTC_LINE);
  });
  it("a plan without a time zone has no event zone line", () => {
    const d = renderDiff(validPlan(), MANILA);
    expect(d[1]).toBe("when: Thu 12 Nov 2026, 18:00 to 18:30 GMT+8 (Asia/Manila)");
    expect(d.some((l) => l.startsWith("event zone:"))).toBe(false);
  });

  it("attendees: every address on its own line, in order, before the notification line", () => {
    const attendees = ["ana@example.com", "ben@example.com", "cy@example.com"];
    const d = renderDiff(validPlan({}, { attendees }), MANILA);
    const i = d.indexOf("3 attendees");
    expect(d.slice(i + 1, i + 4)).toEqual(attendees.map((a) => `  ${a}`));
    expect(d[i + 4]).toBe("will email 3 attendees");
  });
  it("50 attendees render 50 lines", () => {
    const attendees = Array.from({ length: 50 }, (_, k) => `p${k}@example.com`);
    const d = renderDiff(validPlan({}, { attendees }), MANILA);
    expect(d.filter((l) => l.startsWith("  "))).toHaveLength(50);
  });

  it("a rationale with line breaks never reaches the diff", () => {
    const d = renderDiff(validPlan({ rationale: "a\nb\r\nc" }), MANILA);
    expect(d).toHaveLength(9);
    for (const l of d) expect(l).not.toMatch(/[\n\r]/);
  });

  it("a timeZone that is not an IANA name is an invalid plan", () => {
    expect(renderDiff(validPlan({}, { timeZone: "+01:00" }), MANILA)).toEqual(["(invalid plan)"]);
  });
  it("plans differing only in event.timeZone have different hashes", () => {
    expect(planHash(validPlan({}, { timeZone: "Europe/Berlin" }))).not.toBe(
      planHash(validPlan({}, { timeZone: "Europe/Paris" })),
    );
  });
  it("timeZone is part of the plan hash; the viewer zone is not", () => {
    expect(planHash(validPlan())).not.toBe(planHash(validPlan({}, { timeZone: "Europe/Berlin" })));
    const p = validPlan({}, { timeZone: "Europe/Berlin" });
    const before = planHash(p);
    const m = renderDiff(p, MANILA);
    const u = renderDiff(p, "UTC");
    expect(planHash(p)).toBe(before);
    expect(m).toHaveLength(u.length);
    expect(m).not.toEqual(u);
    m.forEach((l, k) => {
      if (l !== u[k]) expect(l.startsWith("when:") || l.startsWith("event zone:")).toBe(true);
    });
  });
});

describe("calendar.create_event kind", () => {
  const kind = () => calendarCreateEvent;
  const plan = () => kind().schema.parse(validPlan());
  const ps = () => ({ calendar: provider, mail: createFixtureMailProvider() });
  it("is the registered kind", () => expect(getPlanKind("calendar.create_event")).toBe(calendarCreateEvent));
  it("stores the event as is, and explains the plan as is", async () => {
    const ref = await kind().execute(plan(), "key1", ps());
    expect(kind().store(ref)).toBe(ref);
    const p = plan();
    expect(kind().explainPlan(p)).toBe(p);
  });
  it("recheck ok when slot free and etags unchanged", async () => {
    expect(await kind().recheck(plan(), ps())).toEqual({ ok: true });
  });
  it("recheck fails when an etag changed", async () => {
    provider.touchEvent("primary", "evt_standup");
    expect((await kind().recheck(plan(), ps())).ok).toBe(false);
  });
  it("recheck fails when the slot is busy", async () => {
    provider.addBusy("primary", { start: "2026-11-12T10:10:00.000Z", end: "2026-11-12T10:20:00.000Z" });
    expect((await kind().recheck(plan(), ps())).ok).toBe(false);
  });
  it("execute then lookupExisting by idempotency key", async () => {
    expect(await kind().lookupExisting(plan(), "key1", ps())).toEqual({ state: "absent" });
    const ref = await kind().execute(plan(), "key1", ps());
    expect(await kind().lookupExisting(plan(), "key1", ps())).toEqual({ state: "present", value: ref });
  });
  it("matches: the approved event under our key; never another id, title, instant or attendee set", async () => {
    const ref = await kind().execute(plan(), "key1", ps());
    const k = kind();
    expect(k.matches(plan(), "key1", ref)).toBe(true);
    expect(k.matches(plan(), "key2", ref)).toBe(false);
    expect(k.matches(plan(), "key1", { ...ref, id: "other" })).toBe(false);
    expect(k.matches(plan(), "key1", { ...ref, title: `${ref.title} ` })).toBe(false);
    expect(k.matches(plan(), "key1", { ...ref, start: "2026-11-12T10:00:01.000Z" })).toBe(false);
    expect(k.matches(plan(), "key1", { ...ref, end: "not a time" })).toBe(false);
    expect(k.matches(plan(), "key1", { ...ref, allDay: true })).toBe(false);
    expect(k.matches(plan(), "key1", { ...ref, attendees: [...ref.attendees, "x@example.com"] })).toBe(false);
    // Same instants in another offset, attendees in another case, order or with a repeat: still ours.
    const shifted = { ...ref, start: "2026-11-12T11:00:00+01:00", end: "2026-11-12T11:30:00+01:00" };
    expect(k.matches(plan(), "key1", { ...shifted, attendees: [...ref.attendees].reverse().map((a) => a.toUpperCase()) })).toBe(true);
    expect(k.matches(plan(), "key1", { ...ref, attendees: [...ref.attendees, ref.attendees[0]!] })).toBe(true);
  });
  it("matches: the organiser must be you; a recurring event never matches", async () => {
    const ref = await kind().execute(plan(), "key1", ps());
    const k = kind();
    expect(ref.organizerSelf).toBe(true); // the fixture marks its own writes
    expect(k.matches(plan(), "key1", { ...ref, organizerSelf: undefined })).toBe(false);
    expect(k.matches(plan(), "key1", { ...ref, organizerSelf: false })).toBe(false);
    expect(k.matches(plan(), "key1", { ...ref, recurring: true })).toBe(false);
  });
  it("matches: the owner as a self attendee counts only when the plan invited the owner", async () => {
    const ref = await kind().execute(plan(), "key1", ps());
    const k = kind();
    const p = plan();
    const withOwner = k.schema.parse(validPlan({}, { attendees: [...validPlan().event.attendees, "Me@Example.com"] }));
    // Google added the owner (dropped from attendees, kept as ownerEmail): plan without the owner matches.
    expect(k.matches(p, "key1", { ...ref, ownerEmail: "me@example.com" })).toBe(true);
    // The plan invited the owner explicitly: matches only with ownerEmail present.
    expect(k.matches(withOwner, "key1", { ...ref, ownerEmail: "me@example.com" })).toBe(true);
    expect(k.matches(withOwner, "key1", ref)).toBe(false);
    expect(k.matches(withOwner, "key1", { ...ref, ownerEmail: "other@example.com" })).toBe(false);
  });
});

describe("hashablePlan (decision 2)", () => {
  it("a calendar plan is returned unchanged and its hash is the hash of its canonical JSON, as before", () => {
    const p = validPlan();
    expect(hashablePlan(p)).toBe(p);
    expect(planHash(p)).toBe(createHash("sha256").update(canonicalJson(p), "utf8").digest("hex"));
    expect(planHash(validPlan())).toBe("14780c62ad4355dc81a4a2c9c421e26dafd920e7224d53b83af66ca39a6fda1e");
    expect(planHash(validPlan({}, { timeZone: "Europe/Berlin" }))).toBe(
      "3b02acb450a4f58a3cafe3e7fd7f82ddab927c6385ad182433158ce8d44a75ea",
    );
  });
  it("a draft plan loses draft.body and draft.bodyRemoved, nothing else", () => {
    const p = validDraftPlan();
    const { body: _body, ...rest } = p.draft;
    expect(hashablePlan(p)).toEqual({ ...p, draft: rest });
    expect(hashablePlan({ ...p, draft: { ...rest, bodyRemoved: true } })).toEqual({ ...p, draft: rest });
    expect(p.draft.body).toBe(DRAFT_BODY); // the input is not mutated
  });
  it("the hash of a draft plan with its body equals the hash with bodyRemoved and no body", () => {
    const p = validDraftPlan();
    const { body: _body, ...rest } = p.draft;
    expect(planHash({ ...p, draft: { ...rest, bodyRemoved: true } })).toBe(planHash(p));
  });
  it("anything else is returned unchanged", () => {
    for (const v of [null, "x", 1, [], { kind: "mail.create_draft_reply" }, { kind: "mail.create_draft_reply", draft: "x" }, { kind: "other", draft: { body: "b" } }]) {
      expect(hashablePlan(v)).toBe(v);
    }
  });
  it("createPlan stores the body in plan_json and hashes without it", () => {
    const c = ctxWith();
    const r = createPlan(c, { tool: "inbox_draft_reply", input: {}, plan: validDraftPlan() });
    const a = getAction(db, r.actionId)!;
    expect((a.plan_json as unknown as { draft: { body: string } }).draft.body).toBe(DRAFT_BODY);
    expect(r.planHash).toBe(planHash(validDraftPlan()));
    expect(r.planHash).toBe(createHash("sha256").update(canonicalJson(hashablePlan(validDraftPlan())), "utf8").digest("hex"));
  });
});
