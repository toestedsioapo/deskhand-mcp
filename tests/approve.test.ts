import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { applyAction } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import { runCli } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/io.js";
import { loadConfig } from "../src/config/env.js";
import { getAction, type ActionRow } from "../src/ledger/actions.js";
import { canonicalJson, planHash } from "../src/ledger/canonical.js";
import { LedgerDb } from "../src/ledger/db.js";
import { queryEvents, type EventRow } from "../src/ledger/events.js";
import { createIdGenerator, last4 } from "../src/ledger/ids.js";
import { createFixtureProvider, type FixtureProvider } from "../src/providers/fixture/provider.js";
import { makeTempHome } from "./helpers/home.js";
import { makeWorld, seedAction, validPlan } from "./helpers/seed.js";

const NOW = "2026-11-10T09:00:00.000Z";
const AFTER_EXPIRY = "2026-11-11T09:00:00.001Z"; // plans expire 24h after NOW

let home: ReturnType<typeof makeTempHome>;
let db: LedgerDb;
let provider: FixtureProvider;
let now: string;
let ctx: AppContext;

function makeCtx(over: Partial<AppContext> = {}, env: NodeJS.ProcessEnv = {}): AppContext {
  return {
    config: loadConfig({ ...home.env, ...env }),
    db,
    clock: () => new Date(now),
    ids: createIdGenerator(),
    provider,
    actor: "approver-os-user",
    ...over,
  };
}

type ScriptedIo = CliIo & { outText: () => string; errText: () => string; prompts: string[] };

/** A CliIo with TTY toggles and queued input lines; records every prompt issued. */
function scripted(
  opts: { stdin?: boolean; stdout?: boolean; lines?: string[]; execArgv?: string[]; nodeOptions?: string } = {},
): ScriptedIo {
  let out = "";
  let err = "";
  const lines = [...(opts.lines ?? [])];
  const prompts: string[] = [];
  return {
    out: (s) => (out += s),
    err: (s) => (err += s),
    stdinIsTTY: opts.stdin ?? true,
    stdoutIsTTY: opts.stdout ?? true,
    ...(opts.execArgv ? { execArgv: opts.execArgv } : {}),
    ...(opts.nodeOptions !== undefined ? { nodeOptions: opts.nodeOptions } : {}),
    async readLine(prompt) {
      prompts.push(prompt);
      const next = lines.shift();
      if (next === undefined) throw new Error("no input queued");
      return next;
    },
    outText: () => out,
    errText: () => err,
    prompts,
  };
}

const allEvents = (): EventRow[] => queryEvents(db, { limit: 500 }).reverse();
const eventsFor = (id: string): EventRow[] => queryEvents(db, { limit: 100, actionId: id }).reverse();
const approveCliRows = (): EventRow[] => queryEvents(db, { limit: 100, tool: "cli:approve", kind: "cli_command" });

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

/**
 * Asserts a refusal: the code, the row unchanged (status and all approval
 * columns), the last two ledger rows `approve_refused` then `cli_command`
 * (outcome rejected by default, or `outcome` when given), exactly one cli_command row for the call.
 */
async function expectRefused(
  id: string,
  io: ScriptedIo,
  code: string,
  opts: { existing?: boolean; promptIssued?: boolean; outcome?: "rejected" | "error" } = {},
) {
  const existing = opts.existing ?? true;
  const outcome = opts.outcome ?? "rejected";
  const before: ActionRow | undefined = getAction(db, id);
  const cliBefore = approveCliRows().length;
  const r = await approveAction(ctx, id, io);
  expect(r).toMatchObject({ ok: false, errorCode: code });
  expect(getAction(db, id)).toEqual(before);
  if (before) {
    expect(before.approved_by).toBeNull();
    expect(before.approved_at).toBeNull();
    expect(before.approval_method).toBeNull();
  }
  const [refused, cli] = allEvents().slice(-2);
  expect(refused).toMatchObject({
    kind: "approve_refused",
    tool: "cli:approve",
    outcome,
    error_code: code,
    action_id: existing ? id : null,
  });
  expect(cli).toMatchObject({
    kind: "cli_command",
    tool: "cli:approve",
    outcome,
    error_code: code,
    action_id: existing ? id : null,
  });
  expect(approveCliRows().length).toBe(cliBefore + 1);
  expect(queryEvents(db, { limit: 100, kind: "approved", actionId: id })).toHaveLength(0);
  if (!opts.promptIssued) {
    expect(io.prompts).toEqual([]);
    expect(io.outText()).toBe("");
  }
  return r;
}

