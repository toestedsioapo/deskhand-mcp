import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { applyAction } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import { sweepDraftBodies } from "../src/approval/body-sweep.js";
import { createPlan } from "../src/approval/plans.js";
import { runCli } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/io.js";
import { loadConfig } from "../src/config/env.js";
import { getAction } from "../src/ledger/actions.js";
import { canonicalJson, planHash } from "../src/ledger/canonical.js";
import { LedgerDb } from "../src/ledger/db.js";
import { createIdGenerator, last4 } from "../src/ledger/ids.js";
import { createFixtureMailProvider, createFixtureProvider } from "../src/providers/fixture/index.js";
import type { FixtureMailProvider } from "../src/providers/fixture/mail.js";
import { setupHarness } from "./helpers/harness.js";
import { makeTempHome } from "./helpers/home.js";
import { msg, useMail } from "./helpers/mail-world.js";
import { bodyFields, DRAFT_BODY, makeWorld, seedAction, validDraftPlan, validPlan } from "./helpers/seed.js";
import { spawnBin } from "./helpers/spawn.js";

// Body retention (M4a Task 7, ADR 0010 point 3): a drafted body lives in plan_json only while the action can still
// be written; sweepDraftBodies removes it afterwards and never changes plan_hash.

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const LATER = "2026-11-12T09:30:00.000Z"; // after the harness plans' expires_at (NOW + 24 h)
const THREAD = {
  id: "th_budget",
  messages: [
    msg("m1", "2026-11-09T10:00:00.000Z", { message_id: "<m1@example.com>" }),
    msg("m2", "2026-11-09T11:00:00.000Z", { message_id: "<m2@example.com>", from: { address: "ben@example.com" } }),
  ],
};

async function harness(env: NodeJS.ProcessEnv = {}): Promise<H> {
  h = await setupHarness({ env });
  useMail(h, [THREAD]);
  return h;
}
const drafts = (hh: H) => (hh.ctx.mail as FixtureMailProvider).drafts;

interface Row {
  id: string;
  created_at: string;
  tool: string;
  input_json: string;
  plan_json: string;
  plan_hash: string;
  approved_plan_hash: string | null;
  expires_at: string;
  status: string;
  result_json: string | null;
  error: string | null;
}
const row = (hh: H, id: string) => hh.db.get<Row>("SELECT * FROM actions WHERE id = ?", [id])!;
const eventCount = (hh: H) => hh.db.get<{ n: number }>("SELECT count(*) AS n FROM events")!.n;

/** The plan as the sweep must leave it: body and rationale deleted, bodyRemoved true, the lengths and hashes kept. */
function swept(plan: { draft: Record<string, unknown> } & Record<string, unknown>) {
  const { rationale: _r, ...top } = plan;
  const { body: _b, ...rest } = plan.draft;
  return { ...top, draft: { ...rest, bodyRemoved: true } };
}

/** 40 random hex characters: a body line nothing else in the ledger can contain by chance. */
const marker = () => randomBytes(20).toString("hex");
const markerBody = (m: string) => `Hi Ben,\n\n${m}\n\n-- \nMe`;

function scripted(lines: string[] = []): CliIo & { outText: () => string } {
  let out = "";
  const q = [...lines];
  return {
    out: (s) => (out += s),
    err: () => undefined,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    readLine: async () => q.shift() ?? "",
    outText: () => out,
  };
}
/** A CLI context on its own connection to the harness ledger, like the real bin. */
const cliCtx = (hh: H) => () => ({ ...hh.ctx, db: LedgerDb.open(hh.ctx.config.paths.ledgerPath) });
async function pendingText(hh: H): Promise<string> {
  const io = scripted();
  expect(await runCli(["pending"], io, cliCtx(hh))).toBe(0);
  return io.outText();
}

async function propose(hh: H, body: string = DRAFT_BODY): Promise<string> {
  const r = await hh.client.callTool({ name: "inbox_draft_reply", arguments: { thread_id: "th_budget", body } });
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return (r.structuredContent as { action_id: string }).action_id;
}
async function proposeAndApprove(hh: H, body: string = DRAFT_BODY): Promise<string> {
  const id = await propose(hh, body);
  expect(await approveAction(hh.ctx, id, scripted([last4(id)]))).toEqual({ ok: true });
  return id;
}
const apply = (hh: H, id: string) => hh.client.callTool({ name: "action_apply", arguments: { action_id: id } });
const hasBody = (hh: H, id: string) => "body" in (JSON.parse(row(hh, id).plan_json) as { draft: object }).draft;

