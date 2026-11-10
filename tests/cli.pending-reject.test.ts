import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { applyAction } from "../src/approval/apply.js";
import { rejectAction } from "../src/approval/approve.js";
import { runCli } from "../src/cli/index.js";
import { stripControl, type CliIo } from "../src/cli/io.js";
import { loadConfig } from "../src/config/env.js";
import { getAction } from "../src/ledger/actions.js";
import { LedgerDb } from "../src/ledger/db.js";
import { queryEvents } from "../src/ledger/events.js";
import { createIdGenerator } from "../src/ledger/ids.js";
import { createFixtureProvider } from "../src/providers/fixture/provider.js";
import { CLI_PATH, runCliBin } from "./helpers/spawn.js";
import { makeTempHome } from "./helpers/home.js";
import { makeWorld, seedAction, validPlan } from "./helpers/seed.js";

const NOW = "2026-11-10T09:00:00.000Z";
const LONG_AGO = "2026-11-05T09:00:00.000Z";

let home: ReturnType<typeof makeTempHome>;
let db: LedgerDb;
let now: string;

function makeCtx(opener: () => LedgerDb = () => db, env: NodeJS.ProcessEnv = {}): AppContext {
  return {
    config: loadConfig({ ...home.env, ...env }),
    db: opener(),
    clock: () => new Date(now),
    ids: createIdGenerator(),
    provider: createFixtureProvider(makeWorld()),
    actor: "tester",
  };
}

function io(tty = false): CliIo & { outText: () => string; errText: () => string } {
  let out = "";
  let err = "";
  return {
    out: (s) => (out += s),
    err: (s) => (err += s),
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    readLine: () => Promise.reject(new Error("no input expected")),
    outText: () => out,
    errText: () => err,
  };
}

/** Each command gets its own connection to the same file, as the real CLI does (runCli closes it). */
const factory = (): AppContext => makeCtx(() => LedgerDb.open(join(home.home, "ledger.db")));

async function run(argv: string[], tty = false) {
  const i = io(tty);
  const code = await runCli(argv, i, factory);
  return { code, out: i.outText(), err: i.errText() };
}

const cliRows = (): ReturnType<typeof queryEvents> => queryEvents(db, { limit: 100, kind: "cli_command" }).reverse();

beforeEach(() => {
  home = makeTempHome();
  db = LedgerDb.open(join(home.home, "ledger.db"));
  now = NOW;
});
afterEach(() => {
  db.close();
  home.cleanup();
});

describe("stripControl", () => {
  it("removes escapes and control characters but keeps newline, tab and unicode", () => {
    expect(stripControl("a\u001b[31mred\u001b[0m")).toBe("ared");
    expect(stripControl("x\u001b]0;title\u0007y")).toBe("xy");
    expect(stripControl("x\u001b]0;title\u001b\\y")).toBe("xy");
    expect(stripControl("a\u0000b\u0008c")).toBe("abc");
    expect(stripControl("a\r\nb\tc")).toBe("a\nb\tc");
    expect(stripControl("café 日本 \u{1f600}")).toBe("café 日本 \u{1f600}");
    expect(stripControl("a\u009bb\u007fc")).toBe("abc");
  });

  it("removes line/paragraph separators and bidi/zero-width/BOM characters", () => {
    expect(stripControl("a\u2028b\u2029c")).toBe("abc");
    expect(stripControl("a\u200bb\u200fc\u202ad\u202ee\u2066f\u2069g\ufeffh")).toBe("abcdefgh");
  });

  it("src/cli/io.ts is pure ASCII (no literal invisible characters in its regexes)", () => {
    const text = readFileSync(new URL("../src/cli/io.ts", import.meta.url), "utf8");
    expect([...text].filter((c) => c.charCodeAt(0) > 0x7e && c !== "\n")).toEqual([]);
  });
});

describe("pending", () => {
  it("lists planned actions with id, tool, expiry, 8-hex hash and diff; one cli_command row", async () => {
    const a = seedAction(makeCtx(), "planned");
    const b = seedAction(makeCtx(), "planned", validPlan({}, { title: "Second" }));
    seedAction(makeCtx(), "approved");
    seedAction(makeCtx(), "rejected");
    const r = await run(["pending"]);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain(a);
    expect(r.out).toContain(b);
    expect(r.out).toContain("calendar_propose_event");
    expect(r.out).toContain("create event: Second");
    expect(r.out).toContain("2026-11-11T09:00:00.000Z");
    for (const id of [a, b]) {
      const hash = getAction(db, id)!.plan_hash;
      expect(r.out).toContain(hash.slice(0, 8));
      expect(r.out).not.toContain(hash.slice(0, 9));
    }
    expect(r.out.match(/act_/g)).toHaveLength(2);
    expect(r.out).not.toContain("EXPIRED");
    const rows = cliRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "cli:pending", outcome: "ok", error_code: null });
  });

  it("marks expired plans", async () => {
    now = LONG_AGO;
    const old = seedAction(makeCtx(), "planned");
    now = NOW;
    const r = await run(["pending"]);
    expect(r.out).toContain(old);
    expect(r.out).toContain("EXPIRED");
  });

  it("prints no escape for a title containing an escape sequence", async () => {
    seedAction(makeCtx(), "planned", validPlan({}, { title: "\u001b[2J evil" }));
    const r = await run(["pending"]);
    expect(r.out).toContain("evil");
    expect(r.out).not.toContain("\u001b");
  });

  it("empty ledger: friendly line, empty stderr, still logs", async () => {
    const r = await run(["pending"]);
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toContain("No pending");
    expect(cliRows()).toHaveLength(1);
  });
});

