import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolResultSchema,
  type JSONRPCMessage,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config/env.js";
import { LedgerDb } from "../src/ledger/db.js";
import { classifyResponse, LoggingTransport } from "../src/ledger/logging-transport.js";
import { createServer } from "../src/server.js";
import { toolError, toolOk } from "../src/tools/result.js";
import { makeTempHome } from "./helpers/home.js";
import { makeProviderDeps } from "./helpers/seed.js";

const NOW = "2026-11-10T09:30:00.123Z";
const clock = () => new Date(NOW);

interface RawRow {
  id: number;
  ts: string;
  action_id: string | null;
  tool: string;
  kind: string;
  outcome: string;
  error_code: string | null;
  preview_json: string;
}

const open: (() => Promise<void>)[] = [];

async function setup(register?: (server: McpServer, logging: LoggingTransport) => void) {
  const home = makeTempHome();
  const db = LedgerDb.open(join(home.home, "ledger.db"));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const stderr: string[] = [];
  const logging = new LoggingTransport(serverSide, { db, clock, stderr: (s) => stderr.push(s) });
  const server = createServer(
    { config: loadConfig(home.env), db, clock, ...makeProviderDeps() },
    { track: logging.track },
  );
  register?.(server, logging);
  await server.connect(logging);
  const client = new Client({ name: "deskhand-test", version: "0.0.0" });
  await client.connect(clientSide);
  const rows = () => db.all<RawRow>("SELECT * FROM events ORDER BY id");
  const preview = (r: RawRow | undefined) => JSON.parse(r?.preview_json ?? "null") as unknown;
  open.push(async () => {
    await client.close();
    await server.close();
    db.close();
    home.cleanup();
  });
  return { home, db, server, client, clientSide, logging, stderr, rows, preview };
}

afterEach(async () => {
  for (const teardown of open.splice(0)) await teardown();
});

function insertAction(db: LedgerDb, id: string): void {
  db.run(
    "INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status) VALUES (?,?,?,?,?,?,?,?)",
    [id, NOW, "t", "{}", "{}", "h", NOW, "planned"],
  );
}

