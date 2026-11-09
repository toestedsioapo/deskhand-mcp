// The ONLY module that imports node:sqlite (a test enforces this).
import { chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, type Migration } from "./migrations/index.js";

type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = readonly SqlValue[] | Record<string, SqlValue>;

export interface OpenOptions {
  busyTimeoutMs?: number;
  migrations?: readonly Migration[];
}

export class LedgerDb {
  private closed = false;

  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string, opts: OpenOptions = {}): LedgerDb {
    const raw = new DatabaseSync(path);
    const ledger = new LedgerDb(raw);
    try {
      const timeout = Math.trunc(opts.busyTimeoutMs ?? 5000);
      raw.exec(`PRAGMA busy_timeout = ${timeout}`);
      enableWal(raw, timeout);
      raw.exec("PRAGMA foreign_keys = ON");
      runMigrations(ledger, opts.migrations);
      ledger.restrictPermissions(path);
    } catch (err) {
      raw.close();
      throw err;
    }
    return ledger;
  }

  private restrictPermissions(path: string): void {
    if (process.platform === "win32") return;
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(f)) chmodSync(f, 0o600);
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlParams = []): { changes: number; lastInsertRowid: number } {
    const r = this.db.prepare(sql).run(...this.bind(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    return this.db.prepare(sql).get(...this.bind(params)) as T | undefined;
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    return this.db.prepare(sql).all(...this.bind(params)) as T[];
  }

  /**
   * Runs fn in a transaction (rolled back if it throws). Composable: when a
   * transaction is already open, fn simply joins it (no BEGIN/COMMIT, `mode`
   * is ignored) and errors propagate so the outermost transaction rolls back.
   */
  transaction<T>(fn: () => T, mode: "deferred" | "immediate" = "deferred"): T {
    if (this.db.isTransaction) return fn();
    this.db.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // connection already rolled back
      }
      throw err;
    }
  }

  userVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return Number(row.user_version);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private bind(params: SqlParams): SqlValue[] {
    // node:sqlite takes a named-parameter object as the first (only) argument.
    const values: unknown[] = Array.isArray(params) ? [...params] : Object.values(params);
    if (values.some((v) => v === undefined)) {
      throw new TypeError("cannot bind undefined to an SQL parameter; use null");
    }
    return (Array.isArray(params) ? [...params] : [params]) as SqlValue[];
  }
}

/**
 * Switching a fresh database to WAL needs an exclusive lock that the busy
 * handler does not always wait for, so concurrent first opens can see
 * "database is locked". Skip if already WAL, otherwise retry until the timeout.
 */
function enableWal(raw: DatabaseSync, timeoutMs: number): void {
  const deadline = Date.now() + Math.max(timeoutMs, 0);
  for (;;) {
    try {
      const row = raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
      if (row?.journal_mode === "wal") return;
      raw.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      const locked = /locked|busy/i.test(String((err as Error).message));
      if (!locked || Date.now() >= deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