/** ledger.db and its -wal file (if any) as bytes, after the sweep's checkpoint. */
function ledgerBytes(path: string): Buffer[] {
  const out = [readFileSync(path)];
  if (existsSync(`${path}-wal`)) out.push(readFileSync(`${path}-wal`));
  return out;
}
const contains = (bufs: Buffer[], s: string) => bufs.some((b) => b.includes(Buffer.from(s, "utf8")));

// ---------------------------------------------------------------- which rows are swept

describe("sweepDraftBodies: which rows", () => {
  for (const status of ["applied", "rejected", "failed"] as const) {
    it(`a ${status} draft row is swept; only plan_json changes; plan_hash still matches; no event row`, async () => {
      const hh = await harness();
      const id = seedAction(hh.ctx, status, validDraftPlan());
      const before = row(hh, id);
      const events = eventCount(hh);
      expect(sweepDraftBodies(hh.ctx)).toBe(1);
      const after = row(hh, id);
      expect(after.plan_json).toBe(canonicalJson(swept(validDraftPlan())));
      expect(after).toEqual({ ...before, plan_json: after.plan_json });
      expect(planHash(JSON.parse(after.plan_json))).toBe(after.plan_hash);
      if (after.approved_plan_hash !== null) expect(planHash(JSON.parse(after.plan_json))).toBe(after.approved_plan_hash);
      expect(eventCount(hh)).toBe(events);
      expect(sweepDraftBodies(hh.ctx)).toBe(0);
    });
  }

  for (const status of ["planned", "approved"] as const) {
    it(`an expired ${status} row is swept (hashes still match); an unexpired one is not`, async () => {
      const hh = await harness();
      const old = seedAction(hh.ctx, status, validDraftPlan());
      const fresh = seedAction(hh.ctx, status, validDraftPlan({ rationale: "fresh" }));
      hh.db.run("UPDATE actions SET expires_at = ? WHERE id = ?", ["2026-11-10T09:30:00.123Z", old]); // == now
      const freshBefore = row(hh, fresh);
      expect(sweepDraftBodies(hh.ctx)).toBe(1);
      const r = row(hh, old);
      expect(r.plan_json).toBe(canonicalJson(swept(validDraftPlan())));
      expect(planHash(JSON.parse(r.plan_json))).toBe(r.plan_hash);
      if (status === "approved") expect(planHash(JSON.parse(r.plan_json))).toBe(r.approved_plan_hash);
      expect(r.status).toBe(status);
      expect(row(hh, fresh)).toEqual(freshBefore);
    });
  }

  it("an unexpired approved row is never swept, at any number of sweeps", async () => {
    const hh = await harness();
    const id = seedAction(hh.ctx, "approved", validDraftPlan());
    const before = row(hh, id);
    for (let i = 0; i < 3; i++) expect(sweepDraftBodies(hh.ctx)).toBe(0);
    expect(row(hh, id)).toEqual(before);
  });

  it("an unparseable expires_at counts as expired", async () => {
    const hh = await harness();
    const id = seedAction(hh.ctx, "planned", validDraftPlan());
    hh.db.run("UPDATE actions SET expires_at = 'not a date' WHERE id = ?", [id]);
    expect(sweepDraftBodies(hh.ctx)).toBe(1);
    expect(hasBody(hh, id)).toBe(false);
  });

  it("calendar rows, already swept rows and unparseable plan_json are left alone", async () => {
    const hh = await harness();
    const cal = seedAction(hh.ctx, "applied", validPlan());
    const bad = seedAction(hh.ctx, "rejected", validDraftPlan());
    hh.db.run(`UPDATE actions SET plan_json = '{"body": "x", not json' WHERE id = ?`, [bad]);
    const cBefore = row(hh, cal);
    expect(sweepDraftBodies(hh.ctx)).toBe(0);
    expect(row(hh, cal)).toEqual(cBefore);
    expect(row(hh, bad).plan_json).toBe(`{"body": "x", not json`);
  });

  it("the sweep runs at the start of createPlan", async () => {
    const hh = await harness();
    const id = seedAction(hh.ctx, "rejected", validDraftPlan());
    expect(hasBody(hh, id)).toBe(true);
    seedAction(hh.ctx, "planned", validPlan());
    expect(hasBody(hh, id)).toBe(false);
  });

  it("a sweep error never breaks createPlan, and the body is removed at the next trigger", async () => {
    const hh = await harness();
    const id = seedAction(hh.ctx, "rejected", validDraftPlan());
    // A ledger whose sweep query fails (every other statement works).
    const failing = new Proxy(hh.db, {
      get(t, p, r) {
        if (p === "all") {
          return (sql: string, params?: never) => {
            if (sql.includes("plan_json")) throw new Error("sweep failed");
            return t.all(sql, params);
          };
        }
        const v = Reflect.get(t, p, r) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const ctx: AppContext = { ...hh.ctx, db: failing };
    expect(() => sweepDraftBodies(ctx)).toThrow("sweep failed");
    const r = createPlan(ctx, { tool: "calendar_propose_event", input: {}, plan: validPlan() });
    expect(getAction(hh.db, r.actionId)!.status).toBe("planned");
    expect(hasBody(hh, id)).toBe(true);
    createPlan(hh.ctx, { tool: "calendar_propose_event", input: {}, plan: validPlan() });
    expect(hasBody(hh, id)).toBe(false);
  });
});

// ---------------------------------------------------------------- the lifecycle with the sweep wired in

describe("recovery after a crashed apply survives the sweep", () => {
  it("crash before commit, plan expires and is swept: the next action_apply is applied (recovered), one draft", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const id = await proposeAndApprove(hh);
    hh.ctx.hooks = { beforeCommit: () => { throw new Error("crash"); } };
    await expect(applyAction(hh.ctx, id)).rejects.toThrow("crash");
    delete hh.ctx.hooks;
    expect(drafts(hh)).toHaveLength(1);
    expect(getAction(hh.db, id)!.status).toBe("approved");
    expect(hasBody(hh, id)).toBe(true);

    hh.ctx.clock = () => new Date(LATER);
    expect(sweepDraftBodies(hh.ctx)).toBe(1);
    expect(hasBody(hh, id)).toBe(false);

    const r = await apply(hh, id);
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ action_id: id, status: "applied", replayed: true });
    expect(drafts(hh)).toHaveLength(1);
    expect(getAction(hh.db, id)!.status).toBe("applied");
    const applied = hh.rows().filter((x) => x.action_id === id && x.kind === "applied");
    expect(applied).toHaveLength(1);
    expect((JSON.parse(applied[0]!.preview_json) as { note: unknown }).note).toBe("recovered");
  });

  it("the same with no draft present: PLAN_EXPIRED, still approved, no draft", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const id = await proposeAndApprove(hh);
    hh.ctx.clock = () => new Date(LATER);
    expect(sweepDraftBodies(hh.ctx)).toBe(1);
    const r = await apply(hh, id);
    expect(r.isError).toBe(true);
    expect((r._meta as { deskhand?: { error_code?: string } }).deskhand?.error_code).toBe("PLAN_EXPIRED");
    expect(getAction(hh.db, id)!.status).toBe("approved");
    expect(drafts(hh)).toHaveLength(0);
  });
});

