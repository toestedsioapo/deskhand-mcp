# Ledger contract (v1)

Status: written in M2a before migration 1. This is the contract Deskbench scores against and Deskflow renders (ADR 0003). Changing a table, a column, or any value set below is a breaking change and bumps the package major. `PRAGMA user_version` is the only schema version; v1 of this document is `user_version = 1`. Tests parse the "Value sets" block and the "DDL v1" block of this file, so keep their format exact.

Sources: ARCHITECTURE.md (Ledger, vocabulary and row sequences, Expenses), SPEC section 5, ADR 0002, ADR 0003.

## Conventions

- **Timestamps:** `TEXT`, ISO-8601 UTC with milliseconds and a trailing `Z` (`2026-11-10T09:30:00.123Z`).
- **JSON columns:** `TEXT` holding canonical-or-plain JSON text; `plan_json` is stored exactly as hashed.
- **Action id:** `act_` followed by a 26-character ULID in Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, uppercase). Example: `act_01JC3Z8K4V7Q2W9X5R6T1N0BHM`. The first 10 ULID characters are a timestamp, the last 16 are random.
- **Confirmation string:** the last 4 characters of the whole id (always in the random part). Compared case-insensitively after trimming whitespace. Collisions among pending plans are regenerated at plan time (ADR 0002 item 7).
- **`expenses.id`:** same format as the action id (`act_` + 26-character ULID). It is a separate id space from `actions.id` and is never typed by a human.
- **`events.id`:** `INTEGER PRIMARY KEY AUTOINCREMENT`; the append order is the ordering. Never reused.
- **Idempotency key:** the lowercase hex SHA-256 of the action id string (UTF-8). The provider derives its own write id from it (for example a deterministic Calendar event id). Stable across retries and crashes.
- **`plan_hash`, `approved_plan_hash`:** lowercase hex SHA-256 of the canonical JSON of `plan_json` (ARCHITECTURE, "Canonical JSON").
- **`approved_by`:** OS username of the approving process.
- **Money:** `expenses.amount_minor` is an integer count of the currency's minor unit (2 decimals for USD, 0 for JPY, 3 for KWD per ISO 4217); `currency` is an upper-case ISO-4217 code. The exponent is not stored; it comes from the currency code.
- **Foreign keys:** the connection sets `PRAGMA foreign_keys = ON`. An event about an action that does not exist (for example `UNKNOWN_ACTION`) has `action_id = NULL`; the id the caller supplied is in the redacted preview input.

## Value sets (machine-read by tests)

```
action_statuses: planned, approved, applied, rejected, failed
event_kinds: tool_call, cli_command, plan_created, approved, approve_refused, rejected, applied, apply_refused, apply_failed
event_outcomes: ok, error, rejected
error_codes: INVALID_INPUT, WRITES_DISABLED, UNKNOWN_ACTION, UNKNOWN_TOOL, PLAN_EXPIRED, NOT_APPROVED, ALREADY_APPROVED, NOT_PENDING, NOT_A_TTY, CONFIRMATION_MISMATCH, ID_COLLISION, PLAN_MODIFIED, STALE_PLAN, PROVIDER_ERROR, AUTH_REQUIRED, INTERNAL
approval_methods: cli_tty
rejection_methods: cli_tty, cli_no_tty
```

Meaning of the codes:

| Code | Raised when |
|---|---|
| `INVALID_INPUT` | tool or CLI input failed validation (including SDK-level `-32602`) |
| `WRITES_DISABLED` | `action_apply` while `DESKHAND_ALLOW_WRITES` is not `1` |
| `UNKNOWN_ACTION` | an action id that does not exist |
| `UNKNOWN_TOOL` | `tools/call` for a tool name that is not registered |
| `PLAN_EXPIRED` | `expires_at` has passed (apply, approve) |
| `NOT_APPROVED` | `action_apply` on any status other than `approved` |
| `ALREADY_APPROVED` | approve or reject on a plan whose status is `approved` |
| `NOT_PENDING` | approve or reject on a plan whose status is `rejected`, `failed` or `applied` |
| `NOT_A_TTY` | approve without a TTY on stdin and stdout |
| `CONFIRMATION_MISMATCH` | typed last 4 characters are wrong |
| `ID_COLLISION` | two pending ids share the same last 4 (defensive) |
| `PLAN_MODIFIED` | recomputed hash differs from `plan_hash` or `approved_plan_hash` |
| `STALE_PLAN` | apply-time re-check found the world changed |
| `PROVIDER_ERROR` | the provider write failed |
| `AUTH_REQUIRED` | a Google-backed tool without a token (M3) |
| `INTERNAL` | anything else, including a failed ledger write while answering |