describe("approveAction: TTY gate (first, before anything is printed or read)", () => {
  it("stdin piped with the correct last 4 queued -> NOT_A_TTY, the prompt is never issued", async () => {
    const id = seedAction(ctx, "planned");
    await expectRefused(id, scripted({ stdin: false, lines: [last4(id)] }), "NOT_A_TTY");
  });

  it("stdout redirected -> NOT_A_TTY", async () => {
    const id = seedAction(ctx, "planned");
    await expectRefused(id, scripted({ stdout: false, lines: [last4(id)] }), "NOT_A_TTY");
  });

  it("neither a TTY -> NOT_A_TTY", async () => {
    const id = seedAction(ctx, "planned");
    await expectRefused(id, scripted({ stdin: false, stdout: false, lines: [last4(id)] }), "NOT_A_TTY");
  });

  it("is checked before existence: an unknown id without a TTY is NOT_A_TTY with a null action_id", async () => {
    await expectRefused("act_NOPE", scripted({ stdin: false }), "NOT_A_TTY", { existing: false });
  });
});

describe("approveAction: untrusted runtime (--import/--require/--loader/--inspect)", () => {
  it.each([
    ["execArgv --import", { execArgv: ["--import", "./fake-tty.mjs"] }],
    ["execArgv --require=", { execArgv: ["--require=./x.cjs"] }],
    ["execArgv -r", { execArgv: ["-r", "./x.cjs"] }],
    ["execArgv --experimental-loader", { execArgv: ["--experimental-loader", "./l.mjs"] }],
    ["execArgv --inspect-brk", { execArgv: ["--inspect-brk=9229"] }],
    ["NODE_OPTIONS --import", { nodeOptions: "--import file:///x.mjs" }],
    ["NODE_OPTIONS --loader", { nodeOptions: "--max-old-space-size=512 --loader ./l.mjs" }],
  ])("%s, both streams TTY, right last 4 queued -> UNTRUSTED_RUNTIME, no prompt", async (_n, opts) => {
    const id = seedAction(ctx, "planned");
    const r = await expectRefused(id, scripted({ lines: [last4(id)], ...opts }), "UNTRUSTED_RUNTIME");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/--import|--require|-r|--experimental-loader|--inspect-brk|--loader/);
  });

  it("is checked after the TTY gate (a pipe with --import is still NOT_A_TTY)", async () => {
    const id = seedAction(ctx, "planned");
    await expectRefused(id, scripted({ stdin: false, execArgv: ["--import", "x.mjs"] }), "NOT_A_TTY");
  });

  it("clean execArgv and NODE_OPTIONS still approve", async () => {
    const id = seedAction(ctx, "planned");
    const io = scripted({ lines: [last4(id)], execArgv: ["--no-warnings"], nodeOptions: "--max-old-space-size=512" });
    expect(await approveAction(ctx, id, io)).toMatchObject({ ok: true });
  });
});

