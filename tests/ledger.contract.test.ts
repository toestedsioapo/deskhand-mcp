import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as contract from "../src/ledger/contract.js";
import { LedgerDb } from "../src/ledger/db.js";
import { MIGRATIONS } from "../src/ledger/migrations/index.js";
import { makeTempHome } from "./helpers/home.js";

const doc = readFileSync("docs/ledger-contract.md", "utf8");

function valueSets(): Record<string, string[]> {
  const section = doc.split("## Value sets (machine-read by tests)")[1] ?? "";
  const block = /```\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
  const out: Record<string, string[]> = {};
  for (const line of block.split("\n")) {
    const m = /^(\w+):\s*(.+)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.split(",").map((s) => s.trim());
  }
  return out;
}

function ddlBlock(version: 1 | 2 | 3 = 1): string {
  const section = (doc.split(`## DDL v${version}`)[1] ?? "").split("\n## ")[0] ?? "";
  return /```sql\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

const TUPLES = {
  action_statuses: contract.ACTION_STATUSES,
  event_kinds: contract.EVENT_KINDS,
  event_outcomes: contract.EVENT_OUTCOMES,
  error_codes: contract.ERROR_CODES,
  approval_methods: contract.APPROVAL_METHODS,
  rejection_methods: contract.REJECTION_METHODS,
};

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

const insertAction = (id: string, status = "planned"): void => {
  db.run(
    "INSERT INTO actions (id,created_at,tool,input_json,plan_json,plan_hash,expires_at,status) VALUES (?,?,?,?,?,?,?,?)",
    [id, "t", "x", "{}", "{}", "h", "t", status],
  );
};

describe("contract doc and code agree", () => {
  it("every tuple equals the doc's value-set line", () => {
    const parsed = valueSets();
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(TUPLES).sort());
    for (const [name, tuple] of Object.entries(TUPLES)) {
      expect([...tuple], name).toEqual(parsed[name]);
    }
  });

  it("migration 1 DDL is textually equivalent to the doc's DDL block", () => {
    const sql: string[] = [];
    MIGRATIONS[0]!.up({ exec: (s: string) => void sql.push(s) } as unknown as LedgerDb);
    expect(norm(sql.join("\n"))).toBe(norm(ddlBlock()));
  });

  it("migration 2 DDL is textually equivalent to the doc's DDL v2 block", () => {
    const sql: string[] = [];
    MIGRATIONS[1]!.up({ exec: (s: string) => void sql.push(s) } as unknown as LedgerDb);
    expect(norm(sql.join("\n"))).toBe(norm(ddlBlock(2)));
  });

  it("migration 3 DDL is textually equivalent to the doc's DDL v3 block", () => {
    const sql: string[] = [];
    MIGRATIONS[2]!.up({ exec: (s: string) => void sql.push(s) } as unknown as LedgerDb);
    expect(norm(sql.join("\n"))).toBe(norm(ddlBlock(3)));
  });

  it("schema version is 3 and has one migration per version", () => {
    expect(contract.LEDGER_SCHEMA_VERSION).toBe(3);
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it("UNTRUSTED_RUNTIME is the only error code added in v2; PROVIDER_NOT_CONFIGURED and NOT_FOUND in v3, in that order", () => {
    const v1: readonly string[] = contract.ERROR_CODES_V1;
    expect(contract.ERROR_CODES_V2.filter((c) => !v1.includes(c))).toEqual(["UNTRUSTED_RUNTIME"]);
    const v2: readonly string[] = contract.ERROR_CODES_V2;
    expect(contract.ERROR_CODES.filter((c) => !v2.includes(c))).toEqual(["PROVIDER_NOT_CONFIGURED", "NOT_FOUND"]);
  });
});

describe("snapshots", () => {
  it("value sets", () => {
    expect(TUPLES).toMatchSnapshot();
  });

  it("sqlite_master DDL", () => {
    const rows = db.all<{ type: string; name: string; sql: string }>(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
    );
    expect(rows.map((r) => `${r.type} ${r.name}\n${r.sql}`)).toMatchSnapshot();
  });
});

describe("schema enforcement", () => {
  it("rejects a bogus action status", () => {
    expect(() => insertAction("act_1", "bogus")).toThrow(/CHECK/i);
  });

  it("events is append-only", () => {
    insertAction("act_1");
    db.run(
      "INSERT INTO events (ts,action_id,tool,kind,outcome,preview_json) VALUES ('t','act_1','x','tool_call','ok','{}')",
    );
    expect(() => db.run("UPDATE events SET tool='y'")).toThrow(/events is append-only/);
    expect(() => db.run("DELETE FROM events")).toThrow(/events is append-only/);
  });

  it("events.action_id is a foreign key", () => {
    expect(() =>
      db.run(
        "INSERT INTO events (ts,action_id,tool,kind,outcome,preview_json) VALUES ('t','act_nope','x','tool_call','ok','{}')",
      ),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("events allows NULL action_id and checks error_code", () => {
    db.run(
      "INSERT INTO events (ts,action_id,tool,kind,outcome,preview_json) VALUES ('t',NULL,'x','tool_call','ok','{}')",
    );
    expect(() =>
      db.run(
        "INSERT INTO events (ts,tool,kind,outcome,error_code,preview_json) VALUES ('t','x','tool_call','error','NOPE','{}')",
      ),
    ).toThrow(/CHECK/i);
  });

  it("expenses requires an upper-case 3-letter currency and a unique action_id", () => {
    insertAction("act_1");
    const ins = (cur: string, id: string): void => {
      db.run(
        "INSERT INTO expenses (id,action_id,date,amount_minor,currency,created_at) VALUES (?,?,?,?,?,?)",
        [id, "act_1", "2026-11-10", 100, cur, "t"],
      );
    };
    expect(() => ins("usd", "e1")).toThrow(/CHECK/i);
    ins("USD", "e1");
    expect(() => ins("USD", "e2")).toThrow(/UNIQUE/i);
  });
});