## DDL v1

Task 3 copies this block verbatim into migration 1 (`src/ledger/migrations/0001-init.ts`). The `CHECK` lists must equal the value sets above. The migration runner (not this block) sets `PRAGMA user_version = 1` after the block succeeds.

```sql
CREATE TABLE actions (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  tool               TEXT NOT NULL,
  input_json         TEXT NOT NULL,
  plan_json          TEXT NOT NULL,
  plan_hash          TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  status             TEXT NOT NULL
    CHECK (status IN ('planned','approved','applied','rejected','failed')),
  approved_by        TEXT,
  approved_at        TEXT,
  approval_method    TEXT
    CHECK (approval_method IS NULL OR approval_method IN ('cli_tty')),
  approved_plan_hash TEXT,
  rejected_at        TEXT,
  rejected_reason    TEXT,
  rejection_method   TEXT
    CHECK (rejection_method IS NULL OR rejection_method IN ('cli_tty','cli_no_tty')),
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
    CHECK (kind IN ('tool_call','cli_command','plan_created','approved','approve_refused','rejected','applied','apply_refused','apply_failed')),
  outcome      TEXT NOT NULL
    CHECK (outcome IN ('ok','error','rejected')),
  error_code   TEXT
    CHECK (error_code IS NULL OR error_code IN ('INVALID_INPUT','WRITES_DISABLED','UNKNOWN_ACTION','UNKNOWN_TOOL','PLAN_EXPIRED','NOT_APPROVED','ALREADY_APPROVED','NOT_PENDING','NOT_A_TTY','CONFIRMATION_MISMATCH','ID_COLLISION','PLAN_MODIFIED','STALE_PLAN','PROVIDER_ERROR','AUTH_REQUIRED','INTERNAL')),
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
```

Column notes:

- `actions.input_json`: the validated tool input, redacted by the preview rules below (it can contain agent-supplied text). `plan_json`: what `action_apply` will do, never updated after planning. `result_json`: the stored result of the apply, set on `applied`. `error`: short message, set on `failed`.
- `actions` approval columns are all NULL until approval; rejection columns are all NULL unless rejected; `applied_at` and `result_json` are NULL unless applied. A `failed` action keeps its approval columns.
- `expenses.date` is a calendar date `YYYY-MM-DD` (the expense date, not the insert time). `expenses.action_id` is unique: one expense per applied `expense_log` plan. `amount_minor` may be negative (refund).
- `events.tool` is the MCP tool name (stored capped at 200 characters), or `cli:pending`, `cli:approve`, `cli:reject`, `cli:export`, `cli:auth` for CLI rows. Lifecycle rows (`plan_created`, `approved`, ...) carry the tool of the surface that caused them (`calendar_propose_event`, `cli:approve`, `action_apply`, ...).
- `events.error_code` is NULL when `outcome = ok`; non-NULL otherwise.
- Nothing outside `src/ledger/` touches SQLite. Nothing updates or deletes `events` rows; the triggers enforce it.

## Status transitions

`actions.status` changes only by compare-and-set inside `BEGIN IMMEDIATE` (`UPDATE ... WHERE id=? AND status=?`); zero rows changed means the transition is refused and logged.

| From | To | Caused by | Notes |
|---|---|---|---|
| (none) | `planned` | plan tool | writes `actions` row, `plan_created` event |
| `planned` | `approved` | `deskhand approve` | sets `approved_by`, `approved_at`, `approval_method`, `approved_plan_hash` |
| `planned` | `rejected` | `deskhand reject` | sets `rejected_at`, `rejected_reason`, `rejection_method` |
| `approved` | `applied` | `action_apply` | sets `applied_at`, `result_json`; also on recovery (see gate 6) |
| `approved` | `failed` | `action_apply` | `PLAN_MODIFIED`, `STALE_PLAN` or `PROVIDER_ERROR`; sets `error` |

`rejected`, `failed` and `applied` are terminal. There is no `expired` status; expiry is derived from `expires_at`. Every other attempted transition is a refusal: status unchanged, an `events` row written.

`approved` plans cannot be rejected (`ALREADY_APPROVED`); to withdraw one the user lets it expire. (Call made in M2a; reversible.)