describe("approveAction: typed confirmation", () => {
  it("wrong last 4 -> CONFIRMATION_MISMATCH (after the prompt), status unchanged", async () => {
    const id = seedAction(ctx, "planned");
    const wrong = last4(id) === "ZZZZ" ? "YYYY" : "ZZZZ";
    const io = scripted({ lines: [wrong] });
    await expectRefused(id, io, "CONFIRMATION_MISMATCH", { promptIssued: true });
    expect(io.prompts).toHaveLength(1);
  });

  it.each([
    ["the full id", (id: string) => id],
    ["an empty line", () => ""],
    ["only whitespace", () => "   "],
    ["3 of the 4 characters", (id: string) => last4(id).slice(1)],
    ["the last 4 plus extra", (id: string) => `${last4(id)}X`],
  ])("typing %s -> CONFIRMATION_MISMATCH", async (_label, typed) => {
    const id = seedAction(ctx, "planned");
    await expectRefused(id, scripted({ lines: [typed(id)] }), "CONFIRMATION_MISMATCH", { promptIssued: true });
  });

  it("the last 4 of a DIFFERENT pending plan -> CONFIRMATION_MISMATCH", async () => {
    const id = seedAction(ctx, "planned");
    const other = seedAction(ctx, "planned", validPlan({}, { title: "Other" }));
    await expectRefused(id, scripted({ lines: [last4(other)] }), "CONFIRMATION_MISMATCH", { promptIssued: true });
    expect(getAction(db, other)!.status).toBe("planned");
  });

  it.each([
    ["sharp s (U+00DF, uppercases to SS)", "\u00df\u00df"],
    ["long s (U+017F, uppercases to S)", "\u017f\u017f\u017f\u017f"],
    ["mixed long s and ASCII", "S\u017fS\u017f"],
  ])("non-ASCII input whose Unicode uppercase is the last 4 never matches: %s", async (_label, typed) => {
    const id = "act_01JC3Z8K4V7Q2W9X5R6T1NSSSS";
    const c = makeCtx({ ids: { newActionId: () => id } });
    expect(seedAction(c, "planned")).toBe(id);
    expect(typed.toUpperCase()).toBe("SSSS"); // the trap is real: String#toUpperCase maps these to ASCII S
    await expectRefused(id, scripted({ lines: [typed] }), "CONFIRMATION_MISMATCH", { promptIssued: true });
  });

  it("no line could be read (EOF / read error) -> CONFIRMATION_MISMATCH", async () => {
    const id = seedAction(ctx, "planned");
    await expectRefused(id, scripted({ lines: [] }), "CONFIRMATION_MISMATCH", { promptIssued: true });
  });

  it("the typed confirmation text is never stored in the ledger", async () => {
    const id = seedAction(ctx, "planned");
    const typed = "TYPED-SECRET-9Q";
    await approveAction(ctx, id, scripted({ lines: [typed] }));
    const dump = JSON.stringify(db.all("SELECT * FROM events")) + JSON.stringify(db.all("SELECT * FROM actions"));
    expect(dump).not.toContain(typed);
  });
});

