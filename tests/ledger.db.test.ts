import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEDGER_SCHEMA_VERSION } from "../src/ledger/contract.js";
import { LedgerDb } from "../src/ledger/db.js";
import type { Migration } from "../src/ledger/migrations/index.js";
import { makeTempHome } from "./helpers/home.js";

let home: ReturnType<typeof makeTempHome>;
let path: string;
beforeEach(() => {
  home = makeTempHome();
  path = join(home.home, "ledger.db");
});
afterEach(() => home.cleanup());

const v1: Migration = { version: 1, up: (db) => db.exec("CREATE TABLE a (x INTEGER)") };
const v2: Migration = { version: 2, up: (db) => db.exec("CREATE TABLE b (y INTEGER)") };

const INSERT_ACTION =
  "INSERT INTO actions (id,created_at,tool,input_json,plan_json,plan_hash,expires_at,status) VALUES ('act_1','t','x','{}','{}','h','t','planned')";

function tables(db: LedgerDb): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .map((r) => r.name);
}

describe("LedgerDb.open", () => {
  it("creates the file with WAL, foreign keys and the busy timeout option", () => {
    const db = LedgerDb.open(path, { busyTimeoutMs: 1234 });
    expect(existsSync(path)).toBe(true);
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    expect(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(1234);
    db.close();
  });

  it("defaults busy_timeout to 5000", () => {
    const db = LedgerDb.open(path);
    expect(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(5000);
    db.close();
  });

  it("sets user_version to the schema version and has no schema_version table", () => {
    const db = LedgerDb.open(path);
    expect(db.userVersion()).toBe(LEDGER_SCHEMA_VERSION);
    expect(tables(db)).not.toContain("schema_version");
    db.close();
  });

  it("reopening is a no-op", () => {
    const db = LedgerDb.open(path);
    db.run(INSERT_ACTION);
    db.close();
    const again = LedgerDb.open(path);
    expect(again.userVersion()).toBe(LEDGER_SCHEMA_VERSION);
    expect(again.get<{ n: number }>("SELECT count(*) AS n FROM actions")?.n).toBe(1);
    again.close();
  });

  it("refuses a database from a newer deskhand", () => {
    const db = LedgerDb.open(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => LedgerDb.open(path)).toThrow(/newer/);
  });
});

describe("migrations", () => {
  it("applies [v1, v2] to a fresh database", () => {
    const db = LedgerDb.open(path, { migrations: [v1, v2] });
    expect(db.userVersion()).toBe(2);
    expect(tables(db)).toEqual(expect.arrayContaining(["a", "b"]));
    db.close();
  });

  it("forward-migrates an old database, applying only v2", () => {
    LedgerDb.open(path, { migrations: [v1] }).close();
    const counting: Migration = {
      version: 1,
      up: () => {
        throw new Error("v1 must not run again");
      },
    };
    const db = LedgerDb.open(path, { migrations: [counting, v2] });
    expect(db.userVersion()).toBe(2);
    expect(tables(db)).toEqual(expect.arrayContaining(["a", "b"]));
    db.close();
  });

  it("a throwing migration leaves user_version and tables untouched", () => {
    LedgerDb.open(path, { migrations: [v1] }).close();
    const bad: Migration = {
      version: 2,
      up: (db) => {
        db.exec("CREATE TABLE partial (z INTEGER)");
        throw new Error("boom");
      },
    };
    expect(() => LedgerDb.open(path, { migrations: [v1, bad] })).toThrow(/boom/);
    const db = LedgerDb.open(path, { migrations: [v1] });
    expect(db.userVersion()).toBe(1);
    expect(tables(db)).not.toContain("partial");
    db.close();
  });
});

describe("transaction and statements", () => {
  it("commits on success and rolls back on throw", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    db.transaction(() => db.run("INSERT INTO a (x) VALUES (?)", [1]));
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO a (x) VALUES (?)", [2]);
        throw new Error("nope");
      }, "immediate"),
    ).toThrow("nope");
    expect(db.all<{ x: number }>("SELECT x FROM a")).toEqual([{ x: 1 }]);
    db.close();
  });

  it("run reports changes and lastInsertRowid; get returns undefined when absent", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    const r = db.run("INSERT INTO a (x) VALUES (:x)", { x: 7 });
    expect(r).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.get("SELECT x FROM a WHERE x = ?", [99])).toBeUndefined();
    db.close();
  });
});