## Apply gate order

`action_apply(action_id)` evaluates these in order and stops at the first that applies:

1. `WRITES_DISABLED`: `DESKHAND_ALLOW_WRITES` is not `1`. Refusal.
2. `UNKNOWN_ACTION`: no such action. Refusal (`action_id` NULL on the rows).
3. Replay: `status = applied`. Returns the stored `result_json`; `tool_call` row `ok`; no lifecycle row; no provider call.
4. `NOT_APPROVED`: `status` is anything other than `approved` (`planned`, `rejected`, `failed`). Refusal.
5. Hash check: recompute `sha256(canonical(plan_json))`; it must equal `plan_hash` and `approved_plan_hash`. Else `PLAN_MODIFIED`, status becomes `failed`.
6. Recovery: if the provider already holds an event for this action's idempotency key, an earlier apply wrote it and crashed before the ledger update. Finalise as `applied` with the existing provider result, `replayed: true`, an `applied` event whose `preview.note` is `recovered`, and no second provider write. This runs before expiry and re-check because the world now contains our own event and the plan may have expired since the crash.
7. `PLAN_EXPIRED`: `expires_at` has passed. Refusal.
8. Re-check (ADR 0002 item 4): slot still free and referenced etags unchanged. Else `STALE_PLAN`, status becomes `failed`, no write.
9. Provider write with the idempotency key. Failure is `PROVIDER_ERROR`, status becomes `failed`. Success sets `applied`, `applied_at`, `result_json`.

Gate refusals (1, 2, 4, 7) leave `status` unchanged. A provider error on a re-check or write is recorded in `actions.error` with the code.

## Approve and reject refusals (CLI)

`deskhand approve` checks, in order: TTY on stdin and stdout (`NOT_A_TTY`, before anything is printed or read), action exists (`UNKNOWN_ACTION`), status (`approved` gives `ALREADY_APPROVED`; `rejected`, `failed`, `applied` give `NOT_PENDING`), not expired (`PLAN_EXPIRED`), recomputed hash equals `plan_hash` (`PLAN_MODIFIED`), no other pending id with the same last 4 (`ID_COLLISION`), typed last 4 matches (`CONFIRMATION_MISMATCH`). Every refusal leaves `status` unchanged.

Note: a hash mismatch at approve leaves the plan `planned` (ADR 0002 item 2); only the apply-time hash check moves a plan to `failed`.

`deskhand reject` refuses with `UNKNOWN_ACTION`, `ALREADY_APPROVED` or `NOT_PENDING`; it needs no TTY and records `cli_tty` or `cli_no_tty` accordingly. It writes only a `cli_command` row (outcome `rejected`) on refusal; there is no `reject_refused` kind.

## Row sequences

Lifecycle rows are written first and the `tool_call` (or `cli_command`) row last, because the last row is written when the response is produced. A `tool_call` row carries `action_id` when the result names an existing action in `_meta.deskhand.action_id` (tools contract, "Result convention").

Transactions: the handler writes the lifecycle rows in the same transaction as the `actions` change they describe. The `tool_call` row is a separate statement, written by the logging transport after the handler returns and before the response is sent. If that write fails after a handler committed (for example an apply), the client receives `INTERNAL` instead of the real result; the committed change stands. Retrying `action_apply` is replay-safe: it hits gate 3 (`status = applied`), returns the stored result and writes a new `tool_call` row (ok). A `cli_command` row is written by the CLI the same way, after the command's own transaction.

Cancellation: a client may cancel a `tools/call` with a valid `notifications/cancelled` (one the SDK acts on: it parses and its `requestId` is non-empty and non-zero). The SDK then sends no response, so the transport writes the call's `tool_call` row at cancel time (`error`, `INTERNAL`, `preview.note = "cancelled"`, `output = null`). An already-running handler is not stopped, so its lifecycle rows (and `actions` change) may follow that `tool_call` row; a response it produces anyway is not logged a second time. A cancel the SDK ignores (invalid params, `requestId` 0 or `""`) logs nothing, and the real response is logged normally.

