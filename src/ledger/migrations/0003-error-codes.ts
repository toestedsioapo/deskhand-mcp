import { ERROR_CODES, EVENT_KINDS, EVENT_OUTCOMES } from "../contract.js";
import type { LedgerDb } from "../db.js";

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(",");

/**
 * DDL v3: `events` is rebuilt so its `error_code` CHECK allows
 * PROVIDER_NOT_CONFIGURED and NOT_FOUND (SQLite cannot alter a CHECK in place). Rows keep their
 * ids and order; indexes and the append-only triggers are recreated.
 * Textually equivalent to the "DDL v3" block in docs/ledger-contract.md (a test compares).
 */
export const DDL_V3 = `
CREATE TABLE events_v3 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  action_id    TEXT REFERENCES actions(id),
  tool         TEXT NOT NULL,
  kind         TEXT NOT NULL
    CHECK (kind IN (${list(EVENT_KINDS)})),
  outcome      TEXT NOT NULL
    CHECK (outcome IN (${list(EVENT_OUTCOMES)})),
  error_code   TEXT
    CHECK (error_code IS NULL OR error_code IN (${list(ERROR_CODES)})),
  preview_json TEXT NOT NULL
);

INSERT INTO events_v3 (id, ts, action_id, tool, kind, outcome, error_code, preview_json)
  SELECT id, ts, action_id, tool, kind, outcome, error_code, preview_json FROM events ORDER BY id;

DROP TABLE events;
ALTER TABLE events_v3 RENAME TO events;

CREATE INDEX events_action_id ON events(action_id);
CREATE INDEX events_ts ON events(ts);

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events is append-only');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events is append-only');
END;
`;

export function up(db: LedgerDb): void {
  db.exec(DDL_V3);
}
