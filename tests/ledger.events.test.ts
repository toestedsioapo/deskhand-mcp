import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAction } from "../src/ledger/actions.js";
import { LedgerDb } from "../src/ledger/db.js";
import { appendEvent, queryEvents } from "../src/ledger/events.js";
import { makeTempHome } from "./helpers/home.js";

let home: ReturnType<typeof makeTempHome>;
let db: LedgerDb;
beforeEach(() => {
  home = makeTempHome();
  db = LedgerDb.open(join(home.home, "ledger.db"));
});
afterEach(() => {
  db.close();
  home.cleanup();
});

const ts = (n: number) => `2026-11-09T00:00:0${n}.000Z`;

describe("events", () => {
  it("appendEvent returns increasing ids and rows round-trip", () => {
    const p = { v: 1, input: { a: 1 }, output: { b: 2 }, note: "n" };
    const a = appendEvent(db, { ts: ts(1), tool: "ping", kind: "tool_call", outcome: "ok", preview: p });
    const b = appendEvent(db, {
      ts: ts(2),
      tool: "ping",
      kind: "tool_call",
      outcome: "error",
      errorCode: "INVALID_INPUT",
    });
    expect(b).toBeGreaterThan(a);
    const rows = queryEvents(db, { limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows[1]).toEqual({
      id: a,
      ts: ts(1),
      action_id: null,
      tool: "ping",
      kind: "tool_call",
      outcome: "ok",
      error_code: null,
      preview: p,
    });
    expect(rows[0]?.error_code).toBe("INVALID_INPUT");
  });

  it("stores the redacted preview", () => {
    appendEvent(db, {
      ts: ts(1),
      tool: "t",
      kind: "tool_call",
      outcome: "ok",
      preview: { v: 1, input: { access_token: "ya29", body: "hello" }, output: null, note: null },
    });
    const raw = db.get<{ preview_json: string }>("SELECT preview_json FROM events")?.preview_json ?? "";
    expect(raw).not.toContain("ya29");
    expect(raw).not.toContain("hello");
    expect(raw).toContain("[redacted]");
  });

  it("filters and paginates", () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        appendEvent(db, {
          ts: ts(i),
          tool: i % 2 ? "a" : "b",
          kind: i === 4 ? "cli_command" : "tool_call",
          outcome: i === 3 ? "error" : "ok",
        }),
      );
    }
    const q = (o: Parameters<typeof queryEvents>[1]) => queryEvents(db, o).map((r) => r.id);
    expect(q({ limit: 10, tool: "a" })).toEqual([ids[3], ids[1]]);
    expect(q({ limit: 10, kind: "cli_command" })).toEqual([ids[4]]);
    expect(q({ limit: 10, outcome: "error" })).toEqual([ids[3]]);
    expect(q({ limit: 10, since: ts(3) })).toEqual([ids[4], ids[3]]);
    expect(q({ limit: 2 })).toEqual([ids[4], ids[3]]);
    expect(q({ limit: 2, beforeId: ids[3] as number })).toEqual([ids[2], ids[1]]);
  });

  it("filters by actionId", () => {
    db.run(
      "INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status) VALUES (?,?,?,?,?,?,?,?)",
      ["act_X", ts(0), "t", "{}", "{}", "h", ts(9), "planned"],
    );
    appendEvent(db, { ts: ts(1), actionId: "act_X", tool: "t", kind: "plan_created", outcome: "ok" });
    appendEvent(db, { ts: ts(2), tool: "t", kind: "tool_call", outcome: "ok" });
    expect(queryEvents(db, { limit: 10, actionId: "act_X" })).toHaveLength(1);
  });

  it("getAction returns undefined for unknown id and parses JSON columns", () => {
    expect(getAction(db, "act_nope")).toBeUndefined();
    db.run(
      "INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status, result_json) VALUES (?,?,?,?,?,?,?,?,?)",
      ["act_Y", ts(0), "t", '{"a":1}', '{"b":2}', "h", ts(9), "planned", '{"c":3}'],
    );
    const a = getAction(db, "act_Y");
    expect(a?.input_json).toEqual({ a: 1 });
    expect(a?.plan_json).toEqual({ b: 2 });
    expect(a?.result_json).toEqual({ c: 3 });
    expect(a?.status).toBe("planned");
    expect(a?.approved_by).toBeNull();
  });
});
