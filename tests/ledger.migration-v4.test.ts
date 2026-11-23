import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENT_KINDS, EVENT_KINDS_V1, LEDGER_SCHEMA_VERSION } from "../src/ledger/contract.js";
import { LedgerDb } from "../src/ledger/db.js";
import { MIGRATIONS, runMigrations } from "../src/ledger/migrations/index.js";
import { makeTempHome } from "./helpers/home.js";

let home: ReturnType<typeof makeTempHome>;
beforeEach(() => {
  home = makeTempHome();
});
afterEach(() => home.cleanup());

const sqlOf = (version: number): string => {
  const parts: string[] = [];
  MIGRATIONS.find((m) => m.version === version)!.up({ exec: (s: string) => void parts.push(s) } as unknown as LedgerDb);
  return parts.join("\n");
};

/** A ledger left at schema v3 (migrations 1 to 3 applied), with rows in it. */
function seedV3(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
    raw.exec("BEGIN");
    raw.exec(sqlOf(m.version));
    raw.exec(`PRAGMA user_version = ${m.version}`);
    raw.exec("COMMIT");
  }
  raw.exec(
    "INSERT INTO actions (id,created_at,tool,input_json,plan_json,plan_hash,expires_at,status) VALUES ('act_1','t','x','{}','{}','h','t','approved')",
  );
  raw.exec(
    "INSERT INTO events (ts,action_id,tool,kind,outcome,error_code,preview_json) VALUES ('t1','act_1','action_apply','apply_refused','error','NOT_FOUND','{\"a\":1}')",
  );
  raw.exec("INSERT INTO events (ts,action_id,tool,kind,outcome,preview_json) VALUES ('t2',NULL,'ping','tool_call','ok','{}')");
  raw.close();
}

const insertKind = (db: LedgerDb, kind: string): void => {
  db.run("INSERT INTO events (ts,action_id,tool,kind,outcome,preview_json) VALUES ('t','act_1','action_apply',?,'ok','{}')", [kind]);
};

describe("migration 4 (write_claimed)", () => {
  it("upgrades a v3 ledger: rows keep ids and content, the new kind is accepted, others refused, ids keep counting", () => {
    const path = join(home.home, "ledger.db");
    seedV3(path);
    const db = LedgerDb.open(path);
    try {
      expect(db.userVersion()).toBe(4);
      expect(LEDGER_SCHEMA_VERSION).toBe(4);
      const rows = db.all<{ id: number; ts: string; action_id: string | null; kind: string; error_code: string | null; preview_json: string }>(
        "SELECT id, ts, action_id, kind, error_code, preview_json FROM events ORDER BY id",
      );
      expect(rows).toEqual([
        { id: 1, ts: "t1", action_id: "act_1", kind: "apply_refused", error_code: "NOT_FOUND", preview_json: '{"a":1}' },
        { id: 2, ts: "t2", action_id: null, kind: "tool_call", error_code: null, preview_json: "{}" },
      ]);
      insertKind(db, "write_claimed");
      expect(db.get<{ id: number }>("SELECT max(id) AS id FROM events")?.id).toBe(3);
      expect(() => insertKind(db, "NOPE")).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it("keeps the append-only triggers, the indexes and the action_id foreign key", () => {
    const path = join(home.home, "ledger.db");
    seedV3(path);
    const db = LedgerDb.open(path);
    try {
      expect(() => db.run("UPDATE events SET tool='y'")).toThrow(/events is append-only/);
      expect(() => db.run("DELETE FROM events")).toThrow(/events is append-only/);
      expect(() =>
        db.run("INSERT INTO events (ts,action_id,tool,kind,outcome,preview_json) VALUES ('t','act_nope','x','write_claimed','ok','{}')"),
      ).toThrow(/FOREIGN KEY/i);
      const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE tbl_name='events'").map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(["events_action_id", "events_ts", "events_no_update", "events_no_delete"]));
      expect(names).not.toContain("events_v4");
    } finally {
      db.close();
    }
  });

  it("a fresh database and an upgraded v3 database end with the same events DDL", () => {
    const upgraded = join(home.home, "up.db");
    seedV3(upgraded);
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
    seedV3(path);
    const db = LedgerDb.open(path);
    try {
      runMigrations(db);
      expect(db.userVersion()).toBe(4);
      expect(db.get<{ n: number }>("SELECT count(*) AS n FROM events")?.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it("DDL v4 equals the doc's block", () => {
    const doc = readFileSync("docs/ledger-contract.md", "utf8");
    const section = (doc.split("## DDL v4")[1] ?? "").split("\n## ")[0] ?? "";
    const block = /```sql\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
    expect(block).not.toBe("");
    expect(norm(sqlOf(4))).toBe(norm(block));
  });
});

describe("released migrations are frozen", () => {
  it("EVENT_KINDS_V1 is the nine original kinds; write_claimed is the only addition", () => {
    expect([...EVENT_KINDS_V1]).toEqual([
      "tool_call",
      "cli_command",
      "plan_created",
      "approved",
      "approve_refused",
      "rejected",
      "applied",
      "apply_refused",
      "apply_failed",
    ]);
    expect([...EVENT_KINDS]).toEqual([...EVENT_KINDS_V1, "write_claimed"]);
  });

  // SHA-256 of each migration's SQL, measured at d9cefb7, before EVENT_KINDS grew.
  it.each([
    [1, "573077a28cf7d5a4df0c08e6de2fb4b37aa478d82becb0bf68a53966044fa756"],
    [2, "3fd73f350b5cb59012791cc1df7f6853dd1202008fc2c7476267b0da625f810d"],
    [3, "ed3775ceeae6937ceb563d6cd1f923df2bfc350c66262d4327cd94bf0e85cc52"],
  ])("migration %i's SQL is byte-identical", (version, sha) => {
    expect(createHash("sha256").update(sqlOf(version)).digest("hex")).toBe(sha);
  });
});