describe.skipIf(process.platform === "win32")("posix permissions", () => {
  it("db and sidecars are 0600", () => {
    const db = LedgerDb.open(path);
    db.run(INSERT_ACTION);
    const files = readdirSync(home.home).filter((n) => n.startsWith("ledger.db"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      expect(statSync(join(home.home, f)).mode & 0o777).toBe(0o600);
    }
    db.close();
    chmodSync(path, 0o644);
    LedgerDb.open(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("node:sqlite containment", () => {
  it("only src/ledger/db.ts imports node:sqlite", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.[cm]?[jt]s$/.test(e.name) && readFileSync(p, "utf8").includes("node:sqlite")) {
          hits.push(p.replaceAll("\\", "/"));
        }
      }
    };
    walk("src");
    expect(hits).toEqual(["src/ledger/db.ts"]);
  });
});

describe("nested transactions", () => {
  it("joins the outer transaction and commits both writes", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    db.transaction(() => {
      db.run("INSERT INTO a (x) VALUES (1)");
      db.transaction(() => db.run("INSERT INTO a (x) VALUES (2)"), "immediate");
    });
    expect(db.all<{ x: number }>("SELECT x FROM a ORDER BY x")).toEqual([{ x: 1 }, { x: 2 }]);
    db.close();
  });

  it("an inner throw propagating out of the outer fn rolls back everything", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO a (x) VALUES (1)");
        db.transaction(() => {
          db.run("INSERT INTO a (x) VALUES (2)");
          throw new Error("inner");
        });
      }),
    ).toThrow("inner");
    expect(db.all("SELECT x FROM a")).toEqual([]);
    db.close();
  });

  it("an inner mode is ignored when joining: immediate inside deferred takes no write lock", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    const other = LedgerDb.open(path, { busyTimeoutMs: 0, migrations: [v1] });
    db.transaction(
      () =>
        db.transaction(() => {
          // Joined, so no BEGIN IMMEDIATE ran: another connection can still take the write lock.
          expect(() => other.exec("BEGIN IMMEDIATE")).not.toThrow();
          other.exec("ROLLBACK");
        }, "immediate"),
      "deferred",
    );
    other.close();
    db.close();
  });

  it("the default mode is immediate (a second writer is refused while one is open)", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    const other = LedgerDb.open(path, { busyTimeoutMs: 0, migrations: [v1] });
    db.transaction(() => {
      expect(() => other.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
    });
    expect(() => other.exec("BEGIN IMMEDIATE")).not.toThrow();
    other.exec("ROLLBACK");
    other.close();
    db.close();
  });

  it("explicit deferred does not take the write lock up front", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    const other = LedgerDb.open(path, { busyTimeoutMs: 0, migrations: [v1] });
    db.transaction(() => {
      expect(() => other.exec("BEGIN IMMEDIATE")).not.toThrow();
      other.exec("ROLLBACK");
    }, "deferred");
    other.close();
    db.close();
  });

  it("rejects a thenable-returning fn with a TypeError and rolls back", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    expect(() =>
      db.transaction((() => {
        db.run("INSERT INTO a (x) VALUES (9)");
        return Promise.resolve(1);
      }) as unknown as () => number),
    ).toThrow(TypeError);
    expect(db.all("SELECT x FROM a")).toEqual([]);
    expect(() => db.transaction(() => db.run("INSERT INTO a (x) VALUES (1)"))).not.toThrow();
    db.close();
  });
});

describe("misc", () => {
  it("close is idempotent", () => {
    const db = LedgerDb.open(path);
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  it("binds null as NULL and rejects undefined clearly", () => {
    const db = LedgerDb.open(path, { migrations: [v1] });
    db.run("INSERT INTO a (x) VALUES (?)", [null]);
    expect(db.get<{ x: number | null }>("SELECT x FROM a")?.x).toBeNull();
    expect(() => db.run("INSERT INTO a (x) VALUES (?)", [undefined as never])).toThrow(/undefined/);
    expect(() => db.run("INSERT INTO a (x) VALUES (:x)", { x: undefined as never })).toThrow(/undefined/);
    db.close();
  });
});

describe("concurrent first open", () => {
  it("several processes opening a fresh db all succeed", { timeout: 30_000 }, async () => {
    const N = 4;
    const dbModule = pathToFileURL(join(process.cwd(), "dist/ledger/db.js")).href;
    const barrier = join(home.home, "go");
    const script = `
      import { existsSync, writeFileSync } from "node:fs";
      const { LedgerDb } = await import(${JSON.stringify(dbModule)});
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      writeFileSync(${JSON.stringify(join(home.home, "ready-"))} + process.argv[1], "");
      const deadline = Date.now() + 20000;
      while (!existsSync(${JSON.stringify(barrier)})) {
        if (Date.now() > deadline) process.exit(2);
        sleep(1);
      }
      const db = LedgerDb.open(${JSON.stringify(path)});
      db.close();
    `;
    const children: ReturnType<typeof spawn>[] = [];
    try {
      const results = Array.from({ length: N }, (_, n) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", script, String(n)], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        children.push(c);
        let err = "";
        c.stderr?.on("data", (d: Buffer) => (err += d.toString()));
        return new Promise<{ code: number | null; err: string }>((res) =>
          c.on("exit", (code) => res({ code, err })),
        );
      });
      const deadline = Date.now() + 20_000;
      while (Array.from({ length: N }, (_, n) => existsSync(join(home.home, `ready-${n}`))).includes(false)) {
        if (Date.now() > deadline) throw new Error("children never became ready");
        await new Promise((r) => setTimeout(r, 10));
      }
      writeFileSync(barrier, "go");
      const done = await Promise.all(results);
      for (const r of done) expect(r.err).not.toMatch(/locked|already exists/i);
      expect(done.map((r) => r.code)).toEqual([0, 0, 0, 0]);
      const db = LedgerDb.open(path);
      expect(db.userVersion()).toBe(2);
      expect(tables(db).filter((t) => t === "actions")).toHaveLength(1);
      db.close();
    } finally {
      for (const c of children) if (c.exitCode === null) c.kill();
    }
  });
});
