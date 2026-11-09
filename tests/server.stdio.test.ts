import { once } from "node:events";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/config/version.js";
import { LedgerDb } from "../src/ledger/db.js";
import { makeTempHome } from "./helpers/home.js";
import { runServerBin, spawnBin, spawnRaw } from "./helpers/spawn.js";

const expected = { ok: true, server: "deskhand-mcp", version: PACKAGE_VERSION };

function expectOneLineStartupError(stderr: string): void {
  expect(stderr).toMatch(/^deskhand-mcp: /);
  expect(stderr).not.toContain("    at ");
  expect(stderr.trimEnd().split("\n")).toHaveLength(1);
}

describe("stdio server (built bin)", () => {
  it("lists ping, ledger_query and action_explain, calls ping, survives bad input, stays silent on stderr", async () => {
    const { client, stderr, close } = await spawnBin();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping", "ledger_query", "action_explain"]);

      const ok = await client.callTool({ name: "ping" });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toEqual(expected);

      let rejected = false;
      try {
        const bad = await client.callTool({ name: "ping", arguments: { x: 1 } });
        rejected = bad.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      const again = await client.callTool({ name: "ping" });
      expect(again.structuredContent).toEqual(expected);
    } finally {
      await close();
    }
    expect(stderr()).toBe("");
  });

  it("exits 0 with empty stderr when stdin closes immediately", async () => {
    const child = spawnRaw();
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.stdin.end();
    const [code] = (await once(child, "close")) as [number | null];
    expect(code).toBe(0);
    expect(stderr).toBe("");
  });
});

describe("stdio server ledger", () => {
  it("writes one tool_call row for a ping, with empty stderr", async () => {
    const home = makeTempHome();
    try {
      const { client, stderr, close } = await spawnBin(home.env);
      try {
        await client.callTool({ name: "ping", arguments: {} });
      } finally {
        await close();
      }
      expect(stderr()).toBe("");
      const db = LedgerDb.open(join(home.home, "ledger.db"));
      try {
        const rows = db.all<{ tool: string; kind: string; outcome: string }>(
          "SELECT tool, kind, outcome FROM events",
        );
        expect(rows).toEqual([{ tool: "ping", kind: "tool_call", outcome: "ok" }]);
      } finally {
        db.close();
      }
    } finally {
      home.cleanup();
    }
  });

  it("starts with a fresh nonexistent DESKHAND_HOME and creates it", async () => {
    const home = makeTempHome();
    try {
      const fresh = join(home.home, "fresh", "nested");
      const { client, stderr, close } = await spawnBin({ ...home.env, DESKHAND_HOME: fresh });
      try {
        const r = await client.callTool({ name: "ping" });
        expect(r.structuredContent).toEqual(expected);
      } finally {
        await close();
      }
      expect(stderr()).toBe("");
      expect(existsSync(join(fresh, "ledger.db"))).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(fresh).mode & 0o777).toBe(0o700);
      }
    } finally {
      home.cleanup();
    }
  });
});

describe("stdio server fails closed at startup", () => {
  it("exits 1 on bad config without a stack trace", () => {
    const home = makeTempHome();
    try {
      const r = runServerBin({ ...home.env, DESKHAND_PLAN_TTL_HOURS: "0" });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("DESKHAND_PLAN_TTL_HOURS");
      expectOneLineStartupError(r.stderr);
    } finally {
      home.cleanup();
    }
  });

  it("exits 1 when DESKHAND_HOME's parent is a file", () => {
    const home = makeTempHome();
    try {
      const file = join(home.home, "a-file");
      writeFileSync(file, "x");
      const r = runServerBin({ ...home.env, DESKHAND_HOME: join(file, "home") });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expectOneLineStartupError(r.stderr);
    } finally {
      home.cleanup();
    }
  });

  it("exits 1 when the ledger is newer than this build", () => {
    const home = makeTempHome();
    try {
      const db = LedgerDb.open(join(home.home, "ledger.db"));
      db.exec("PRAGMA user_version = 99");
      db.close();
      const r = runServerBin(home.env);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("newer");
      expectOneLineStartupError(r.stderr);
    } finally {
      home.cleanup();
    }
  });
});