describe("LoggingTransport", () => {
  it("logs exactly one ok tool_call row for a successful ping", async () => {
    const c = await setup();
    const r = await c.client.callTool({ name: "ping", arguments: {} });
    expect(r.isError).toBeFalsy();
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ts: NOW,
      action_id: null,
      tool: "ping",
      kind: "tool_call",
      outcome: "ok",
      error_code: null,
    });
    expect(c.preview(rows[0])).toEqual({ v: 1, input: {}, output: r.structuredContent, note: null });
  });

  it("logs input null when the client omits arguments", async () => {
    const c = await setup();
    await c.client.callTool({ name: "ping" });
    expect(c.preview(c.rows()[0])).toMatchObject({ input: null });
  });

  it("writes the row before the client receives the response", async () => {
    const c = await setup();
    const seen: number[] = [];
    const orig = c.clientSide.onmessage;
    c.clientSide.onmessage = (m: JSONRPCMessage, extra?: MessageExtraInfo) => {
      if ("result" in m && m.result["structuredContent"] !== undefined) seen.push(c.rows().length);
      orig?.(m, extra);
    };
    await c.client.callTool({ name: "ping", arguments: {} });
    expect(seen).toEqual([1]);
  });

  it("logs SDK input validation failure as INVALID_INPUT and keeps serving", async () => {
    const c = await setup();
    const bad = await c.client.callTool({ name: "ping", arguments: { x: 1 } });
    // SDK 1.32.2 returns validation failures as an isError result, not a JSON-RPC error.
    expect(bad.isError).toBe(true);
    expect(bad.content).toEqual([
      {
        type: "text",
        text: 'MCP error -32602: Input validation error: Invalid arguments for tool ping: Unrecognized key: "x"',
      },
    ]);
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "ping", outcome: "error", error_code: "INVALID_INPUT" });
    expect(c.preview(rows[0])).toEqual({
      v: 1,
      input: { x: 1 },
      output: null,
      note: expect.stringContaining("Invalid arguments for tool ping"),
    });

    const ok = await c.client.callTool({ name: "ping", arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(c.rows()).toHaveLength(2);
  });

  it("logs a call to an unknown tool as UNKNOWN_TOOL", async () => {
    const c = await setup();
    const r = await c.client.callTool({ name: "no_such_tool", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "MCP error -32602: Tool no_such_tool not found" }]);
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "no_such_tool", outcome: "error", error_code: "UNKNOWN_TOOL" });
  });

  it("maps a gate refusal to outcome rejected with the action id", async () => {
    const c = await setup((s) => {
      s.registerTool(
        "gate",
        {
          inputSchema: z.object({ id: z.string() }).strict(),
          // An output schema: the SDK client validates structuredContent even on
          // isError, so errors must carry none (they use _meta.deskhand).
          outputSchema: z.object({ done: z.literal(true) }),
        },
        ({ id }) => toolError("NOT_APPROVED", "plan is not approved", { action_id: id }),
      );
    });
    insertAction(c.db, "act_EXISTS");
    await c.client.listTools();
    const r = await c.client.callTool({ name: "gate", arguments: { id: "act_EXISTS" } });
    expect(r).toEqual({
      isError: true,
      content: [{ type: "text", text: "NOT_APPROVED: plan is not approved" }],
      _meta: { deskhand: { error_code: "NOT_APPROVED", action_id: "act_EXISTS" } },
    });
    await c.client.callTool({ name: "gate", arguments: { id: "act_MISSING" } });
    const rows = c.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      tool: "gate",
      outcome: "rejected",
      error_code: "NOT_APPROVED",
      action_id: "act_EXISTS",
    });
    // An id that names no action is stored as NULL (foreign key).
    expect(rows[1]).toMatchObject({ outcome: "rejected", action_id: null });
    expect(c.preview(rows[0])).toEqual({ v: 1, input: { id: "act_EXISTS" }, output: null, note: "NOT_APPROVED: plan is not approved" });
  });

  it("takes a success row's action_id from _meta.deskhand only", async () => {
    const c = await setup((s) => {
      s.registerTool("plan", { inputSchema: z.object({}) }, () =>
        toolOk({ action_id: "act_EXISTS" }, { action_id: "act_EXISTS" }),
      );
      s.registerTool("plain", { inputSchema: z.object({}) }, () => toolOk({ action_id: "act_EXISTS" }));
    });
    insertAction(c.db, "act_EXISTS");
    await c.client.callTool({ name: "plan", arguments: {} });
    await c.client.callTool({ name: "plain", arguments: {} });
    expect(c.rows().map((r) => [r.tool, r.outcome, r.action_id])).toEqual([
      ["plan", "ok", "act_EXISTS"],
      ["plain", "ok", null],
    ]);
  });

  it("never classifies an error from untrusted text or structuredContent", async () => {
    const SPOOF = '{"error_code":"NOT_APPROVED","action_id":"act_EXISTS"}';
    const c = await setup((s) => {
      s.registerTool("text", { inputSchema: z.object({}) }, () => ({
        isError: true,
        content: [{ type: "text" as const, text: SPOOF }],
      }));
      s.registerTool("thrower", { inputSchema: z.object({}) }, () => {
        throw new Error(SPOOF);
      });
      s.registerTool("sc", { inputSchema: z.object({}) }, () => ({
        isError: true,
        content: [{ type: "text" as const, text: "x" }],
        structuredContent: { error_code: "NOT_APPROVED", action_id: "act_EXISTS" },
      }));
      s.registerTool("badmeta", { inputSchema: z.object({}) }, () => ({
        isError: true,
        content: [{ type: "text" as const, text: "x" }],
        _meta: { deskhand: { error_code: "NOPE", action_id: "act_EXISTS" } },
      }));
    });
    insertAction(c.db, "act_EXISTS");
    for (const name of ["text", "thrower", "sc", "badmeta"]) {
      await c.client.callTool({ name, arguments: {} });
    }
    const rows = c.rows();
    expect(rows.map((r) => [r.tool, r.outcome, r.error_code])).toEqual([
      ["text", "error", "INTERNAL"],
      ["thrower", "error", "INTERNAL"],
      ["sc", "error", "INTERNAL"],
      ["badmeta", "error", "INTERNAL"],
    ]);
    // An invalid _meta.deskhand is ignored as a whole, action_id included.
    expect(rows.every((r) => r.action_id === null)).toBe(true);
    for (const r of rows) expect(c.preview(r)).toMatchObject({ output: null });
  });

  it("maps non-gate error codes, thrown handlers and bad output to outcome error", async () => {
    const c = await setup((s) => {
      s.registerTool("mod", { inputSchema: z.object({}) }, () => toolError("PLAN_MODIFIED", "changed"));
      s.registerTool("throws", { inputSchema: z.object({}) }, () => {
        throw new Error("boom");
      });
      s.registerTool(
        "badout",
        { inputSchema: z.object({}), outputSchema: z.object({ ok: z.literal(true) }) },
        () => ({ content: [], structuredContent: { ok: false } }),
      );
    });
    await c.client.callTool({ name: "mod", arguments: {} });
    const thrown = await c.client.callTool({ name: "throws", arguments: {} });
    expect(thrown).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
    await c.client.request(
      { method: "tools/call", params: { name: "badout", arguments: {} } },
      CallToolResultSchema,
    );
    expect(c.rows().map((r) => [r.tool, r.outcome, r.error_code])).toEqual([
      ["mod", "error", "PLAN_MODIFIED"],
      ["throws", "error", "INTERNAL"],
      ["badout", "error", "INTERNAL"],
    ]);
  });

  it("logs malformed tools/call params (JSON-RPC -32603 in SDK 1.32.2) as INTERNAL", async () => {
    const c = await setup();
    const err = await c.client
      .request({ method: "tools/call", params: { arguments: {} } }, CallToolResultSchema)
      .then(
        () => null,
        (e: { code?: number }) => e,
      );
    expect(err?.code).toBe(-32603);
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "", outcome: "error", error_code: "INTERNAL" });
  });

  it("tracks in-flight calls and resolves whenIdle after the response is sent", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const begun = new Promise<void>((r) => (started = r));
    const c = await setup((s) => {
      s.registerTool("slow", { inputSchema: z.object({}) }, async () => {
        started();
        await gate;
        return toolOk({ done: true });
      });
    });
    expect(c.logging.inFlight()).toBe(0);
    await c.logging.whenIdle();

    const call = c.client.callTool({ name: "slow", arguments: {} });
    await begun;
    expect(c.logging.inFlight()).toBe(1);
    let idle = false;
    const idleP = c.logging.whenIdle().then(() => {
      idle = true;
      return c.rows().length;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(idle).toBe(false);
    release();
    expect(await idleP).toBe(1);
    expect(c.logging.inFlight()).toBe(0);
    await call;
  });

  it("logs a cancelled call (which gets no response) once, and is idle after", async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = await setup((s) => {
      s.registerTool("slow", { inputSchema: z.object({}) }, async () => {
        started();
        await gate;
        return toolOk({ done: true });
      });
    });
    const ac = new AbortController();
    const call = c.client.callTool({ name: "slow", arguments: {} }, undefined, { signal: ac.signal });
    await begun;
    ac.abort("stop");
    await expect(call).rejects.toThrow();
    await c.logging.whenIdle();
    release();
    await new Promise((r) => setTimeout(r, 20));
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "slow", outcome: "error", error_code: "INTERNAL" });
    expect(c.preview(rows[0])).toEqual({ v: 1, input: {}, output: null, note: "cancelled" });
  });

  it("whenIdle does not resolve while a cancelled (tracked) handler is still running", async () => {
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const c = await setup((s, logging) => {
      s.registerTool("slow", { inputSchema: z.object({}) }, () =>
        logging.track(async () => {
          started();
          await gate;
          finished = true;
          return toolOk({ done: true });
        }),
      );
    });
    const ac = new AbortController();
    const call = c.client.callTool({ name: "slow", arguments: {} }, undefined, { signal: ac.signal });
    await begun;
    ac.abort("stop");
    await expect(call).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    // The cancel row is already written, but the handler still runs.
    expect(c.rows()).toHaveLength(1);
    expect(c.logging.inFlight()).toBe(1);
    let idle = false;
    const idleP = c.logging.whenIdle().then(() => {
      idle = true;
      return finished;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(idle).toBe(false);
    release();
    expect(await idleP).toBe(true);
    expect(c.logging.inFlight()).toBe(0);
    expect(c.rows()).toHaveLength(1);
  });

  it("whenIdle waits for a handler whose call was cancelled before the handler started (same tick)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    let finished = false;
    const c = await setup((s, logging) => {
      s.registerTool("slow", { inputSchema: z.object({}) }, () =>
        logging.track(async () => {
          started = true;
          await gate;
          finished = true;
          return toolOk({ done: true });
        }),
      );
    });
    // Request, cancel and whenIdle in one tick: the cancel takes the pending
    // count to 0 before the SDK's microtask chain has started the handler.
    void c.clientSide.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "slow", arguments: {} } });
    void c.clientSide.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 9, reason: "stop" },
    } as JSONRPCMessage);
    expect(started).toBe(false);
    expect(c.logging.inFlight()).toBe(0);
    let idle = false;
    const idleP = c.logging.whenIdle().then(() => {
      idle = true;
      return finished;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(started).toBe(true); // the SDK runs a cancelled request's handler anyway
    expect(idle).toBe(false);
    release();
    expect(await idleP).toBe(true);
    expect(c.rows()).toHaveLength(1);
  });

  it("track counts a handler from its start, settles a throw, and is idle after", async () => {
    const c = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = c.logging.track(async () => {
      await gate;
      throw new Error("x");
    });
    expect(c.logging.inFlight()).toBe(1);
    release();
    await expect(p).rejects.toThrow("x");
    expect(c.logging.inFlight()).toBe(0);
    await c.logging.whenIdle();
  });

  // Raw JSON-RPC over the client side, so the test picks the request id (the
  // SDK Client numbers its own). Responses for these ids are captured here.
  async function rawCancelScenario(id: string | number, cancelParams: Record<string, unknown>) {
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = await setup((s) => {
      s.registerTool("slow", { inputSchema: z.object({}) }, async () => {
        started();
        await gate;
        return toolOk({ done: true });
      });
    });
    const responses: JSONRPCMessage[] = [];
    const orig = c.clientSide.onmessage;
    c.clientSide.onmessage = (m: JSONRPCMessage, extra?: MessageExtraInfo) => {
      if ("id" in m && m.id === id) responses.push(m);
      else orig?.(m, extra);
    };
    await c.clientSide.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "slow", arguments: {} },
    });
    await begun;
    await c.clientSide.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id, ...cancelParams },
    } as JSONRPCMessage);
    await new Promise((r) => setTimeout(r, 10));
    const rowsAtCancel = c.rows().length;
    release();
    await new Promise((r) => setTimeout(r, 30));
    await c.logging.whenIdle();
    return { c, responses, rowsAtCancel };
  }

  it.each([
    ["id 0", 0, {}],
    ['id ""', "", {}],
    ["invalid reason", 7, { reason: 123 }],
  ])("ignores a cancel the SDK ignores (%s) and logs the real response once", async (_l, id, params) => {
    const { c, responses, rowsAtCancel } = await rawCancelScenario(id, params);
    expect(rowsAtCancel).toBe(0);
    expect(responses).toHaveLength(1);
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "slow", outcome: "ok", error_code: null });
    expect(c.preview(rows[0])).toMatchObject({ note: null, output: { done: true } });
  });

  it("logs a valid raw cancel exactly once, never double-logging a late response", async () => {
    const { c, rowsAtCancel } = await rawCancelScenario(7, { reason: "stop" });
    expect(rowsAtCancel).toBe(1);
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(c.preview(rows[0])).toMatchObject({ note: "cancelled" });
    expect(c.logging.inFlight()).toBe(0);
  });

  it("writes no event for non-tools/call traffic", async () => {
    const c = await setup();
    await c.client.listTools();
    await c.client.ping();
    expect(c.rows()).toHaveLength(0);
  });

  it("never stores a secret-looking argument", async () => {
    const SECRET = "ya29.SECRET-TOKEN-VALUE";
    const c = await setup((s) => {
      s.registerTool("echo", { inputSchema: z.object({ access_token: z.string() }).strict() }, () =>
        toolOk({ ok: true }),
      );
    });
    await c.client.callTool({ name: "echo", arguments: { access_token: SECRET } });
    const raw = c.rows()[0]?.preview_json ?? "";
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("[redacted]");
  });

  it("logs one row for a 20000-deep argument, response intact, stderr clean", async () => {
    const c = await setup();
    let deep: unknown = "x";
    for (let i = 0; i < 20_000; i++) deep = [deep];
    const r = await c.client.callTool({ name: "nope", arguments: { a: deep } });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "MCP error -32602: Tool nope not found" }]);
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "nope", outcome: "error", error_code: "UNKNOWN_TOOL" });
    expect(c.stderr.join("")).toBe("");
  });

  it("caps the stored tool name at 200 chars", async () => {
    const c = await setup();
    const r = await c.client.callTool({ name: "t".repeat(5000), arguments: {} });
    expect(r.isError).toBe(true);
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool.length).toBeLessThanOrEqual(200);
    expect(rows[0]).toMatchObject({ error_code: "UNKNOWN_TOOL" });
  });

  it("retries once with a minimal row when building the preview throws", async () => {
    const c = await setup();
    const hostile = {
      get boom(): never {
        throw new Error("getter exploded");
      },
    };
    // Drive the transport directly: a getter cannot cross the in-memory wire intact.
    const t = c.logging as unknown as {
      pending: Map<number, unknown[]>;
      pendingCount: number;
      inner: { send(m: unknown): Promise<void> };
    };
    t.pending.set(777, [{ tool: "ping", input: hostile }]);
    t.pendingCount++;
    const sent: unknown[] = [];
    t.inner.send = async (m) => {
      sent.push(m);
    };
    await c.logging.send({
      jsonrpc: "2.0",
      id: 777,
      result: { content: [], structuredContent: { ok: true } },
    } as JSONRPCMessage);
    const rows = c.rows();
    expect(rows).toHaveLength(1);
    expect(c.preview(rows[0])).toEqual({ v: 1, input: "[omitted]", output: "[omitted]", note: "preview failed" });
    expect(rows[0]).toMatchObject({ tool: "ping", outcome: "ok" });
    expect(c.stderr).toEqual([]);
    expect((sent[0] as { result: { isError?: boolean } }).result.isError).toBeUndefined();
  });

  it("stores the redacted error message in preview.note for error rows", async () => {
    const c = await setup();
    await c.client.callTool({ name: "no_such_tool", arguments: {} });
    expect(c.preview(c.rows()[0])).toMatchObject({ note: "MCP error -32602: Tool no_such_tool not found" });
  });

  it("replaces the response with INTERNAL and writes stderr when the ledger write fails", async () => {
    const c = await setup();
    // listTools first: the SDK client then validates ping's output schema, and
    // the INTERNAL replacement must still resolve (not throw a schema error).
    await c.client.listTools();
    c.db.close();
    const r = await c.client.callTool({ name: "ping", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r._meta).toEqual({ deskhand: { error_code: "INTERNAL" } });
    expect(r.content).toEqual([
      { type: "text", text: "INTERNAL: internal error: the audit ledger could not be written" },
    ]);
    expect(c.stderr).toHaveLength(1);
    expect(c.stderr[0]).toMatch(/^deskhand-mcp: ledger write failed: .+\n$/);
  });
});

