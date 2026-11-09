import {
  ACTION_STATUSES,
  APPROVAL_METHODS,
  ERROR_CODES,
  EVENT_KINDS,
  EVENT_OUTCOMES,
  REJECTION_METHODS,
} from "../contract.js";
import type { LedgerDb } from "../db.js";

const list = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(",");

/** DDL v1. Textually equivalent to the "DDL v1" block in docs/ledger-contract.md (a test compares). */
export const DDL_V1 = `
CREATE TABLE actions (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  tool               TEXT NOT NULL,
  input_json         TEXT NOT NULL,
  plan_json          TEXT NOT NULL,
  plan_hash          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  status             TEXT NOT NULL
    CHECK (status IN (${list(ACTION_STATUSES)})),
  approved_by        TEXT,
  approved_at        TEXT,
  approval_method    TEXT
    CHECK (approval_method IS NULL OR approval_method IN (${list(APPROVAL_METHODS)})),
  approved_plan_hash TEXT,
  rejected_at        TEXT,
  rejected_reason    TEXT,
  rejection_method   TEXT
    CHECK (rejection_method IS NULL OR rejection_method IN (${list(REJECTION_METHODS)})),
  applied_at         TEXT,
  result_json        TEXT,
  error              TEXT
);

CREATE INDEX actions_status ON actions(status);

CREATE TABLE events (
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

CREATE TABLE expenses (
  id           TEXT PRIMARY KEY,
  action_id    TEXT NOT NULL UNIQUE REFERENCES actions(id),
  date         TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  category     TEXT,
  merchant     TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX expenses_date ON expenses(date);
`;

export function up(db: LedgerDb): void {
  db.exec(DDL_V1);
}