describe("approveAction: state checks", () => {
  it("unknown id -> UNKNOWN_ACTION with a null action_id", async () => {
    await expectRefused("act_01JC3Z8K4V7Q2W9X5R6T1N0BHM", scripted({ lines: ["0BHM"] }), "UNKNOWN_ACTION", {
      existing: false,
    });
  });

  it("expired plan -> PLAN_EXPIRED", async () => {
    const id = seedAction(ctx, "planned");
    now = AFTER_EXPIRY;
    await expectRefused(id, scripted({ lines: [last4(id)] }), "PLAN_EXPIRED");
  });

  it("exactly at expires_at counts as expired (fails closed)", async () => {
    const id = seedAction(ctx, "planned");
    now = getAction(db, id)!.expires_at;
    await expectRefused(id, scripted({ lines: [last4(id)] }), "PLAN_EXPIRED");
  });

  it("unparseable expires_at counts as expired (fails closed)", async () => {
    const id = seedAction(ctx, "planned");
    db.run("UPDATE actions SET expires_at = 'not-a-date' WHERE id = ?", [id]);
    await expectRefused(id, scripted({ lines: [last4(id)] }), "PLAN_EXPIRED");
  });

  it("already approved -> ALREADY_APPROVED, approval columns untouched", async () => {
    const id = seedAction(ctx, "approved");
    const before = getAction(db, id)!;
    const r = await approveAction(ctx, id, scripted({ lines: [last4(id)] }));
    expect(r).toMatchObject({ ok: false, errorCode: "ALREADY_APPROVED" });
    expect(getAction(db, id)).toEqual(before);
    expect(allEvents().slice(-2).map((e) => `${e.kind}:${e.error_code}`)).toEqual([
      "approve_refused:ALREADY_APPROVED",
      "cli_command:ALREADY_APPROVED",
    ]);
  });

  it.each(["rejected", "failed", "applied"] as const)("%s -> NOT_PENDING, row unchanged", async (state) => {
    const id = seedAction(ctx, state);
    const before = getAction(db, id)!;
    const io = scripted({ lines: [last4(id)] });
    const r = await approveAction(ctx, id, io);
    expect(r).toMatchObject({ ok: false, errorCode: "NOT_PENDING" });
    expect(getAction(db, id)).toEqual(before);
    expect(io.prompts).toEqual([]);
    expect(eventsFor(id).slice(-2).map((e) => `${e.kind}:${e.outcome}:${e.error_code}`)).toEqual([
      "approve_refused:rejected:NOT_PENDING",
      "cli_command:rejected:NOT_PENDING",
    ]);
  });

  it("tampered before approval: plan_json edited after planning -> PLAN_MODIFIED, still planned", async () => {
    const id = seedAction(ctx, "planned");
    db.run("UPDATE actions SET plan_json = replace(plan_json, '\"Sync\"', '\"Evil\"') WHERE id = ?", [id]);
    await expectRefused(id, scripted({ lines: [last4(id)] }), "PLAN_MODIFIED");
    expect(getAction(db, id)!.status).toBe("planned");
  });

  it("plan_hash edited -> PLAN_MODIFIED", async () => {
    const id = seedAction(ctx, "planned");
    db.run("UPDATE actions SET plan_hash = ? WHERE id = ?", ["0".repeat(64), id]);
    await expectRefused(id, scripted({ lines: [last4(id)] }), "PLAN_MODIFIED");
  });

  it("unparseable plan_json -> PLAN_MODIFIED", async () => {
    const id = seedAction(ctx, "planned");
    db.run("UPDATE actions SET plan_json = '{not json' WHERE id = ?", [id]);
    const raw = () => db.get("SELECT * FROM actions WHERE id = ?", [id]); // getAction would throw on the bad JSON
    const before = raw();
    const io = scripted({ lines: [last4(id)] });
    expect(await approveAction(ctx, id, io)).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    expect(raw()).toEqual(before);
    expect(io.prompts).toEqual([]);
    expect(allEvents().slice(-2).map((e) => `${e.kind}:${e.error_code}`)).toEqual([
      "approve_refused:PLAN_MODIFIED",
      "cli_command:PLAN_MODIFIED",
    ]);
  });

  it.each([
    ["an unknown kind", { kind: "calendar.delete_everything", event: { title: "x" } }],
    ["a known kind with an invalid shape", { ...validPlan(), observed: { slotFree: false, etags: {} } }],
  ])("hash-consistent stored plan with %s -> INTERNAL before the prompt, status unchanged", async (_label, plan) => {
    const id = seedAction(ctx, "planned");
    db.run("UPDATE actions SET plan_json = ?, plan_hash = ? WHERE id = ?", [canonicalJson(plan), planHash(plan), id]);
    const io = scripted({ lines: [last4(id)] });
    await expectRefused(id, io, "INTERNAL", { outcome: "error" });
    expect(getAction(db, id)!.status).toBe("planned");
  });

  it("id collision (defensive): two pending rows forced to share the last 4 -> ID_COLLISION for both", async () => {
    const a = seedAction(ctx, "planned");
    const b = `act_${"0".repeat(22)}${a.slice(-4)}`;
    db.run(
      `INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status)
       SELECT ?, created_at, tool, input_json, plan_json, plan_hash, expires_at, 'planned' FROM actions WHERE id = ?`,
      [b, a],
    );
    await expectRefused(a, scripted({ lines: [last4(a)] }), "ID_COLLISION");
    await expectRefused(b, scripted({ lines: [last4(b)] }), "ID_COLLISION");
  });

  it("a collision with an APPROVED plan also counts; one with an applied plan does not", async () => {
    const a = seedAction(ctx, "planned");
    const twin = (prefix: string, status: string) => {
      const id = `act_${prefix.repeat(22)}${a.slice(-4)}`;
      db.run(
        `INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status)
         SELECT ?, created_at, tool, input_json, plan_json, plan_hash, expires_at, ? FROM actions WHERE id = ?`,
        [id, status, a],
      );
    };
    twin("1", "applied");
    twin("2", "rejected");
    expect(await approveAction(ctx, a, scripted({ lines: [last4(a)] }))).toEqual({ ok: true });
    // a is approved now (pending until applied); a new planned twin collides with it.
    twin("3", "planned");
    await expectRefused(`act_${"3".repeat(22)}${a.slice(-4)}`, scripted({ lines: [last4(a)] }), "ID_COLLISION");
  });
});