describe("classifyResponse", () => {
  it("maps JSON-RPC -32602 to INVALID_INPUT and other JSON-RPC errors to INTERNAL", () => {
    expect(classifyResponse("t", { code: -32602, message: "bad" }, undefined)).toEqual({
      outcome: "error",
      errorCode: "INVALID_INPUT",
    });
    expect(classifyResponse("t", { code: -32603, message: "x" }, undefined)).toEqual({
      outcome: "error",
      errorCode: "INTERNAL",
    });
  });

  it("maps results by isError and _meta.deskhand.error_code", () => {
    expect(classifyResponse("t", undefined, { content: [] })).toEqual({ outcome: "ok", errorCode: null });
    for (const code of ["WRITES_DISABLED", "UNKNOWN_ACTION", "PLAN_EXPIRED", "NOT_APPROVED"] as const) {
      expect(
        classifyResponse("t", undefined, { isError: true, _meta: { deskhand: { error_code: code } } }),
      ).toEqual({ outcome: "rejected", errorCode: code });
    }
    expect(
      classifyResponse("t", undefined, { isError: true, _meta: { deskhand: { error_code: "STALE_PLAN" } } }),
    ).toEqual({ outcome: "error", errorCode: "STALE_PLAN" });
    expect(
      classifyResponse("t", undefined, { isError: true, _meta: { deskhand: { error_code: "NOPE" } } }),
    ).toEqual({ outcome: "error", errorCode: "INTERNAL" });
    // structuredContent is never a source of the error code.
    expect(
      classifyResponse("t", undefined, { isError: true, structuredContent: { error_code: "NOT_APPROVED" } }),
    ).toEqual({ outcome: "error", errorCode: "INTERNAL" });
  });

  it("toolError has no structuredContent and puts the code in _meta.deskhand", () => {
    expect(toolError("NOT_APPROVED", "nope", { action_id: "act_A" })).toEqual({
      isError: true,
      content: [{ type: "text", text: "NOT_APPROVED: nope" }],
      _meta: { deskhand: { error_code: "NOT_APPROVED", action_id: "act_A" } },
    });
    expect(toolError("INTERNAL", "x")).toEqual({
      isError: true,
      content: [{ type: "text", text: "INTERNAL: x" }],
      _meta: { deskhand: { error_code: "INTERNAL" } },
    });
  });
});
