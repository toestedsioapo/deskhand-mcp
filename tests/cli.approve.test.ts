import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { loadConfig } from "../src/config/env.js";
import { getAction } from "../src/ledger/actions.js";
import { LedgerDb } from "../src/ledger/db.js";
import { queryEvents } from "../src/ledger/events.js";
import { createIdGenerator, last4 } from "../src/ledger/ids.js";
import { createFixtureProvider } from "../src/providers/fixture/provider.js";
import { makeTempHome } from "./helpers/home.js";
import { makeWorld, seedAction } from "./helpers/seed.js";
import { CLI_PATH } from "./helpers/spawn.js";

/**
 * The built bin, spawned for real. Tests cannot allocate a pty (no native
 * deps), so every run here has at least one non-TTY stream and must be refused
 * with NOT_A_TTY. The real-TTY path is the owner's manual check.
 */
let home: ReturnType<typeof makeTempHome>;
let id: string;

const withDb = <T>(fn: (db: LedgerDb) => T): T => {
  const db = LedgerDb.open(join(home.home, "ledger.db"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

beforeEach(() => {
  home = makeTempHome();
  id = withDb((db) => {
    // The bin uses the wall clock (no fixture path), so seed with it too.
    const ctx: AppContext = {
      config: loadConfig(home.env),
      db,
      clock: () => new Date(),
      ids: createIdGenerator(),
      provider: createFixtureProvider(makeWorld()),
      actor: "seeder",
    };
    return seedAction(ctx, "planned");
  });
});
afterEach(() => home.cleanup());

function expectRefusedInLedger(): void {
  withDb((db) => {
    const a = getAction(db, id)!;
    expect(a.status).toBe("planned");
    expect(a.approved_by).toBeNull();
    expect(a.approved_plan_hash).toBeNull();
    const kinds = queryEvents(db, { limit: 20, actionId: id })
      .reverse()
      .map((e) => `${e.kind}:${e.outcome}:${e.error_code}`);
    expect(kinds).toEqual(["plan_created:ok:null", "approve_refused:rejected:NOT_A_TTY", "cli_command:rejected:NOT_A_TTY"]);
    expect(queryEvents(db, { limit: 20, kind: "approved" })).toHaveLength(0);
  });
}

const PRELOAD = fileURLToPath(new URL("./helpers/faketty-preload.mjs", import.meta.url));

/**
 * The red-team reviewer's fake-TTY attack: a preload that makes both streams
 * look like a TTY and types the right last 4. Before the runtime guard this
 * approved the plan; now `approve` refuses before it prompts.
 */
describe("dist/cli.js approve: the fake-TTY preload attack (M2b red-team)", () => {
  const attack = (via: "execArgv" | "NODE_OPTIONS") => {
    const env = { ...home.env, RT_ANSWER: last4(id) };
    return spawnSync(
      process.execPath,
      via === "execArgv" ? ["--import", pathToFileURL(PRELOAD).href, CLI_PATH, "approve", id] : [CLI_PATH, "approve", id],
      {
        env: via === "NODE_OPTIONS" ? { ...env, NODE_OPTIONS: `--import ${pathToFileURL(PRELOAD).href}` } : env,
        encoding: "utf8",
        timeout: 20_000,
      },
    );
  };
  const expectUntrusted = (): void => {
    withDb((db) => {
      const a = getAction(db, id)!;
      expect(a.status).toBe("planned");
      expect(a.approved_by).toBeNull();
      expect(a.approved_plan_hash).toBeNull();
      const kinds = queryEvents(db, { limit: 20, actionId: id })
        .reverse()
        .map((e) => `${e.kind}:${e.outcome}:${e.error_code}`);
      expect(kinds).toEqual([
        "plan_created:ok:null",
        "approve_refused:rejected:UNTRUSTED_RUNTIME",
        "cli_command:rejected:UNTRUSTED_RUNTIME",
      ]);
      expect(queryEvents(db, { limit: 20, kind: "approved" })).toHaveLength(0);
    });
  };

  it("node --import <fake tty> dist/cli.js approve <id> -> exit 1, UNTRUSTED_RUNTIME, still planned", () => {
    const r = attack("execArgv");
    expect(r.stderr).toMatch(/UNTRUSTED_RUNTIME/);
    expect(r.status).toBe(1);
    expectUntrusted();
  });

  it("NODE_OPTIONS=--import <fake tty> -> exit 1, UNTRUSTED_RUNTIME, still planned", () => {
    const r = attack("NODE_OPTIONS");
    expect(r.stderr).toMatch(/UNTRUSTED_RUNTIME/);
    expect(r.status).toBe(1);
    expectUntrusted();
  });
});

describe("dist/cli.js approve", () => {
  it("piped stdin containing the correct last 4 -> exit 1, NOT_A_TTY, still planned, approve_refused logged", () => {
    const r = spawnSync(process.execPath, [CLI_PATH, "approve", id], {
      env: home.env,
      encoding: "utf8",
      input: `${last4(id)}\n`,
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^deskhand: NOT_A_TTY: [^\n]*\n$/);
    expect(r.stdout).toBe("");
    expectRefusedInLedger();
  });

  it("stdout redirected to a file, stdin inherited (not a TTY under vitest either, so a neither-TTY case) -> exit 1, NOT_A_TTY, nothing written to the file", () => {
    const outFile = join(home.home, "out.txt");
    const fd = openSync(outFile, "w");
    const r = (() => {
      try {
        return spawnSync(process.execPath, [CLI_PATH, "approve", id], {
          env: home.env,
          encoding: "utf8",
          stdio: ["inherit", fd, "pipe"],
          timeout: 20_000,
        });
      } finally {
        closeSync(fd);
      }
    })();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^deskhand: NOT_A_TTY: [^\n]*\n$/);
    expect(readFileSync(outFile, "utf8")).toBe("");
    expectRefusedInLedger();
  });

  it("stdin closed (ignored) -> exit 1, NOT_A_TTY", () => {
    const r = spawnSync(process.execPath, [CLI_PATH, "approve", id], {
      env: home.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("NOT_A_TTY");
    expectRefusedInLedger();
  });

  it("no id -> exit 2 usage, nothing logged", () => {
    const r = spawnSync(process.execPath, [CLI_PATH, "approve"], { env: home.env, encoding: "utf8", input: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: deskhand approve <action_id>");
    expect(r.stdout).toBe("");
    withDb((db) => expect(queryEvents(db, { limit: 20, tool: "cli:approve" })).toHaveLength(0));
  });
});