describe("approveAction: check order", () => {
  it("status before expiry: approved and expired -> ALREADY_APPROVED", async () => {
    const id = seedAction(ctx, "approved");
    now = AFTER_EXPIRY;
    const r = await approveAction(ctx, id, scripted({ lines: [last4(id)] }));
    expect(r).toMatchObject({ errorCode: "ALREADY_APPROVED" });
  });

  it("expiry before hash: expired and tampered -> PLAN_EXPIRED", async () => {
    const id = seedAction(ctx, "planned");
    db.run("UPDATE actions SET plan_hash = ? WHERE id = ?", ["0".repeat(64), id]);
    now = AFTER_EXPIRY;
    await expectRefused(id, scripted({ lines: [last4(id)] }), "PLAN_EXPIRED");
  });

  it("hash before collision: tampered and colliding -> PLAN_MODIFIED", async () => {
    const a = seedAction(ctx, "planned");
    db.run(
      `INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status)
       SELECT ?, created_at, tool, input_json, plan_json, plan_hash, expires_at, 'planned' FROM actions WHERE id = ?`,
      [`act_${"0".repeat(22)}${a.slice(-4)}`, a],
    );
    db.run("UPDATE actions SET plan_hash = ? WHERE id = ?", ["0".repeat(64), a]);
    await expectRefused(a, scripted({ lines: [last4(a)] }), "PLAN_MODIFIED");
  });

  it("hash before plan validity: tampered and of unknown kind -> PLAN_MODIFIED", async () => {
    const id = seedAction(ctx, "planned");
    db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [canonicalJson({ kind: "nope" }), id]);
    await expectRefused(id, scripted({ lines: [last4(id)] }), "PLAN_MODIFIED");
  });

  it("plan validity (5b) before collision: unknown kind and colliding -> INTERNAL", async () => {
    const a = seedAction(ctx, "planned");
    const plan = { kind: "nope" };
    db.run("UPDATE actions SET plan_json = ?, plan_hash = ? WHERE id = ?", [canonicalJson(plan), planHash(plan), a]);
    db.run(
      `INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status)
       SELECT ?, created_at, tool, input_json, plan_json, plan_hash, expires_at, 'planned' FROM actions WHERE id = ?`,
      [`act_${"0".repeat(22)}${a.slice(-4)}`, a],
    );
    await expectRefused(a, scripted({ lines: [last4(a)] }), "INTERNAL", { outcome: "error" });
  });
});