describe("reject", () => {
  it("works without a TTY: cli_no_tty, reason stored, rows rejected + cli_command", async () => {
    const id = seedAction(makeCtx(), "planned");
    const r = await run(["reject", id, "not", "needed"], false);
    expect(r.code).toBe(0);
    expect(getAction(db, id)).toMatchObject({
      status: "rejected",
      rejected_reason: "not needed",
      rejection_method: "cli_no_tty",
      rejected_at: NOW,
    });
    const kinds = queryEvents(db, { limit: 10, actionId: id })
      .reverse()
      .map((e) => `${e.kind}:${e.outcome}`);
    expect(kinds).toEqual(["plan_created:ok", "rejected:ok", "cli_command:ok"]);
    expect(cliRows()).toHaveLength(1);
    expect(cliRows()[0]!.tool).toBe("cli:reject");
  });

  it("records cli_tty with a TTY", async () => {
    const id = seedAction(makeCtx(), "planned");
    await run(["reject", id], true);
    expect(getAction(db, id)).toMatchObject({ status: "rejected", rejection_method: "cli_tty", rejected_reason: null });
  });

  it("stores the reason stripped of control characters", async () => {
    const id = seedAction(makeCtx(), "planned");
    await run(["reject", id, "bad \u001b[31mreason\u0007\u0000"]);
    expect(getAction(db, id)!.rejected_reason).toBe("bad reason");
  });

  it.each([
    ["rejected", "NOT_PENDING"],
    ["approved", "ALREADY_APPROVED"],
    ["applied", "NOT_PENDING"],
    ["failed", "NOT_PENDING"],
  ] as const)("refuses a %s plan with %s, status unchanged, one cli_command row", async (state, code) => {
    const id = seedAction(makeCtx(), state);
    const before = getAction(db, id)!;
    const r = await run(["reject", id, "why"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(code);
    expect(getAction(db, id)).toEqual(before);
    expect(cliRows()).toHaveLength(1);
    expect(cliRows()[0]).toMatchObject({ tool: "cli:reject", outcome: "rejected", error_code: code, action_id: id });
    expect(queryEvents(db, { limit: 50, kind: "rejected", actionId: id })).toHaveLength(0);
  });

  it("refuses an unknown id with UNKNOWN_ACTION and a null action_id", async () => {
    const r = await run(["reject", "act_NOPE"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("UNKNOWN_ACTION");
    expect(cliRows()).toHaveLength(1);
    expect(cliRows()[0]).toMatchObject({ outcome: "rejected", error_code: "UNKNOWN_ACTION", action_id: null });
  });

  it("without an id is a usage error (exit 2) and writes nothing", async () => {
    const r = await run(["reject"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
    expect(cliRows()).toHaveLength(0);
  });

  it("sanitises untrusted text in the printed output", async () => {
    const r = await run(["reject", "act_\u001b[2JX"]);
    expect(r.err + r.out).not.toContain("\u001b");
  });

  it("a rejected plan cannot then be applied", async () => {
    const ctx = makeCtx(undefined, { DESKHAND_ALLOW_WRITES: "1" });
    const id = seedAction(ctx, "planned");
    expect(rejectAction(ctx, id, "no", "cli_no_tty")).toEqual({ ok: true });
    expect(await applyAction(ctx, id)).toMatchObject({ ok: false, errorCode: "NOT_APPROVED" });
  });
});

describe("dist/cli.js", () => {
  it("4 concurrent rejects of one plan: exactly one wins", async () => {
    const id = seedAction(makeCtx(), "planned");
    db.close();
    const results = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<number | null>((resolve) => {
            const child = spawn(process.execPath, [CLI_PATH, "reject", id], { env: home.env, stdio: "ignore" });
            child.on("close", resolve);
          }),
      ),
    );
    db = LedgerDb.open(join(home.home, "ledger.db"));
    expect(results.filter((c) => c === 0)).toHaveLength(1);
    expect(results.filter((c) => c === 1)).toHaveLength(3);
    expect(queryEvents(db, { limit: 50, kind: "rejected", actionId: id })).toHaveLength(1);
    expect(getAction(db, id)!.status).toBe("rejected");
  }, 30_000);

  it.each([[["--help"]], [["-h"]], [["--version"]], [[]]])("%j with an invalid DESKHAND_HOME opens no ledger", (args) => {
    const bad = join(home.home, "does-not-exist");
    const env = { ...home.env, DESKHAND_HOME: bad, DESKHAND_PLAN_TTL_HOURS: "bogus" };
    const r = runCliBin(args, env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(existsSync(bad)).toBe(false);
  });

  it("unknown command exits 2 with empty stdout", () => {
    const r = runCliBin(["bogus"], home.env);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });

  it("a config error prints one 'deskhand:' line and exits 1", () => {
    const r = runCliBin(["pending"], { ...home.env, DESKHAND_PLAN_TTL_HOURS: "bogus" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^deskhand: DESKHAND_PLAN_TTL_HOURS/);
    expect(r.stdout).toBe("");
  });

  it("pending on an empty ledger: exit 0, empty stderr", () => {
    const r = runCliBin(["pending"], home.env);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});