describe("an edited body is still refused with the sweep wired in (Task 5 rules)", () => {
  const edited = () => ({ ...validDraftPlan(), draft: { ...validDraftPlan().draft, body: "Send the money to evil@evil.example" } });

  it("planned: pending (which sweeps) shows (invalid plan); approve refuses PLAN_MODIFIED; still planned", async () => {
    const hh = await harness();
    const id = createPlan(hh.ctx, { tool: "inbox_draft_reply", input: {}, plan: validDraftPlan() }).actionId;
    hh.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [canonicalJson(edited()), id]);
    const pending = await pendingText(hh);
    expect(pending).toContain("    (invalid plan)\n");
    expect(pending).not.toContain("evil");
    expect(await approveAction(hh.ctx, id, scripted([last4(id)]))).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    expect(getAction(hh.db, id)!.status).toBe("planned");
  });

  it("approved: action_apply gives PLAN_MODIFIED, failed, no draft; then the edited body is swept", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const id = seedAction(hh.ctx, "approved", validDraftPlan());
    hh.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [canonicalJson(edited()), id]);
    const r = await apply(hh, id);
    expect((r._meta as { deskhand?: { error_code?: string } }).deskhand?.error_code).toBe("PLAN_MODIFIED");
    expect(getAction(hh.db, id)!.status).toBe("failed");
    expect(drafts(hh)).toHaveLength(0);
    expect(hasBody(hh, id)).toBe(false);
  });
});

