import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerDb } from "../src/ledger/db.js";
import { LEDGER_SCHEMA_VERSION } from "../src/ledger/contract.js";
import { MIGRATIONS, runMigrations } from "../src/ledger/migrations/index.js";
import { makeTempHome } from "./helpers/home.js";

let home: ReturnType<typeof makeTempHome>;
beforeEach(() => {
  home = makeTempHome();
});
afterEach(() => home.cleanup());

/** A ledger left at schema v1 by M2a / early M2b, with rows in it. */
function seedV1(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("BEGIN");
  const sqlParts: string[] = [];
  MIGRATIONS[0]!.up({ exec: (s: string) => void sqlParts.push(s) } as unknown as LedgerDb);
  raw.exec(sqlParts.join("\n"));
  raw.exec("PRAGMA user_version = 1");
  raw.exec("COMMIT");
  raw.exec(
    "INSERT INTO actions (id,created_at,tool,input_json,plan_json,plan_hash,expires_at,status) VALUES ('act_1','t','x','{}','{}','h','t','planned')",
  );
  raw.exec(
    "INSERT INTO events (ts,action_id,tool,kind,outcome,error_code,preview_json) VALUES ('t1','act_1','cli:approve','approve_refused','rejected','NOT_A_TTY','{\"a\":1}')",
  );
  raw.exec("INSERT INTO events (ts,action_id,tool,kind,outcome,preview_json) VALUES ('t2',NULL,'ping','tool_call','ok','{}')");
  raw.close();
}

describe("migration 2 (UNTRUSTED_RUNTIME)", () => {
  it("upgrades a v1 ledger: rows keep ids and content, new code accepted, ids keep counting", () => {
    const path = join(home.home, "ledger.db");
    seedV1(path);
    const db = LedgerDb.open(path);
    try {
      expect(db.userVersion()).toBe(LEDGER_SCHEMA_VERSION);
      const rows = db.all<{ id: number; ts: string; action_id: string | null; error_code: string | null; preview_json: string }>(
        "SELECT id, ts, action_id, error_code, preview_json FROM events ORDER BY id",
      );
      expect(rows).toEqual([
        { id: 1, ts: "t1", action_id: "act_1", error_code: "NOT_A_TTY", preview_json: '{"a":1}' },
        { id: 2, ts: "t2", action_id: null, error_code: null, preview_json: "{}" },
      ]);
      db.run(
        "INSERT INTO events (ts,action_id,tool,kind,outcome,error_code,preview_json) VALUES ('t3','act_1','cli:approve','approve_refused','rejected','UNTRUSTED_RUNTIME','{}')",
      );
      expect(db.get<{ id: number }>("SELECT max(id) AS id FROM events")?.id).toBe(3);
      expect(() =>
        db.run("INSERT INTO events (ts,tool,kind,outcome,error_code,preview_json) VALUES ('t','x','tool_call','error','NOPE','{}')"),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it("keeps the append-only triggers, the indexes and the action_id foreign key", () => {
    const path = join(home.home, "ledger.db");
    seedV1(path);
    const db = LedgerDb.open(path);
    try {
      expect(() => db.run("UPDATE events SET tool='y'")).toThrow(/events is append-only/);
      expect(() => db.run("DELETE FROM events")).toThrow(/events is append-only/);
      expect(() =>
        db.run("INSERT INTO events (ts,action_id,tool,kind,outcome,preview_json) VALUES ('t','act_nope','x','tool_call','ok','{}')"),
      ).toThrow(/FOREIGN KEY/i);
      const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE tbl_name='events'").map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(["events_action_id", "events_ts", "events_no_update", "events_no_delete"]));
      expect(names).not.toContain("events_v2");
    } finally {
      db.close();
    }
  });

  it("a fresh database and an upgraded v1 database end with the same events DDL", () => {
    const upgraded = join(home.home, "up.db");
    seedV1(upgraded);
    const a = LedgerDb.open(upgraded);
    const b = LedgerDb.open(join(home.home, "fresh.db"));
    try {
      const ddl = (d: LedgerDb): string[] =>
        d
          .all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE tbl_name='events' AND sql IS NOT NULL ORDER BY name")
          .map((r) => `${r.name}\n${r.sql}`);
      expect(ddl(a)).toEqual(ddl(b));
    } finally {
      a.close();
      b.close();
    }
  });

  it("running the migrations again is a no-op", () => {
    const path = join(home.home, "ledger.db");
    seedV1(path);
    const db = LedgerDb.open(path);
    try {
      runMigrations(db);
      expect(db.userVersion()).toBe(LEDGER_SCHEMA_VERSION);
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM events")?.n).toBe(2);
    } finally {
      db.close();
    }
  });
});
