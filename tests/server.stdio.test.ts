import { once } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { loadConfig } from "../src/config/env.js";
import { PACKAGE_VERSION } from "../src/config/version.js";
import { getAction } from "../src/ledger/actions.js";
import { LedgerDb } from "../src/ledger/db.js";
import { queryEvents } from "../src/ledger/events.js";
import { createIdGenerator } from "../src/ledger/ids.js";
import { createFixtureProvider } from "../src/providers/fixture/provider.js";
import { makeTempHome } from "./helpers/home.js";
import { makeWorld, SEED_NOW, seedAction } from "./helpers/seed.js";
import { runServerBin, spawnBin, spawnRaw } from "./helpers/spawn.js";

const expected = { ok: true, server: "deskhand-mcp", version: PACKAGE_VERSION };

function expectOneLineStartupError(stderr: string): void {
  expect(stderr).toMatch(/^deskhand-mcp: /);
  expect(stderr).not.toContain("    at ");
  expect(stderr.trimEnd().split("\n")).toHaveLength(1);
}

describe("stdio server (built bin)", () => {
  it("lists ping, ledger_query, action_explain and action_apply, calls ping, survives bad input, stays silent on stderr", async () => {
    const { client, stderr, close } = await spawnBin();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping", "ledger_query", "action_explain", "action_apply"]);

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

describe("stdio server with no provider configured", () => {
  it("starts, answers ping, and refuses action_apply with PROVIDER_NOT_CONFIGURED (rejected row)", async () => {
    const home = makeTempHome();
    try {
      const { client, stderr, close } = await spawnBin({ ...home.env, DESKHAND_ALLOW_WRITES: "1" });
      try {
        const ok = await client.callTool({ name: "ping" });
        expect(ok.structuredContent).toEqual(expected);
        const r = await client.callTool({ name: "action_apply", arguments: { action_id: "act_01JC3Z8K4V7Q2W9X5R6T1N0BHM" } });
        expect(r.isError).toBe(true);
        const meta = r._meta as { deskhand?: { error_code?: string } } | undefined;
        expect(meta?.deskhand?.error_code).toBe("PROVIDER_NOT_CONFIGURED");
      } finally {
        await close();
      }
      expect(stderr()).toBe("");
      const db = LedgerDb.open(join(home.home, "ledger.db"));
      try {
        const rows = db.all<{ tool: string; kind: string; outcome: string; error_code: string | null }>(
          "SELECT tool, kind, outcome, error_code FROM events ORDER BY id",
        );
        expect(rows).toEqual([
          { tool: "ping", kind: "tool_call", outcome: "ok", error_code: null },
          { tool: "action_apply", kind: "apply_refused", outcome: "rejected", error_code: "PROVIDER_NOT_CONFIGURED" },
          { tool: "action_apply", kind: "tool_call", outcome: "rejected", error_code: "PROVIDER_NOT_CONFIGURED" },
        ]);
      } finally {
        db.close();
      }
    } finally {
      home.cleanup();
    }
  });

  it("exits 1 with one line when DESKHAND_FIXTURE is set without DESKHAND_PROVIDER=fixture", () => {
    const home = makeTempHome();
    try {
      const r = runServerBin({ ...home.env, DESKHAND_FIXTURE: join(home.home, "world.json") });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("set DESKHAND_PROVIDER=fixture");
      expectOneLineStartupError(r.stderr);
    } finally {
      home.cleanup();
    }
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

/**
 * Raw JSON-RPC over the built bin's stdio, so the test controls exactly when
 * stdin ends. Messages are newline-delimited JSON (MCP stdio framing).
 */
function rawSession(env: NodeJS.ProcessEnv) {
  const child = spawnRaw(env);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const closed = once(child, "close") as Promise<[number | null]>;
  const messages = (): Record<string, unknown>[] =>
    stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return {
    child,
    send: (m: unknown) => void child.stdin.write(`${JSON.stringify(m)}\n`),
    response: (id: number) => messages().find((m) => m["id"] === id),
    async waitFor(id: number, ms = 10_000): Promise<void> {
      const until = Date.now() + ms;
      while (!messages().some((m) => m["id"] === id)) {
        if (Date.now() > until) throw new Error(`no response ${id}; stderr: ${stderr}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    stderr: () => stderr,
    closed,
  };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0" } },
};
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };
const applyRequest = (id: number, actionId: string) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "action_apply", arguments: { action_id: actionId } },
});

/**
 * A temp home with an approved action and a slow fixture world (every provider
 * call waits 300 ms; writes go to writes.jsonl). The DB is closed before the
 * bin is spawned.
 */
function seedSlowApproved(home: ReturnType<typeof makeTempHome>) {
  const fixture = join(home.home, "world.json");
  writeFileSync(fixture, JSON.stringify(makeWorld({ settings: { latency_ms: 300, write_log: "writes.jsonl" } })));
  const db = LedgerDb.open(join(home.home, "ledger.db"));
  let id: string;
  try {
    const ctx: AppContext = {
      config: loadConfig(home.env),
      db,
      clock: () => new Date(SEED_NOW), // the bin's clock is the fixture's `now`
      ids: createIdGenerator(),
      provider: createFixtureProvider(makeWorld()),
      actor: "seeder",
    };
    id = seedAction(ctx, "approved");
  } finally {
    db.close();
  }
  return {
    id,
    env: { ...home.env, DESKHAND_PROVIDER: "fixture", DESKHAND_FIXTURE: fixture, DESKHAND_ALLOW_WRITES: "1" },
    writeLines: (): string[] => {
      const path = join(home.home, "writes.jsonl");
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : [];
    },
    ledger: <T>(fn: (db: LedgerDb) => T): T => {
      const d = LedgerDb.open(join(home.home, "ledger.db"));
      try {
        return fn(d);
      } finally {
        d.close();
      }
    },
  };
}

describe("stdio server shuts down gracefully on stdin close", () => {
  it("finishes a pending action_apply write, flushes its response and logs it before exiting 0", async () => {
    const home = makeTempHome();
    try {
      const seed = seedSlowApproved(home);
      const s = rawSession(seed.env);
      s.send(INITIALIZE);
      s.send(INITIALIZED);
      s.send(applyRequest(2, seed.id));
      s.child.stdin.end();
      const [code] = await s.closed;

      expect(s.stderr()).toBe("");
      expect(code).toBe(0);
      const res = s.response(2);
      expect(res).toBeDefined();
      const result = res?.["result"] as { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
      expect(result?.isError).toBeFalsy();
      expect(result?.structuredContent).toMatchObject({ action_id: seed.id, status: "applied", replayed: false });
      expect(seed.writeLines()).toHaveLength(1);
      seed.ledger((db) => {
        expect(getAction(db, seed.id)?.status).toBe("applied");
        const rows = queryEvents(db, { limit: 20, actionId: seed.id })
          .reverse()
          .map((e) => `${e.kind}:${e.outcome}`);
        expect(rows).toEqual(["plan_created:ok", "applied:ok", "tool_call:ok"]);
      });
    } finally {
      home.cleanup();
    }
  });

  it("lets a cancelled action_apply finish its write before closing the ledger and exiting 0", async () => {
    const home = makeTempHome();
    try {
      const seed = seedSlowApproved(home);
      const s = rawSession(seed.env);
      s.send(INITIALIZE);
      await s.waitFor(1);
      s.send(INITIALIZED);
      s.send(applyRequest(2, seed.id));
      await new Promise((r) => setTimeout(r, 50)); // the handler is now inside the 300 ms provider latency
      s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "client gone" } });
      s.child.stdin.end();
      const [code] = await s.closed;

      expect(s.stderr()).toBe("");
      expect(code).toBe(0);
      expect(s.response(2)).toBeUndefined(); // a cancelled request gets no response
      expect(seed.writeLines()).toHaveLength(1);
      seed.ledger((db) => {
        expect(getAction(db, seed.id)?.status).toBe("applied");
        const kinds = queryEvents(db, { limit: 20, actionId: seed.id })
          .reverse()
          .map((e) => e.kind);
        expect(kinds).toEqual(["plan_created", "applied"]);
        const calls = queryEvents(db, { limit: 20, kind: "tool_call" });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ tool: "action_apply", outcome: "error", error_code: "INTERNAL" });
      });
    } finally {
      home.cleanup();
    }
  });

  it("finishes a pending action_apply and exits 0 silently when the client is gone (stdout closed too)", async () => {
    const home = makeTempHome();
    try {
      const seed = seedSlowApproved(home);
      const s = rawSession(seed.env);
      s.send(INITIALIZE);
      await s.waitFor(1);
      s.send(INITIALIZED);
      s.send(applyRequest(2, seed.id));
      // The client exits: it closes its reading end of our stdout, then our stdin.
      s.child.stdout.destroy();
      s.child.stdin.end();
      const [code] = await s.closed;

      expect(s.stderr()).toBe("");
      expect(code).toBe(0);
      expect(seed.writeLines()).toHaveLength(1);
      seed.ledger((db) => {
        expect(getAction(db, seed.id)?.status).toBe("applied");
        const rows = queryEvents(db, { limit: 20, actionId: seed.id })
          .reverse()
          .map((e) => `${e.kind}:${e.outcome}`);
        expect(rows).toEqual(["plan_created:ok", "applied:ok", "tool_call:ok"]);
      });
    } finally {
      home.cleanup();
    }
  });

  it("exits 0 promptly (under 1 s) with empty stderr when stdin closes with nothing in flight", async () => {
    const home = makeTempHome();
    try {
      const s = rawSession(home.env);
      s.send(INITIALIZE);
      await s.waitFor(1);
      const t0 = Date.now();
      s.child.stdin.end();
      const [code] = await s.closed;
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(code).toBe(0);
      expect(s.stderr()).toBe("");
    } finally {
      home.cleanup();
    }
  });
});
