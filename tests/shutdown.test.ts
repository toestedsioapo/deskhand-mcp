import { EventEmitter } from "node:events";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { LedgerDb } from "../src/ledger/db.js";
import { createServer, type HandlerTracker } from "../src/server.js";
import { createClientStdout, DEFAULT_TIMEOUT_MS, installStdinShutdown, type ClientStdoutTarget } from "../src/shutdown.js";
import { makeTempHome } from "./helpers/home.js";
import { makeProviderDeps } from "./helpers/seed.js";

const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup(opts: { whenIdle?: () => Promise<void>; closeDb?: () => void; timeoutMs?: number } = {}) {
  const stdin = new EventEmitter();
  const calls: string[] = [];
  const logs: string[] = [];
  let release!: () => void;
  const idle = new Promise<void>((r) => (release = r));
  installStdinShutdown({
    stdin,
    transport: {
      whenIdle: () => {
        calls.push("whenIdle");
        return opts.whenIdle ? opts.whenIdle() : idle;
      },
    },
    closeDb: () => {
      calls.push("closeDb");
      opts.closeDb?.();
    },
    exit: (code) => void calls.push(`exit:${code}`),
    log: (s) => void logs.push(s),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { stdin, calls, logs, release };
}

describe("installStdinShutdown", () => {
  it("does nothing until stdin ends", async () => {
    const s = setup();
    await tick();
    expect(s.calls).toEqual([]);
  });

  it("waits for whenIdle, then closes the db, then exits 0", async () => {
    const s = setup();
    s.stdin.emit("end");
    await tick();
    expect(s.calls).toEqual(["whenIdle"]);
    s.release();
    await tick();
    expect(s.calls).toEqual(["whenIdle", "closeDb", "exit:0"]);
    expect(s.logs).toEqual([]);
  });

  it("handles end then close (and close then end) once", async () => {
    for (const [a, b] of [
      ["end", "close"],
      ["close", "end"],
    ] as const) {
      const s = setup();
      s.stdin.emit(a);
      s.stdin.emit(b);
      s.release();
      await tick();
      s.stdin.emit(a);
      await tick();
      expect(s.calls).toEqual(["whenIdle", "closeDb", "exit:0"]);
    }
  });

  it("exits 1 with one log line when whenIdle never resolves within timeoutMs", async () => {
    const s = setup({ whenIdle: () => new Promise<void>(() => {}), timeoutMs: 20 });
    s.stdin.emit("end");
    await sleep(80);
    expect(s.calls).toEqual(["whenIdle", "exit:1"]);
    expect(s.logs).toHaveLength(1);
    expect(s.logs[0]).toMatch(/^deskhand-mcp: .*timed out.*\n$/);
    expect(s.logs[0]?.trimEnd().split("\n")).toHaveLength(1);
  });

  it("has a 30 s default cap", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it("a drain that needs 200 ms exits 1 with the timeout line under a 100 ms cap", async () => {
    const s = setup({ whenIdle: () => sleep(200), timeoutMs: 100 });
    s.stdin.emit("end");
    await sleep(300);
    expect(s.calls).toEqual(["whenIdle", "exit:1"]);
    expect(s.logs).toEqual(["deskhand-mcp: shutdown timed out after 100 ms waiting for in-flight tool calls\n"]);
  });

  it("a drain that needs 200 ms exits 0 under a 1000 ms cap", async () => {
    const s = setup({ whenIdle: () => sleep(200), timeoutMs: 1000 });
    s.stdin.emit("end");
    await sleep(300);
    expect(s.calls).toEqual(["whenIdle", "closeDb", "exit:0"]);
    expect(s.logs).toEqual([]);
  });

  it("logs and exits 1 when closeDb throws", async () => {
    const s = setup({
      whenIdle: () => Promise.resolve(),
      closeDb: () => {
        throw new Error("disk\non fire");
      },
    });
    s.stdin.emit("close");
    await tick();
    expect(s.calls).toEqual(["whenIdle", "closeDb", "exit:1"]);
    expect(s.logs).toEqual(["deskhand-mcp: ledger close failed: disk on fire\n"]);
  });

  it("logs and exits 1 when whenIdle rejects, without closing the db", async () => {
    const s = setup({ whenIdle: () => Promise.reject(new Error("boom")) });
    s.stdin.emit("end");
    await tick();
    expect(s.calls).toEqual(["whenIdle", "exit:1"]);
    expect(s.logs).toEqual(["deskhand-mcp: shutdown drain failed: boom\n"]);
  });
});

/** A fake stdout whose writes complete through `respond` (defaults to success). */
function fakeStdout(respond: (chunk: string) => Error | null = () => null) {
  const out = new EventEmitter() as EventEmitter & ClientStdoutTarget;
  const written: string[] = [];
  out.write = (chunk, cb) => {
    const s = Buffer.from(chunk).toString("utf8");
    const err = respond(s);
    if (!err) written.push(s);
    setImmediate(() => {
      if (err) out.emit("error", err); // like a real socket: callback AND an 'error' event
      cb(err);
    });
    return true;
  };
  return { out, written };
}

const errWith = (code: string) => Object.assign(new Error(`write ${code}`), { code });

function guard(respond?: (chunk: string) => Error | null) {
  const { out, written } = fakeStdout(respond);
  const logs: string[] = [];
  const exits: number[] = [];
  const g = createClientStdout(out, { log: (s) => void logs.push(s), exit: (c) => void exits.push(c), fallbackMs: 200 });
  const write = (s: string) => new Promise<void>((r) => g.stream.write(s, () => r()));
  return { g, out, written, logs, exits, write };
}

describe("createClientStdout", () => {
  it("passes writes through and exits with the requested code after they are flushed", async () => {
    const t = guard();
    void t.write("a\n");
    t.g.flushThenExit(0);
    expect(t.exits).toEqual([]);
    await sleep(20);
    expect(t.written).toEqual(["a\n"]);
    expect(t.exits).toEqual([0]);
  });

  it.each(["EPIPE", "EOF", "ECONNRESET", "ERR_STREAM_DESTROYED"])(
    "treats %s as client gone: silent, later writes dropped, exit 0",
    async (code) => {
      let calls = 0;
      const t = guard(() => (++calls === 1 ? errWith(code) : null));
      await t.write("a\n");
      await t.write("b\n"); // dropped: never reaches stdout
      t.g.flushThenExit(0);
      await sleep(20);
      expect(calls).toBe(1);
      expect(t.written).toEqual([]);
      expect(t.logs).toEqual([]);
      expect(t.g.failed()).toBe(false);
      expect(t.exits).toEqual([0]);
    },
  );

  it("logs any other stdout error once and turns exit 0 into exit 1", async () => {
    const t = guard(() => errWith("EIO"));
    await t.write("a\n");
    await t.write("b\n");
    t.g.flushThenExit(0);
    await sleep(20);
    expect(t.logs).toEqual(["deskhand-mcp: stdout write failed: write EIO\n"]);
    expect(t.g.failed()).toBe(true);
    expect(t.exits).toEqual([1]);
  });

  it("swallows an 'error' event emitted on stdout outside any write", () => {
    const t = guard();
    expect(() => t.out.emit("error", errWith("EPIPE"))).not.toThrow();
    expect(t.logs).toEqual([]);
  });

  it("falls back to exiting with the requested code when stdout never drains", async () => {
    const out = new EventEmitter() as EventEmitter & ClientStdoutTarget;
    out.write = () => true; // the callback never runs
    const exits: number[] = [];
    const g = createClientStdout(out, { log: () => undefined, exit: (c) => void exits.push(c), fallbackMs: 20 });
    g.stream.write("a\n");
    g.flushThenExit(0);
    g.flushThenExit(0);
    await sleep(80);
    expect(exits).toEqual([0]);
  });
});

describe("createServer tracks every tool handler", () => {
  // Valid arguments per tool, so each call reaches its handler. A new tool
  // must be added here, which forces its tracking to be checked.
  const ARGS: Record<string, Record<string, unknown>> = {
    ping: {},
    ledger_query: {},
    action_explain: { action_id: "act_missing" },
    action_apply: { action_id: "act_missing" },
    calendar_list_events: { time_min: "2026-11-10T00:00:00Z", time_max: "2026-11-11T00:00:00Z" },
    calendar_propose_event: { title: "Sync", start: "2099-01-01T10:00:00Z", end: "2099-01-01T10:30:00Z" },
    calendar_find_slots: {
      date: "2026-11-10",
      start: "10:00",
      end: "10:30",
      time_zone: "UTC",
      participants: [{ partyId: "them", timeZone: "UTC", weeklyRules: { tuesday: [{ start: "09:00", end: "17:00" }] } }],
      own_rules: { partyId: "me", timeZone: "UTC", weeklyRules: { tuesday: [{ start: "09:00", end: "17:00" }] } },
    },
  };

  it("runs each registered tool's handler under track", async () => {
    const home = makeTempHome();
    const db = LedgerDb.open(join(home.home, "ledger.db"));
    let tracked = 0;
    const track: HandlerTracker = async (fn) => {
      tracked++;
      return fn();
    };
    const server = createServer({ config: loadConfig(home.env), db, clock: () => new Date(), ...makeProviderDeps() }, { track });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(ARGS).sort());
      for (const t of tools) {
        const before = tracked;
        await client.callTool({ name: t.name, arguments: ARGS[t.name] });
        expect({ tool: t.name, tracked: tracked - before }).toEqual({ tool: t.name, tracked: 1 });
      }
    } finally {
      await client.close();
      await server.close();
      db.close();
      home.cleanup();
    }
  });
});