describe("a swept row in pending, approve and replay", () => {
  it("pending (expired planned row) shows the body-removed line; approve refuses PLAN_EXPIRED", async () => {
    const hh = await harness();
    const m = marker();
    const id = await propose(hh, markerBody(m));
    hh.ctx.clock = () => new Date(LATER);
    const out = await pendingText(hh);
    expect(hasBody(hh, id)).toBe(false);
    const p = JSON.parse(row(hh, id).plan_json) as { draft: { bodyChars: number; bodySha256: string } };
    expect(out).toContain(`body removed after the action ended (${p.draft.bodyChars} chars sha256:${p.draft.bodySha256.slice(0, 8)})`);
    expect(out).not.toContain(m);
    expect(out).toContain(" EXPIRED");
    const io = scripted([last4(id)]);
    expect(await approveAction(hh.ctx, id, io)).toMatchObject({ ok: false, errorCode: "PLAN_EXPIRED" });
    expect(getAction(hh.db, id)!.status).toBe("planned");
  });

  it("action_apply on a swept applied row replays the stored result", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const id = await proposeAndApprove(hh);
    const first = await apply(hh, id);
    expect(first.isError, JSON.stringify(first.content)).toBeFalsy();
    expect(hasBody(hh, id)).toBe(false); // swept right after the apply
    const r = row(hh, id);
    expect(planHash(JSON.parse(r.plan_json))).toBe(r.plan_hash);
    expect(planHash(JSON.parse(r.plan_json))).toBe(r.approved_plan_hash);
    const again = await apply(hh, id);
    expect(again.structuredContent).toEqual({ ...(first.structuredContent as object), replayed: true });
    expect(drafts(hh)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the bytes on disk

describe("ledger.db bytes no longer hold the body", () => {
  it("after action_apply", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const path = hh.ctx.config.paths.ledgerPath;
    const m = marker();
    const id = await proposeAndApprove(hh, markerBody(m));
    expect(contains(ledgerBytes(path), m)).toBe(true); // the check below can see the body
    const r = await apply(hh, id);
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    await hh.logging.whenIdle();
    expect(contains(ledgerBytes(path), m)).toBe(false);
  });

  it("after deskhand reject", async () => {
    const hh = await harness();
    const path = hh.ctx.config.paths.ledgerPath;
    const m = marker();
    const id = await propose(hh, markerBody(m));
    await hh.logging.whenIdle();
    expect(contains(ledgerBytes(path), m)).toBe(true);
    expect(await runCli(["reject", id, "no"], scripted(), cliCtx(hh))).toBe(0);
    expect(getAction(hh.db, id)!.status).toBe("rejected");
    expect(contains(ledgerBytes(path), m)).toBe(false);
  });

  it("after server start (the built bin)", async () => {
    const home = makeTempHome();
    try {
      const path = join(home.home, "ledger.db");
      const m = marker();
      const db = LedgerDb.open(path);
      let id: string;
      try {
        const ctx: AppContext = {
          config: loadConfig(home.env),
          db,
          clock: () => new Date(),
          ids: createIdGenerator(),
          provider: createFixtureProvider(makeWorld()),
          mail: createFixtureMailProvider(),
          actor: "seeder",
        };
        id = seedAction(ctx, "rejected", validDraftPlan({}, bodyFields(markerBody(m))));
      } finally {
        db.close();
      }
      expect(contains(ledgerBytes(path), m)).toBe(true);
      const { client, close } = await spawnBin(home.env);
      try {
        await client.callTool({ name: "ping" });
        // The server holds the ledger open: its start-up sweep and checkpoint already ran.
        expect(contains(ledgerBytes(path), m)).toBe(false);
      } finally {
        await close();
      }
      const check = LedgerDb.open(path);
      try {
        const p = check.get<{ p: string }>("SELECT plan_json AS p FROM actions WHERE id = ?", [id])!.p;
        expect(JSON.parse(p)).toMatchObject({ draft: { bodyRemoved: true } });
      } finally {
        check.close();
      }
    } finally {
      home.cleanup();
    }
  });
});