describe("approveAction: happy path", () => {
  it("correct last 4 in lowercase with surrounding spaces -> approved with every approval column", async () => {
    const id = seedAction(ctx, "planned", validPlan({}, { title: "Board \u001b[31mred\u001b[0m\nsecond line" }));
    const io = scripted({ lines: [`  ${last4(id).toLowerCase()}  `] });
    const r = await approveAction(ctx, id, io);
    expect(r).toEqual({ ok: true });

    const a = getAction(db, id)!;
    expect(a).toMatchObject({
      status: "approved",
      approved_by: "approver-os-user",
      approval_method: "cli_tty",
      approved_at: NOW,
    });
    expect(a.approved_plan_hash).toBe(a.plan_hash);

    expect(eventsFor(id).map((e) => `${e.kind}:${e.outcome}:${e.error_code}:${e.tool}`)).toEqual([
      "plan_created:ok:null:calendar_propose_event",
      "approved:ok:null:cli:approve",
      "cli_command:ok:null:cli:approve",
    ]);
    expect(approveCliRows()).toHaveLength(1);

    const out = io.outText();
    expect(out).toContain(id);
    expect(out).toContain("create event: Board red");
    expect(out).toContain("second line");
    expect(out).toContain("when: Thu 12 Nov 2026, 10:00 to 10:30 UTC (UTC)"); // the harness pins DESKHAND_TIMEZONE=UTC
    expect(out).toContain("utc: 2026-11-12T10:00:00.000Z to 2026-11-12T10:30:00.000Z");
    expect(out).toContain("will email 3 attendees");
    expect(out).toContain(a.plan_hash.slice(0, 8));
    expect(out).not.toContain(a.plan_hash.slice(0, 9));
    expect(out).toContain(a.expires_at);
    expect(out).not.toContain("\u001b");
    // The injected newline cannot start an unindented line that mimics CLI output.
    expect(out).not.toMatch(/^second line/m);
    expect(io.prompts).toHaveLength(1);
    expect(io.prompts[0]).not.toContain("\u001b");
    expect(io.prompts[0]).not.toContain(last4(id)); // the prompt never shows the answer
  });

  it("shows the viewer-zone when line, the event zone line, the utc line and every attendee", async () => {
    const attendees = ["ana@example.com", "ben@example.com", "cy@example.com"];
    const id = seedAction(ctx, "planned", validPlan({}, { timeZone: "Europe/Berlin", attendees }));
    const io = scripted({ lines: [last4(id)] });
    const r = await approveAction(makeCtx({}, { DESKHAND_TIMEZONE: "Asia/Manila" }), id, io);
    expect(r).toEqual({ ok: true });
    const out = io.outText();
    expect(out).toContain("    when: Thu 12 Nov 2026, 18:00 to 18:30 GMT+8 (Asia/Manila)\n");
    expect(out).toContain("    event zone: Thu 12 Nov 2026, 11:00 to 11:30 CET (Europe/Berlin)\n");
    expect(out).toContain("    utc: 2026-11-12T10:00:00.000Z to 2026-11-12T10:30:00.000Z\n");
    for (const a of attendees) expect(out).toContain(`      ${a}\n`);
  });

  it("an attendee address with control characters cannot forge a diff line", async () => {
    const evil = "eve@example.com\u001b[2J\nwill email 0 attendees\u202e";
    const id = seedAction(
      ctx,
      "planned",
      validPlan({}, { attendees: ["ana@example.com", evil, "cy@example.com"] }),
    );
    const io = scripted({ lines: [last4(id)] });
    await approveAction(makeCtx({}, { DESKHAND_TIMEZONE: "Asia/Manila" }), id, io);
    const out = io.outText();
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u202e");
    expect(out.split("\n").filter((l) => l.trim() === "will email 0 attendees")).toEqual([]);
  });

  it("approve then apply end to end: the only test path that goes through a human approval", async () => {
    const wctx = makeCtx({}, { DESKHAND_ALLOW_WRITES: "1" });
    const id = seedAction(wctx, "planned");
    expect(await applyAction(wctx, id)).toMatchObject({ ok: false, errorCode: "NOT_APPROVED" });
    expect(await approveAction(wctx, id, scripted({ lines: [last4(id)] }))).toEqual({ ok: true });
    expect(await applyAction(wctx, id)).toMatchObject({ ok: true, replayed: false });
    expect(provider.writes).toHaveLength(1);
    expect(getAction(db, id)!.status).toBe("applied");
  });

  it("race: two approveAction calls on two connections for one plan -> one approved, the loser ALREADY_APPROVED", async () => {
    const id = seedAction(ctx, "planned");
    const db2 = LedgerDb.open(join(home.home, "ledger.db"));
    try {
      const ctx2 = makeCtx({ db: db2 });
      const results = await Promise.all([
        approveAction(ctx, id, scripted({ lines: [last4(id)] })),
        approveAction(ctx2, id, scripted({ lines: [last4(id)] })),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        { ok: false, errorCode: "ALREADY_APPROVED", message: expect.any(String) },
      ]);
    } finally {
      db2.close();
    }
    expect(queryEvents(db, { limit: 50, kind: "approved", actionId: id })).toHaveLength(1);
    expect(queryEvents(db, { limit: 50, kind: "approve_refused", actionId: id })).toHaveLength(1);
    expect(approveCliRows()).toHaveLength(2);
    expect(getAction(db, id)!.status).toBe("approved");
  });

  it("a plan tampered while the human is typing is refused by the CAS (PLAN_MODIFIED), still planned", async () => {
    const id = seedAction(ctx, "planned");
    const io = scripted();
    io.readLine = async () => {
      db.run("UPDATE actions SET plan_json = replace(plan_json, '\"Sync\"', '\"Evil\"') WHERE id = ?", [id]);
      return last4(id);
    };
    const r = await approveAction(ctx, id, io);
    expect(r).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    expect(getAction(db, id)).toMatchObject({ status: "planned", approved_by: null, approved_plan_hash: null });
    expect(allEvents().slice(-2).map((e) => e.kind)).toEqual(["approve_refused", "cli_command"]);
  });

  it("a plan that expires while the human is typing is refused by the CAS (PLAN_EXPIRED)", async () => {
    const id = seedAction(ctx, "planned");
    const io = scripted();
    io.readLine = async () => {
      now = AFTER_EXPIRY;
      return last4(id);
    };
    expect(await approveAction(ctx, id, io)).toMatchObject({ ok: false, errorCode: "PLAN_EXPIRED" });
    expect(getAction(db, id)!.status).toBe("planned");
  });

  it("a plan rejected while the human is typing is refused by the CAS (NOT_PENDING)", async () => {
    const id = seedAction(ctx, "planned");
    const io = scripted();
    io.readLine = async () => {
      db.run("UPDATE actions SET status = 'rejected', rejected_at = ?, rejection_method = 'cli_no_tty' WHERE id = ?", [
        NOW,
        id,
      ]);
      return last4(id);
    };
    expect(await approveAction(ctx, id, io)).toMatchObject({ ok: false, errorCode: "NOT_PENDING" });
    expect(getAction(db, id)).toMatchObject({ status: "rejected", approved_by: null });
  });
});

