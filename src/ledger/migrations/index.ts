import type { LedgerDb } from "../db.js";
import { up as up0001 } from "./0001-init.js";

export interface Migration {
  version: number;
  up(db: LedgerDb): void;
}

/** Forward-only. Never edit a released migration; add a new one. */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, up: up0001 }];

/**
 * Applies migrations above `user_version`, in order. Each runs in one
 * transaction that also sets `PRAGMA user_version`, so a failure leaves the
 * database exactly as it was. A database newer than this code is refused.
 */
export function runMigrations(
  db: LedgerDb,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const highest = ordered.at(-1)?.version ?? 0;
  const initial = db.userVersion();
  if (initial > highest) {
    throw new Error(
      `ledger database is newer (schema ${initial}) than this deskhand supports (schema ${highest}); upgrade deskhand`,
    );
  }
  for (const m of ordered) {
    if (m.version <= initial) continue;
    db.transaction(() => {
      // Re-read under the write lock: another process may have migrated meanwhile.
      if (m.version <= db.userVersion()) return;
      m.up(db);
      db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`);
    }, "immediate");
  }
}
