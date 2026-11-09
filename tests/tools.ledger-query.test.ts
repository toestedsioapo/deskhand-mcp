import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { appendEvent } from "../src/ledger/events.js";
import { ledgerQueryInputSchema, ledgerQueryOutputSchema } from "../src/tools/ledger-query.js";
import { insertAction, setupHarness } from "./helpers/harness.js";

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H;
beforeEach(async () => {
  h = await setupHarness();
});
afterEach(async () => {
  await h.close();
});

interface Out {
  events: { id: number; tool: string; kind: string; outcome: string; action_id: string | null; preview: unknown }[];
  next_before_id: number | null;
}
const q = async (args: Record<string, unknown> = {}): Promise<Out> => {
  const r = await h.client.callTool({ name: "ledger_query", arguments: args });
  expect(r.isError).toBeFalsy();
  await h.logging.whenIdle();
  return r.structuredContent as unknown as Out;
};
const ts = (n: number) => `2026-11-10T08:00:${String(n).padStart(2, "0")}.000Z`;

function seed(n: number): void {
  for (let i = 1; i <= n; i++) {
    appendEvent(h.db, {
      ts: ts(i),
      tool: i % 2 ? "alpha" : "beta",
      kind: "cli_command",
      outcome: i % 3 ? "ok" : "error",
      errorCode: i % 3 ? null : "INTERNAL",
    });
  }
}

describe("ledger_query schemas", () => {
  it("input schema is stable", () => expect(z.toJSONSchema(ledgerQueryInputSchema)).toMatchSnapshot());
  it("output schema is stable", () => expect(z.toJSONSchema(ledgerQueryOutputSchema)).toMatchSnapshot());
});

describe("ledger_query", () => {
  it("is listed read-only", async () => {
    const t = (await h.client.listTools()).tools.find((x) => x.name === "ledger_query");
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it("defaults to 50 rows, newest first", async () => {
    seed(60);
    const out = await q();
    expect(out.events).toHaveLength(50);
    expect(out.events[0]!.id).toBe(60);
    expect(out.events[49]!.id).toBe(11);
    expect(out.next_before_id).toBe(11);
  });

  it("pages with next_before_id without overlap; null on a short last page", async () => {
    seed(5);
    const p1 = await q({ limit: 2 });
    expect(p1.events.map((e) => e.id)).toEqual([5, 4]);
    expect(p1.next_before_id).toBe(4);
    const p2 = await q({ limit: 2, before_id: p1.next_before_id });
    expect(p2.events.map((e) => e.id)).toEqual([3, 2]);
    const p3 = await q({ limit: 2, before_id: p2.next_before_id });
    expect(p3.events.map((e) => e.id)).toEqual([1]);
    expect(p3.next_before_id).toBeNull();
  });

  it("each filter narrows", async () => {
    seed(6);
    insertAction(h.db, "act_A");
    appendEvent(h.db, { ts: ts(30), actionId: "act_A", tool: "gamma", kind: "plan_created", outcome: "ok" });
    expect((await q({ kind: "plan_created" })).events.map((e) => e.tool)).toEqual(["gamma"]);
    expect((await q({ tool: "alpha" })).events).toHaveLength(3);
    expect((await q({ outcome: "error" })).events.map((e) => e.id)).toEqual([6, 3]);
    expect((await q({ action_id: "act_A" })).events).toHaveLength(1);
    expect((await q({ since: ts(5), kind: "cli_command" })).events.map((e) => e.id)).toEqual([6, 5]);
    expect((await q({ before_id: 3, kind: "cli_command" })).events.map((e) => e.id)).toEqual([2, 1]);
  });

  it("rejects limit 0 and 201 as INVALID_INPUT and logs both", async () => {
    for (const limit of [0, 201]) {
      const r = await h.client.callTool({ name: "ledger_query", arguments: { limit } });
      expect(r.isError).toBe(true);
    }
    await h.logging.whenIdle();
    const rows = h.rows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        tool: "ledger_query",
        kind: "tool_call",
        outcome: "error",
        error_code: "INVALID_INPUT",
      });
    }
  });

  it("never contains its own tool_call row, but the next query does", async () => {
    const first = await q();
    expect(first.events).toEqual([]);
    const second = await q();
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ tool: "ledger_query", kind: "tool_call", outcome: "ok" });
  });

  it("returns stored redacted previews unchanged", async () => {
    appendEvent(h.db, {
      ts: ts(1),
      tool: "x",
      kind: "cli_command",
      outcome: "ok",
      preview: { v: 1, input: { token: "ya29.SECRETSECRETSECRET", body: "hi" }, output: null, note: null },
    });
    const stored = JSON.parse(h.rows()[0]!.preview_json) as unknown;
    const out = await q();
    expect(out.events[0]!.preview).toEqual(stored);
    expect(JSON.stringify(out)).not.toContain("SECRETSECRETSECRET");
  });

  it("next_before_id is null on the last page when rows are an exact multiple of limit", async () => {
    seed(4);
    const p1 = await q({ limit: 2 });
    expect(p1.next_before_id).toBe(3);
    const p2 = await q({ limit: 2, before_id: p1.next_before_id, kind: "cli_command" });
    expect(p2.events.map((e) => e.id)).toEqual([2, 1]);
    expect(p2.next_before_id).toBeNull();
  });

  it("walks all rows by cursor with no overlap", async () => {
    seed(7);
    const seen: number[] = [];
    let before: number | null = null;
    for (let i = 0; i < 10; i++) {
      const page: Out = await q({ limit: 3, kind: "cli_command", ...(before === null ? {} : { before_id: before }) });
      seen.push(...page.events.map((e) => e.id));
      before = page.next_before_id;
      if (before === null) break;
    }
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it("since without milliseconds includes events in that same second", async () => {
    seed(6);
    const out = await q({ since: "2026-11-10T08:00:05Z", kind: "cli_command" });
    expect(out.events.map((e) => e.id)).toEqual([6, 5]);
  });

  it("combines since with before_id", async () => {
    seed(6);
    const out = await q({ since: "2026-11-10T08:00:03Z", before_id: 6, kind: "cli_command" });
    expect(out.events.map((e) => e.id)).toEqual([5, 4, 3]);
  });
});