| Flow | Rows, in write order | `actions.status` |
|---|---|---|
| Read tool (`ping`, `ledger_query`, ...) | `tool_call` | n/a |
| Plan tool ok | `plan_created` (ok), `tool_call` (ok) | `planned` |
| Approve ok | `approved` (ok), `cli_command` (ok) | `approved` |
| Approve refused | `approve_refused` (rejected, code), `cli_command` (rejected, code) | unchanged |
| Reject ok | `rejected` (ok), `cli_command` (ok) | `rejected` |
| Reject refused | `cli_command` (rejected, code) | unchanged |
| Apply ok | `applied` (ok), `tool_call` (ok) | `applied` |
| Apply recovered | `applied` (ok, `preview.note` = `recovered`), `tool_call` (ok) | `applied` |
| Apply repeated on applied | `tool_call` (ok), stored result returned | `applied` |
| Apply refused by a gate | `apply_refused` (rejected, code), `tool_call` (rejected, code) | unchanged |
| Apply `PLAN_MODIFIED` / `STALE_PLAN` / `PROVIDER_ERROR` | `apply_failed` (error, code), `tool_call` (error, code) | `failed` |
| Invalid input / unknown tool | `tool_call` (error, `INVALID_INPUT` / `UNKNOWN_TOOL`) | n/a |
| Other CLI command (`pending`, `export`, `auth`) | `cli_command` | n/a |

`tool_call.outcome` mapping: gate refusals (`WRITES_DISABLED`, `UNKNOWN_ACTION`, `PLAN_EXPIRED`, `NOT_APPROVED`) are `rejected`; every other error code is `error`. For CLI rows, refusals with an approve or reject code (`NOT_A_TTY`, `CONFIRMATION_MISMATCH`, `ID_COLLISION`, `ALREADY_APPROVED`, `NOT_PENDING`, `PLAN_EXPIRED`, `PLAN_MODIFIED`, `UNKNOWN_ACTION`) are `rejected`.

`INVALID_INPUT` and `INTERNAL` `tool_call` rows are outcome `error` (only the four gate refusals above are `rejected`).

Every `tools/call` writes exactly one `tool_call` row, including calls rejected by SDK input validation and calls to unknown tools. If the ledger cannot be written, the response is replaced by an `INTERNAL` error. If the ledger cannot be opened at startup, the process exits (fail closed); this is a startup error, not a tool error.

## `preview_json`

Shape: `{"v":1,"input":<redacted>,"output":<redacted|null>,"note":<string|null>}`; lifecycle previews may also carry `"action_id"`.

- `input`: the tool arguments (or CLI arguments) after redaction. `output`: the structured result after redaction, or `null` when there is none. `note`: short free text such as `recovered`, `cancelled`, `preview failed`, or (on `tool_call` error rows) the redacted error message; `null` otherwise. Success rows carry `null` unless one of the documented notes applies.
- Redaction is one function with a leak test, applied recursively to all strings and keys:
  1. Object keys matching `/token|secret|password|authorization|credential|api[_-]?key|private[_-]?key|cookie|passphrase/i` (substring, case-insensitive; a bare `auth` is deliberately not matched, it would hit `author`) have their value replaced by the string `"[redacted]"`.
  2. Values of keys named `body`, `html` or `content` (case-insensitive, any depth) store no text at all. The value is replaced by the string `[omitted N chars sha256:<first 8 hex>]`, where N is the UTF-16 length (JavaScript `string.length`) and the hash is over the full string. A non-string value is hashed over its canonical JSON and N is that JSON's character count.
  3. Every other string longer than 200 characters is cut to its first 200 characters followed by `…[truncated sha256:<first 8 hex of the full string>]`.
  4. The serialised preview is capped at 4096 bytes (UTF-8). If it is larger, `output` is replaced by the string `"[omitted]"`; if still larger, `input` is too; if still larger, `note` is truncated to 200 characters (and any other top-level field is dropped). `note` and `action_id` are always kept.
  5. Nesting deeper than 32 levels is replaced by the string `"[omitted: too deep]"` (depth counted from the preview root). Canonical JSON used for omitted non-string values refuses input deeper than 256 levels, in which case the omission is described as `[unserialisable]`.
- Rule 1 takes precedence over rule 2 for a matching key.

`actions.input_json` follows the same redaction. `plan_json` and `result_json` are stored in full because the hash and the apply need them, but they never contain mailbox bodies (plans hold only what the write needs; the plan tools are responsible for not copying bodies into `plan_json`).

## CLI-originated rows

`cli_command` rows have `tool = cli:<command>` and `preview.input` holding the command's arguments (action id, reason; never the typed confirmation). Typed confirmation text is never stored.