describe("approveAction: untrusted id text", () => {
  it("an id with escapes and huge length is stored and echoed stripped and capped", async () => {
    const evil = `act_\u001b[2J\u001b]0;pwn\u0007\n\u2028${"X".repeat(5000)}`;
    const r = await approveAction(ctx, evil, scripted({ stdin: false }));
    expect(r).toMatchObject({ ok: false, errorCode: "NOT_A_TTY" });
    expect(r.ok ? "" : r.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(r.ok ? 0 : r.message.length).toBeLessThan(300);
    for (const row of db.all<{ preview_json: string }>("SELECT preview_json FROM events")) {
      const p = JSON.parse(row.preview_json) as { input: { action_id: string } };
      expect(p.input.action_id).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      expect(p.input.action_id.length).toBeLessThanOrEqual(64);
      expect(p.input.action_id.startsWith("act_")).toBe(true);
    }
  });
});

describe("runCli approve", () => {
  const factory = (): AppContext => makeCtx({ db: LedgerDb.open(join(home.home, "ledger.db")) });

  it("exit 0 on approval, prints the result to stdout", async () => {
    const id = seedAction(ctx, "planned");
    const io = scripted({ lines: [last4(id)] });
    expect(await runCli(["approve", id], io, factory)).toBe(0);
    expect(io.outText()).toContain(`Approved ${id}`);
    expect(io.errText()).toBe("");
    expect(getAction(db, id)!.status).toBe("approved");
  });

  it("exit 1 on refusal, one single-line stderr message naming the code, nothing on stdout", async () => {
    const id = seedAction(ctx, "planned");
    const io = scripted({ stdin: false, lines: [last4(id)] });
    expect(await runCli(["approve", id], io, factory)).toBe(1);
    expect(io.errText()).toMatch(/^deskhand: NOT_A_TTY: [^\n]*\n$/);
    expect(io.outText()).toBe("");
    expect(io.prompts).toEqual([]);
  });

  it("CONFIRMATION_MISMATCH exits 1 and the stderr line does not echo what was typed", async () => {
    const id = seedAction(ctx, "planned");
    const io = scripted({ lines: ["WR\u001b[2JONG"] });
    expect(await runCli(["approve", id], io, factory)).toBe(1);
    expect(io.errText()).toMatch(/^deskhand: CONFIRMATION_MISMATCH: [^\n]*\n$/);
    expect(io.errText().replaceAll(id, "")).not.toContain("WR"); // the (random) id itself may contain "WR"
  });

  it.each([[["approve"]], [["approve", ""]], [["approve", "a", "b"]]])(
    "%j is a usage error (exit 2), opens no ledger, reads nothing",
    async (argv) => {
      const io = scripted({ lines: ["x"] });
      const code = await runCli(argv, io, () => {
        throw new Error("ctxFactory must not be called");
      });
      expect(code).toBe(2);
      expect(io.errText()).toContain("usage: deskhand approve <action_id>");
      expect(io.prompts).toEqual([]);
    },
  );

  it("there is no bypass flag: --yes / --force are treated as extra args (usage error), never as approval", async () => {
    const id = seedAction(ctx, "planned");
    for (const flag of ["--yes", "--force", "-y"]) {
      const io = scripted({ stdin: false });
      expect(await runCli(["approve", id, flag], io, factory)).toBe(2);
      expect(await runCli(["approve", flag, id], io, factory)).toBe(2);
    }
    expect(getAction(db, id)!.status).toBe("planned");
  });
});
