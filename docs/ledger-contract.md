# Ledger contract (v4)

Status: written in M2a before migration 1. This is the contract Deskbench scores against and Deskflow renders (ADR 0003). Changing a table, a column, or any value set below is a breaking change and bumps the package major. `PRAGMA user_version` is the only schema version; this document is `user_version = 4`. v2 (2026-11-10, M2b red-team follow-up) only adds the error code `UNTRUSTED_RUNTIME`; migration 2 rebuilds `events` so its `error_code` CHECK allows it. v3 (2026-11-11, M3a) only adds the error codes `PROVIDER_NOT_CONFIGURED` and `NOT_FOUND` (ADR 0008); migration 3 rebuilds `events` the same way. M4a (2026-11-17) changes no table, column or value set, so `user_version` stays 3; it adds the plan kind `mail.create_draft_reply` and one documented exception to "no bodies in the ledger" (ADR 0010), see "Plan shape: `mail.create_draft_reply`". v4 (2026-11-23, M4b) only adds the event kind `write_claimed` (gate 8b); migration 4 rebuilds `events` the same way. Tests parse the "Value sets" block and the "DDL v1", "DDL v2", "DDL v3" and "DDL v4" blocks of this file, so keep their format exact.

Sources: ARCHITECTURE.md (Ledger, vocabulary and row sequences, Expenses), SPEC section 5, ADR 0002, ADR 0003.

## Conventions

- **Timestamps:** `TEXT`, ISO-8601 UTC with milliseconds and a trailing `Z` (`2026-11-10T09:30:00.123Z`).
- **JSON columns:** `TEXT` holding canonical-or-plain JSON text; `plan_json` is stored as its canonical JSON, and `plan_hash` is taken over `hashablePlan` of it (identical to the whole plan for calendar plans; see `plan_hash` below). `pending`, `approve` and `action_apply` treat a `plan_json` that is not exactly the canonical form of itself as an invalid plan.
- **Action id:** `act_` followed by a 26-character ULID in Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, uppercase). Example: `act_01JC3Z8K4V7Q2W9X5R6T1N0BHM`. The first 10 ULID characters are a timestamp, the last 16 are random.
- **Confirmation string:** the last 4 characters of the whole id (always in the random part). Compared after trimming whitespace and uppercasing ASCII `a-z` only (no Unicode case mapping, so input such as `ß` or `ſ`, which `toUpperCase` turns into `S`, never matches). Collisions among pending plans are regenerated at plan time (ADR 0002 item 7).
- **`expenses.id`:** same format as the action id (`act_` + 26-character ULID). It is a separate id space from `actions.id` and is never typed by a human.
- **`events.id`:** `INTEGER PRIMARY KEY AUTOINCREMENT`; the append order is the ordering. Never reused.
- **Idempotency key:** the lowercase hex SHA-256 of the action id string (UTF-8). The provider derives its own write id from it (for example a deterministic Calendar event id). Stable across retries and crashes.
- **`plan_hash`, `approved_plan_hash`:** lowercase hex SHA-256 of the canonical JSON of `hashablePlan(plan)` (ARCHITECTURE, "Canonical JSON"). `hashablePlan` returns the plan unchanged for every kind except `mail.create_draft_reply`, where it deletes `rationale`, `draft.body` and `draft.bodyRemoved` first (ADR 0010). Calendar hashes are therefore the hash of `plan_json` itself, as before.
- **`approved_by`:** OS username of the approving process (`os.userInfo()`, falling back to `USER`, then `USERNAME`, then `unknown`). It records what the process claims, not a verified identity (SECURITY.md, Limits).
- **Money:** `expenses.amount_minor` is an integer count of the currency's minor unit (2 decimals for USD, 0 for JPY, 3 for KWD per ISO 4217); `currency` is an upper-case ISO-4217 code. The exponent is not stored; it comes from the currency code.
- **Foreign keys:** the connection sets `PRAGMA foreign_keys = ON`. An event about an action that does not exist (for example `UNKNOWN_ACTION`) has `action_id = NULL`; the id the caller supplied is in the redacted preview input.

## Value sets (machine-read by tests)

```
action_statuses: planned, approved, applied, rejected, failed
event_kinds: tool_call, cli_command, plan_created, approved, approve_refused, rejected, applied, apply_refused, apply_failed, write_claimed
event_outcomes: ok, error, rejected
error_codes: INVALID_INPUT, WRITES_DISABLED, UNKNOWN_ACTION, UNKNOWN_TOOL, PLAN_EXPIRED, NOT_APPROVED, ALREADY_APPROVED, NOT_PENDING, NOT_A_TTY, CONFIRMATION_MISMATCH, ID_COLLISION, PLAN_MODIFIED, STALE_PLAN, PROVIDER_ERROR, AUTH_REQUIRED, INTERNAL, UNTRUSTED_RUNTIME, PROVIDER_NOT_CONFIGURED, NOT_FOUND
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
| `PLAN_MODIFIED` | recomputed hash differs from `plan_hash` or `approved_plan_hash`; for a draft plan also a present `draft.body` that does not match `bodyChars` / `bodySha256`, or a `bodyRemoved` plan that cannot be written (M4a) |
| `STALE_PLAN` | apply-time re-check found the world changed, or the event under the action's idempotency key is not the approved one or was deleted (fixed phrases, gate 6); for a draft plan (M4a), the thread no longer exists, it has a new message since planning, its set of messages changed since planning, the plan has no record of that set, or a draft under our Message-ID differs from the plan |
| `PROVIDER_ERROR` | a provider call failed: a read error or an ambiguous write failure (refusal, status unchanged) or a definite write rejection (status `failed`); see gate 9 |
| `AUTH_REQUIRED` | Google sign-in is missing, expired or revoked, lacks the needed scope, or the OAuth client file is missing or unreadable (Google-backed tools, `action_apply`, `cli:auth`); M3 |
| `INTERNAL` | anything else, including a failed ledger write while answering |
| `UNTRUSTED_RUNTIME` | approve while the process runs with `--import`, `--require`/`-r`, `--loader`, `--experimental-loader` or `--inspect*` (in `process.execArgv` or `NODE_OPTIONS`); a speed bump against the trivial fake-TTY preload, not a boundary (SECURITY.md) |
| `PROVIDER_NOT_CONFIGURED` | `action_apply` (and, from M3a, the calendar tools and, from M4a, the inbox tools) while `DESKHAND_PROVIDER` is unset, so no provider is wired (ADR 0008); a gate refusal, outcome `rejected` |
| `NOT_FOUND` | a thread, message or event id that does not exist at the provider; emitted from M4a for an unknown `thread_id` in any inbox tool (no M3 code emitted it) |

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

## DDL v2

Migration 2 (`src/ledger/migrations/0002-untrusted-runtime.ts`) rebuilds `events` so the `error_code` CHECK allows `UNTRUSTED_RUNTIME` (SQLite cannot alter a CHECK in place). Rows keep their ids; the indexes and append-only triggers are recreated. The `CHECK` lists must equal the value sets above. The runner sets `PRAGMA user_version = 2` after the block succeeds. A test compares this block to the migration.

```sql
CREATE TABLE events_v2 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  action_id    TEXT REFERENCES actions(id),
  tool         TEXT NOT NULL,
  kind         TEXT NOT NULL
    CHECK (kind IN ('tool_call','cli_command','plan_created','approved','approve_refused','rejected','applied','apply_refused','apply_failed')),
  outcome      TEXT NOT NULL
    CHECK (outcome IN ('ok','error','rejected')),
  error_code   TEXT
    CHECK (error_code IS NULL OR error_code IN ('INVALID_INPUT','WRITES_DISABLED','UNKNOWN_ACTION','UNKNOWN_TOOL','PLAN_EXPIRED','NOT_APPROVED','ALREADY_APPROVED','NOT_PENDING','NOT_A_TTY','CONFIRMATION_MISMATCH','ID_COLLISION','PLAN_MODIFIED','STALE_PLAN','PROVIDER_ERROR','AUTH_REQUIRED','INTERNAL','UNTRUSTED_RUNTIME')),
  preview_json TEXT NOT NULL
);

INSERT INTO events_v2 (id, ts, action_id, tool, kind, outcome, error_code, preview_json)
  SELECT id, ts, action_id, tool, kind, outcome, error_code, preview_json FROM events ORDER BY id;

DROP TABLE events;
ALTER TABLE events_v2 RENAME TO events;

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
```

## DDL v3

Migration 3 (`src/ledger/migrations/0003-error-codes.ts`) rebuilds `events` so the `error_code` CHECK allows `PROVIDER_NOT_CONFIGURED` and `NOT_FOUND`, the same technique as migration 2. Rows keep their ids; the indexes and append-only triggers are recreated. The `CHECK` lists must equal the value sets above. The runner sets `PRAGMA user_version = 3` after the block succeeds. A test compares this block to the migration.

```sql
CREATE TABLE events_v3 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  action_id    TEXT REFERENCES actions(id),
  tool         TEXT NOT NULL,
  kind         TEXT NOT NULL
    CHECK (kind IN ('tool_call','cli_command','plan_created','approved','approve_refused','rejected','applied','apply_refused','apply_failed')),
  outcome      TEXT NOT NULL
    CHECK (outcome IN ('ok','error','rejected')),
  error_code   TEXT
    CHECK (error_code IS NULL OR error_code IN ('INVALID_INPUT','WRITES_DISABLED','UNKNOWN_ACTION','UNKNOWN_TOOL','PLAN_EXPIRED','NOT_APPROVED','ALREADY_APPROVED','NOT_PENDING','NOT_A_TTY','CONFIRMATION_MISMATCH','ID_COLLISION','PLAN_MODIFIED','STALE_PLAN','PROVIDER_ERROR','AUTH_REQUIRED','INTERNAL','UNTRUSTED_RUNTIME','PROVIDER_NOT_CONFIGURED','NOT_FOUND')),
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
```

## DDL v4

Migration 4 (`src/ledger/migrations/0004-write-claim.ts`) rebuilds `events` so the `kind` CHECK allows `write_claimed`, the same technique as migration 3. Rows keep their ids; the indexes and append-only triggers are recreated. Migrations 1 to 3 build their `kind` CHECK from the frozen `EVENT_KINDS_V1`, so their SQL is unchanged. The runner sets `PRAGMA user_version = 4` after the block succeeds. A test compares this block to the migration.

```sql
CREATE TABLE events_v4 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  action_id    TEXT REFERENCES actions(id),
  tool         TEXT NOT NULL,
  kind         TEXT NOT NULL
    CHECK (kind IN ('tool_call','cli_command','plan_created','approved','approve_refused','rejected','applied','apply_refused','apply_failed','write_claimed')),
  outcome      TEXT NOT NULL
    CHECK (outcome IN ('ok','error','rejected')),
  error_code   TEXT
    CHECK (error_code IS NULL OR error_code IN ('INVALID_INPUT','WRITES_DISABLED','UNKNOWN_ACTION','UNKNOWN_TOOL','PLAN_EXPIRED','NOT_APPROVED','ALREADY_APPROVED','NOT_PENDING','NOT_A_TTY','CONFIRMATION_MISMATCH','ID_COLLISION','PLAN_MODIFIED','STALE_PLAN','PROVIDER_ERROR','AUTH_REQUIRED','INTERNAL','UNTRUSTED_RUNTIME','PROVIDER_NOT_CONFIGURED','NOT_FOUND')),
  preview_json TEXT NOT NULL
);

INSERT INTO events_v4 (id, ts, action_id, tool, kind, outcome, error_code, preview_json)
  SELECT id, ts, action_id, tool, kind, outcome, error_code, preview_json FROM events ORDER BY id;

DROP TABLE events;
ALTER TABLE events_v4 RENAME TO events;

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
```

## Status transitions

`actions.status` changes only by compare-and-set inside `BEGIN IMMEDIATE` (`UPDATE ... WHERE id=? AND status=?`); zero rows changed means the transition is refused and logged.

| From | To | Caused by | Notes |
|---|---|---|---|
| (none) | `planned` | plan tool | writes `actions` row, `plan_created` event |
| `planned` | `approved` | `deskhand approve` | sets `approved_by`, `approved_at`, `approval_method`, `approved_plan_hash` |
| `planned` | `rejected` | `deskhand reject` | sets `rejected_at`, `rejected_reason`, `rejection_method` |
| `approved` | `applied` | `action_apply` | sets `applied_at`, `result_json`; also on recovery (see gate 6) |
| `approved` | `failed` | `action_apply` | `PLAN_MODIFIED`, `STALE_PLAN` (incl. a deleted or differing event under our key) or a definite `PROVIDER_ERROR`; sets `error` |

`rejected`, `failed` and `applied` are terminal. There is no `expired` status; expiry is derived from `expires_at`. Every other attempted transition is a refusal: status unchanged, an `events` row written.

`approved` plans cannot be rejected (`ALREADY_APPROVED`); to withdraw one the user lets it expire. (Call made in M2a; reversible.)

## Apply gate order

`action_apply(action_id)` evaluates these in order and stops at the first that applies:

1. `WRITES_DISABLED`: `DESKHAND_ALLOW_WRITES` is not `1`. Refusal.
1b. `PROVIDER_NOT_CONFIGURED`: no provider is wired (`DESKHAND_PROVIDER` unset, ADR 0008). Refusal, status unchanged. It sits after the writes flag so "writes off" keeps answering first, and before the action lookup because nothing can be applied without a provider.
2. `UNKNOWN_ACTION`: no such action. Refusal (`action_id` NULL on the rows).
3. Replay: `status = applied`. Returns the stored `result_json`; `tool_call` row `ok`; no lifecycle row; no provider call. The plan kind rebuilds the `action_apply` result from `result_json`, so the stored plan must still parse, name a known kind and pass its schema; if it does not (unreachable through the plan tools), the replay is refused with `INTERNAL` (an `apply_refused` row, outcome `error`), status stays `applied`, and no provider call is made.
4. `NOT_APPROVED`: `status` is anything other than `approved` (`planned`, `rejected`, `failed`). Refusal.
5. Hash check: recompute `planHash(plan_json)` (the SHA-256 of the canonical JSON of `hashablePlan(plan)`); it must equal `plan_hash` and `approved_plan_hash`. Else `PLAN_MODIFIED`, status becomes `failed`. A kind may add a body-integrity check here (a generic optional hook, checked before the schema parse): a `mail.create_draft_reply` plan whose `draft.body` is present but does not match `bodyChars` and `bodySha256` is `PLAN_MODIFIED`, status `failed`, not `INTERNAL`.
6. Recovery: the idempotency key is looked up (`lookupEvent`, which tells "absent" from "cancelled", that is created and later deleted). If the provider holds an event under it **and that event is the approved one**, an earlier apply wrote it and crashed before the ledger update: finalise as `applied` with the existing provider result, `replayed: true`, an `applied` event whose `preview.note` is `recovered`, and no second provider write. "The approved one" means: our id; organised by the calendar owner (`organizerSelf`: Google's `organizer.self`; the fixture sets it on its own writes and on world events unless they say `organizer_self: false`), so a foreign invite under our id never matches; not recurring (no `recurrence`, no `recurringEventId`); a timed event; the same title; the same start and end instants (compared as instants, so `10:00Z` equals `11:00+01:00`); and the same attendee address set (case-insensitive, order and repeats ignored), where the calendar owner Google lists as a `self: true` attendee is kept apart (`ownerEmail`) and the sets may match either without the owner (Google added them) or with the owner (the plan invited them explicitly); any other extra or missing address differs. The calendar is the one it is looked up in, the plan's. An event under our key that differs is **not** applied and **not** re-written: `STALE_PLAN`, status becomes `failed`, message exactly `an event with this action's id exists but differs from the approved plan`. A cancelled (deleted) event under our key is never created again: `STALE_PLAN`, `failed`, message exactly `an event with this action's id was created and later deleted`, and no write is sent. Neither message carries event content. The same rule ("settle") applies wherever apply accepts an existing event: here, the lookups after a failed re-check (8) and after a failed write (9), and the event `createEvent` returns (9), which may be an existing one (the Google `409` path, a concurrent apply). This runs before expiry and re-check because the world now contains our own event and the plan may have expired since the crash. A provider error during this lookup is a refusal: `apply_refused` (error, `PROVIDER_ERROR`), status unchanged, retryable. An `AuthRequiredError` from the provider (any call in this apply: gates 6, 8, 9 and every follow-up lookup) is instead a refusal `apply_refused` (outcome `rejected`, `AUTH_REQUIRED`), status unchanged, never `failed`; the user signs in again and retries.
7. `PLAN_EXPIRED`: `expires_at` has passed (fails closed: `now >= expires_at`, or an unparseable `expires_at`, is expired). Refusal.
8. Re-check (ADR 0002 item 4): slot still free and referenced etags unchanged. If not, the idempotency key is looked up again first and settled as in gate 6: the approved event (a concurrent apply of the same action wrote it after this call's recovery lookup) is finalised `recovered`; a differing or cancelled one fails with its phrase. If nothing is there, `STALE_PLAN`, status becomes `failed`, no write, unless this action's own ledger rows show an earlier ambiguous write attempt (an `apply_refused` row, `PROVIDER_ERROR` or `AUTH_REQUIRED`, whose note starts `Provider write failed: `, written by gate 9 for every ambiguous attempt): then the slot may be busy with our own landed event that the provider cannot read back yet, so it is a refusal `apply_refused` (error, `PROVIDER_ERROR`) with the fixed note `an earlier write attempt may still be landing; retry later`, status unchanged; a later apply recovers the event at gate 6 (or, if the slot really is taken by something else, keeps refusing until the plan expires). The same refusal applies while this action has a live write claim (gate 8b: the newest `write_claimed` row, not released, younger than 60 s). A provider error while reading (re-check or the second lookup) is a refusal: `apply_refused` (error, `PROVIDER_ERROR`), status unchanged, retryable.
8b. Write claim, only for a kind with `needsWriteClaim` (`mail.create_draft_reply`; a calendar write has a provider-enforced fixed id and writes no claim row). In `BEGIN IMMEDIATE`: the status must still be `approved` (otherwise as a lost compare-and-set: a replay if `applied`, else `NOT_APPROVED`), and a `write_claimed` row (outcome `ok`, tool `action_apply`) is inserted only if the action has none, its newest is released, or its newest is at least 60 000 ms old by `ctx.clock` and the row's `ts` (an unparseable `ts` counts as held). Otherwise `apply_refused` (error, `PROVIDER_ERROR`), status unchanged, no write, fixed note `another apply of this action is in progress or may still be landing; retry in a minute`. After taking it, the key is looked up again and settled as in gate 6. If nothing is there, a new `BEGIN IMMEDIATE` confirms the plan is still `approved` and our claim is still the newest, unreleased and 0 to 29 999 ms old; otherwise the same refusal, with no write. **Release:** an `apply_refused` row with `preview.output = { releasedClaim: <claim event id> }` releases exactly that claim. Only exits known to have written nothing write one: a lookup failure under the claim, the start-limit refusal, and a write that threw `AuthRequiredError` whose follow-up lookup found nothing or itself failed. A crash, timeout, network error, `429`, `5xx` or unreadable `2xx` never releases, so a retry may write again only once the claim is 60 s old and a lookup under the new claim finds nothing. A definite write failure moves the plan to `failed`, which is terminal and needs no release. Recovery at gate 6 writes no claim.
9. Provider write with the idempotency key. The event `createEvent` returns is settled as in gate 6 (it may be an existing one): the approved event sets `applied`, `applied_at`, `result_json`; a differing one fails `STALE_PLAN`. On a write failure the key is looked up again (the failure may be ambiguous, for example a timeout after the provider accepted the event) and settled as in gate 6 (`recovered`, or a differing/cancelled phrase). If the lookup itself errors, a refusal with status unchanged: after an ambiguous write error (see below) it is `apply_refused` with `PROVIDER_ERROR` (or `AUTH_REQUIRED` when the lookup needed a sign-in) and the note `Provider write failed: <write error>; the lookup after it failed: <lookup error>`, so the attempt is on record for gate 8; otherwise `PROVIDER_ERROR` `Provider lookup after a failed write failed: ...`. Every ambiguous write attempt therefore leaves an `apply_refused` row whose note starts with the fixed prefix `Provider write failed: ` (no other row does). If the lookup finds nothing, the write error decides:
   - **Ambiguous** (`ProviderError.retryable`: a timeout, a network error, HTTP `429` or any `5xx`, a `2xx` whose body cannot be read (the event was probably created), or a token refresh that failed before the request was sent): `apply_refused` (error, `PROVIDER_ERROR`), status stays `approved`, `actions.error` untouched. The write may still land; a retry is safe because the event id is fixed by the key: the retry's recovery lookup finds a landed event (`recovered`), or the insert answers `409` and the existing event is returned. The retry passes the expiry gate (7) only before `expires_at`, and the recovery lookup (6) still runs first after it.
   - **Definite** (any other provider error: a `4xx` from the insert such as `400`, a non-auth `403` or a `404` calendar; `409` then not readable; `409` then cancelled; an invalid event id; a `2xx` whose event id is not ours, `Google returned a different event id`; an error that is not a `ProviderError`): `apply_failed` (error, `PROVIDER_ERROR`), status becomes `failed`.
   - An `AuthRequiredError`: a refusal, see below.

   The provider's `createEvent` with an existing key must return the existing event (never throw, never duplicate), except that a deleted (cancelled) key throws the deleted-event phrase and is never re-created.

**Gates 6 to 9 for a `mail.create_draft_reply` plan (M4a).** The gate order is the same; the kind supplies the provider calls.

- *Gate 6, recovery.* The idempotency key gives the draft's `Message-ID` header, `<deskhand.<key>@deskhand.invalid>`, and `MailProvider.lookupDraft` finds a draft by it. The result is `absent` or `present`; Gmail cannot report a deleted draft, so there is no `cancelled` state for drafts and the "created and later deleted" phrase never applies. A found draft is "the approved one" only when the Message-ID, the thread id, the subject, the to, cc and bcc address sets (case-insensitive, order and repeats ignored) and the SHA-256 of the body all equal the plan (the body hash is compared with `bodySha256`, so recovery still works after the body was swept). A found draft that differs is not applied and not re-written: `STALE_PLAN`, status `failed`, message exactly `a draft with this action's id exists but differs from the approved plan`. If the user deleted a draft that a crashed apply left behind, the retry creates it again; it is a draft and is never sent.
- *Gate 7a, no body, no write.* After gate 7 and before gate 8, an approved plan with `draft.bodyRemoved` is `PLAN_MODIFIED`, status `failed`, and the provider is never asked to write. (Recovery and expiry run first, so a swept plan whose draft already exists is still recorded `applied`.)
- *Gate 8, re-check.* First, `MailProvider.profile()` must still return the plan's `from` address (compared case-insensitively): the draft says it is from that address, and the thread id and `observed.onThread` belong to that mailbox, so a different signed-in account is a changed world. Then the thread must still exist (`MailProvider.threadMessageIds` is not `null`) and its latest non-draft message id must still equal `observed.latestMessageId`. Then the thread's whole message set must still hash to `observed.messageIdsSha256`: any other difference, a backdated message anywhere in the thread or a removed one, fails; label and read-state changes and drafts do not change the set. A plan without `observed.messageIdsSha256` (stored by M4a) cannot pass. Otherwise `STALE_PLAN`, status `failed`, no write. As for every kind, the message is the fixed prefix `The world changed since planning: ` followed by the kind's phrase and a full stop, so it is exactly `The world changed since planning: the mailbox account changed since planning.`, `The world changed since planning: the thread no longer exists.` or `The world changed since planning: the thread has a new message since planning.`, `The world changed since planning: the thread's messages changed since planning.` or `The world changed since planning: the plan has no record of the thread's messages.` (the calendar messages, `The world changed since planning: the slot is no longer free.` and `The world changed since planning: event <id> changed since planning.`, are unchanged). As for calendar plans, the draft lookup runs again before failing, and an earlier ambiguous write attempt turns the failure into the retryable refusal.
- *Gate 8b, write claim.* Runs for every draft write. `MailProvider.lookupDraft` takes the plan's thread id, so an adapter can look in the thread when search has not indexed the draft yet.
- *Gate 9, write.* The fixture's `createDraft` with a `Message-ID` that already exists returns the existing draft; Gmail has no unique key on that header, so gate 8b is what keeps a second POST from happening. The draft it returns is settled as in gate 6. `result_json` holds `{ draftId, messageId, threadId, messageIdHeader, to, cc, bcc, subject, bodySha256 }`, never the body.

**Auth failures at any provider call.** An `AuthRequiredError` thrown by the recovery lookup (6), the re-check or its second lookup (8), the write (9) or a post-failure lookup is a refusal: `apply_refused` (outcome `rejected`, `AUTH_REQUIRED`), status unchanged, never `failed`. This includes `createEvent` throwing `AuthRequiredError` while the follow-up lookup succeeds and finds nothing: an auth failure means the write was not attempted or not authorised, so the plan stays `approved` and can be retried after `deskhand auth login`. If the follow-up lookup finds our event, it is still finalised as `recovered`. Provider error text stored in `actions.error` or any preview passes through `scrubSecrets` (see `preview_json`, "Free-text secret scrubbing": a text that looks like it holds a secret, as written or in any decoded form, becomes `[redacted: text contained secret-like data]` as a whole; any other text is unchanged) before the ledger redactor.

Gate refusals (1, 1b, 2, 4, 7), provider read errors, ambiguous write failures, a failed re-check after an earlier ambiguous attempt and the stored-plan `INTERNAL` refusal leave `status` unchanged. Only `PLAN_MODIFIED`, `STALE_PLAN` (including a differing or deleted event under our key) and a definite write failure whose follow-up lookup finds nothing move the plan to `failed`; `actions.error` then holds `<CODE>: <message>`, with provider text passed through the preview redactor.

After gate 5, a stored plan whose kind is unknown or that fails its kind's schema (unreachable through the plan tools, which validate) is refused with `INTERNAL`, status unchanged.

## Approve and reject refusals (CLI)

`deskhand approve` checks, in order: TTY on stdin and stdout (`NOT_A_TTY`, before anything is printed or read), runtime has no preload, loader or inspector flag (`UNTRUSTED_RUNTIME`, also before anything is printed or read), action exists (`UNKNOWN_ACTION`), status (`approved` gives `ALREADY_APPROVED`; `rejected`, `failed`, `applied` give `NOT_PENDING`), not expired (`PLAN_EXPIRED`), recomputed hash equals `plan_hash` (`PLAN_MODIFIED`), 5b. the stored plan has a known kind and passes its schema (`INTERNAL`, outcome `error`, before the prompt; unreachable through the plan tools, which validate, and the same code apply uses), no other pending id with the same last 4 (`ID_COLLISION`), typed last 4 matches (`CONFIRMATION_MISMATCH`). Every refusal leaves `status` unchanged.

Note: a hash mismatch at approve leaves the plan `planned` (ADR 0002 item 2); only the apply-time hash check moves a plan to `failed`.

For a `mail.create_draft_reply` plan, approve adds two refusals, both `PLAN_MODIFIED` and both leaving the plan `planned` (owner ruling, 2026-11-17; ADR 0010): (a) a present `draft.body` that does not match `bodyChars` / `bodySha256`, checked right after the hash check and before the schema parse (5b), so an edited body is `PLAN_MODIFIED` and never the schema's `INTERNAL`; (b) a plan with `draft.bodyRemoved`, checked after the expiry check, so an expired plan with `bodyRemoved` is `PLAN_EXPIRED` and an unexpired one is `PLAN_MODIFIED`. Both are generic optional hooks on the plan kind, so the approve code has no mail logic.

`deskhand reject` refuses with `UNKNOWN_ACTION`, `ALREADY_APPROVED` or `NOT_PENDING`; it needs no TTY and records `cli_tty` or `cli_no_tty` accordingly. It writes only a `cli_command` row (outcome `rejected`) on refusal; there is no `reject_refused` kind.

## Row sequences

Lifecycle rows are written first and the `tool_call` (or `cli_command`) row last, because the last row is written when the response is produced. A `tool_call` row carries `action_id` when the result names an existing action in `_meta.deskhand.action_id` (tools contract, "Result convention").

Transactions: the handler writes the lifecycle rows in the same transaction as the `actions` change they describe. The `tool_call` row is a separate statement, written by the logging transport after the handler returns and before the response is sent. If that write fails after a handler committed (for example an apply), the client receives `INTERNAL` instead of the real result; the committed change stands. Retrying `action_apply` is replay-safe: it hits gate 3 (`status = applied`), returns the stored result and writes a new `tool_call` row (ok). A `cli_command` row is written by the CLI the same way, after the command's own transaction.

Cancellation: a client may cancel a `tools/call` with a valid `notifications/cancelled` (one the SDK acts on: it parses and its `requestId` is non-empty and non-zero). The SDK then sends no response, so the transport writes the call's `tool_call` row at cancel time (`error`, `INTERNAL`, `preview.note = "cancelled"`, `output = null`). An already-running handler is not stopped, so its lifecycle rows (and `actions` change) may follow that `tool_call` row; a response it produces anyway is not logged a second time. A cancel the SDK ignores (invalid params, `requestId` 0 or `""`) logs nothing, and the real response is logged normally.

| Flow | Rows, in write order | `actions.status` |
|---|---|---|
| Read tool (`ping`, `ledger_query`, ...) | `tool_call` | n/a |
| Plan tool ok (`calendar_propose_event`, `inbox_draft_reply`) | `plan_created` (ok), `tool_call` (ok) | `planned` |
| Inbox read or triage tool (`inbox_search`, `inbox_read_thread`, `inbox_triage`), including an unknown thread (`NOT_FOUND`, outcome `error`) | `tool_call` | n/a (no `actions` row) |
| Approve ok | `approved` (ok), `cli_command` (ok) | `approved` |
| Approve refused | `approve_refused` (rejected, code), `cli_command` (rejected, code) | unchanged |
| Approve on a stored plan with unknown kind / invalid shape (check 5b) | `approve_refused` (error, `INTERNAL`), `cli_command` (error, `INTERNAL`) | unchanged |
| Reject ok | `rejected` (ok), `cli_command` (ok) | `rejected` |
| Reject refused | `cli_command` (rejected, code) | unchanged |
| Apply ok (calendar) | `applied` (ok), `tool_call` (ok) | `applied` |
| Apply ok (draft) | `write_claimed` (ok), `applied` (ok), `tool_call` (ok) | `applied` |
| Apply recovered at gate 6 | `applied` (ok, `preview.note` = `recovered`), `tool_call` (ok) | `applied` |
| Apply recovered under a write claim (draft) | `write_claimed` (ok), `applied` (ok, `preview.note` = `recovered`), `tool_call` (ok) | `applied` |
| Apply refused at gate 8b (claim held) | `apply_refused` (error, `PROVIDER_ERROR`), `tool_call` (error, `PROVIDER_ERROR`) | unchanged |
| Apply exit that releases its claim (gate 8b) | `write_claimed` (ok), `apply_refused` (`PROVIDER_ERROR` or `AUTH_REQUIRED`, `preview.output.releasedClaim`), `tool_call` (same code) | unchanged |
| Apply repeated on applied | `tool_call` (ok), stored result returned | `applied` |
| Apply refused by a gate | `apply_refused` (rejected, code), `tool_call` (rejected, code) | unchanged |
| Apply provider read error (lookup or re-check), an ambiguous write failure (timeout, network, `429`, `5xx`, unreadable `2xx`) whose lookup finds nothing, or a failed re-check after an earlier ambiguous attempt (note `an earlier write attempt may still be landing; retry later`); for a draft, only before gate 8b (after it, see the draft rows below) | `apply_refused` (error, `PROVIDER_ERROR`), `tool_call` (error, `PROVIDER_ERROR`) | unchanged |
| Apply `AuthRequiredError` at any provider call; for a draft, only before gate 8b (after it, see the releasing row above and the draft rows below) | `apply_refused` (rejected, `AUTH_REQUIRED`), `tool_call` (rejected, `AUTH_REQUIRED`) | unchanged |
| Apply on a stored plan with unknown kind / invalid shape | `apply_refused` (error, `INTERNAL`), `tool_call` (error, `INTERNAL`) | unchanged |
| Apply `PLAN_MODIFIED` / `STALE_PLAN` (incl. a differing or deleted event under our key) / `PROVIDER_ERROR` (a definite write rejection and the lookup finds nothing); for a draft, only before gate 8b (after it, see the draft rows below) | `apply_failed` (error, code), `tool_call` (error, code) | `failed` |
| Draft, after gate 8b, claim kept: an ambiguous write whose lookup finds nothing or fails, or a definite write failure whose lookup fails | `write_claimed` (ok), `apply_refused` (error, `PROVIDER_ERROR`; or rejected, `AUTH_REQUIRED` when the lookup needed a sign-in), `tool_call` (same code) | unchanged |
| Draft, after gate 8b: a differing draft under our key (`STALE_PLAN`, from the lookup under the claim, the write's result or the lookup after a failed write) or a definite write rejection whose lookup finds nothing (`PROVIDER_ERROR`) | `write_claimed` (ok), `apply_failed` (error, code), `tool_call` (error, code) | `failed` |
| Draft, after gate 8b: the final compare-and-set lost to another apply | `write_claimed` (ok), then `tool_call` (ok, stored result) if the plan is `applied`, else `apply_refused` (rejected, `NOT_APPROVED`), `tool_call` (rejected, `NOT_APPROVED`) | set by the other apply |
| Invalid input / unknown tool | `tool_call` (error, `INVALID_INPUT` / `UNKNOWN_TOOL`) | n/a |
| Other CLI command (`pending`, `export`, `auth`) | `cli_command` | n/a |

`tool_call.outcome` mapping: gate refusals (`WRITES_DISABLED`, `PROVIDER_NOT_CONFIGURED`, `UNKNOWN_ACTION`, `PLAN_EXPIRED`, `NOT_APPROVED`) and `AUTH_REQUIRED` are `rejected`; every other error code is `error`. For CLI rows, refusals with an approve or reject code (`NOT_A_TTY`, `UNTRUSTED_RUNTIME`, `CONFIRMATION_MISMATCH`, `ID_COLLISION`, `ALREADY_APPROVED`, `NOT_PENDING`, `PLAN_EXPIRED`, `PLAN_MODIFIED`, `UNKNOWN_ACTION`) are `rejected`.

`INVALID_INPUT` and `INTERNAL` `tool_call` rows are outcome `error` (only the five gate refusals and `AUTH_REQUIRED` above are `rejected`).

Every `tools/call` writes exactly one `tool_call` row, including calls rejected by SDK input validation and calls to unknown tools. If the ledger cannot be written, the response is replaced by an `INTERNAL` error. If the ledger cannot be opened at startup, the process exits (fail closed); this is a startup error, not a tool error.

## Plan shape: `calendar.create_event`

`actions.plan_json` for this kind (strict): `{ kind, rationale?, event, observed: { slotFree: true, etags } }`. `event` is `{ title, start, end, attendees: string[], sendUpdates, calendarId, timeZone? }`. `start` and `end` are UTC instants (ISO 8601, `Z`). `timeZone` is optional, an IANA name (`Europe/Berlin`, `UTC`; offsets and POSIX names are an invalid plan), and part of the plan hash; it is the zone the event was proposed in and is passed to the provider on create. `calendar_propose_event` always sets it, in canonical spelling (its `time_zone` input, else the server's `Config.timeZone`; `europe/berlin` is stored as `Europe/Berlin`, aliases keep their own name); it stays optional in the schema so plans stored before M3a remain valid.

**Display equals write.** The plan schema only accepts values the diff can print verbatim, so the text a human approves is exactly the text that is stored and written: `title` is 1 to 200 characters, one line of visible text (no control, format, bidirectional, zero-width or blank filler characters, no line breaks or tabs, single ASCII spaces between words only, none at either end); `calendarId` is 1 to 256 printable ASCII characters with no space; `attendees` is at most 50 email addresses, each 1 to 254 printable ASCII characters with no space; `start` and `end` are in the stored form `YYYY-MM-DDTHH:mm:ss.sssZ`; `timeZone` is at most 64 characters. A stored row that breaks any of these is an invalid plan: `pending` shows `(invalid plan)`, `approve` refuses it with `INTERNAL` before the prompt (check 5b) and `action_apply` does not write it.

The human diff (`deskhand pending`, `deskhand approve`, `action_explain.diff`) is rendered from the plan in the viewer's zone (`Config.timeZone`: `DESKHAND_TIMEZONE`, else the system zone), never one the plan chose. The viewer zone is not part of the plan and does not change `plan_hash`. Lines, in order:

1. `create event: <title>`, verbatim
2. `when: <start> to <end>` in the viewer's zone, e.g. `Thu 12 Nov 2026, 18:00 to 18:30 GMT+8 (Asia/Manila)`; a range across midnight or a zone change names both ends in full
3. `event zone: <range in event.timeZone>`, only when `event.timeZone` is set and differs from the viewer zone (both compared in canonical spelling, so a plan stored before canonicalisation as `europe/berlin` is still valid and shows no redundant line)
4. `utc: <start> to <end>` (always)
5. `calendar: <calendarId>`, verbatim
6. `<n> attendees` (`1 attendee` when there is one)
7. one line per attendee, in plan order: two spaces then the address, verbatim
8. the notification line: `no attendee notifications (sendUpdates=none)`; `will email <n> attendees` (`all`; `will email 1 attendee` for one); `will email the attendees outside your organisation, up to <n> (sendUpdates=externalOnly)`; or, for `all` / `externalOnly` with no attendees, `no attendee notifications (sendUpdates=<value>, no attendees)`. The stored `sendUpdates` value is always the one named.

No diff line ever contains a line break or a hidden character: the schema above refuses them, and `renderDiff` replaces any line break left in a line with a space as a backstop for future plan kinds. The CLI header (`id`, `tool`, `expires`, `hash`) is built from row columns, each flattened to one line; the hash prefix is printed only when `plan_hash` is 64 lowercase hex characters, else `(invalid)`.

**Terminal layout.** The CLI wraps every diff line (indented 4) and header line itself to the terminal width (`process.stdout.columns` on a TTY, else 80, at least 20), counting any non-ASCII character as two columns. Each row after the first starts with `    | ` (4 spaces, a bar, a space). A row breaks after its last double space, else its last space (never one in a leading indent), else between two characters; a character too wide for a row is split into code points, so every row fits. The width is stdout's when it is a terminal, else stderr's when that is one, else 80. `approve` refuses with `CONFIRMATION_MISMATCH` when the terminal got narrower between showing the plan and the answer. Lines that fit are printed unchanged.

**Terminal sanitising (`stripControl`, `oneLine`).** Untrusted text printed by the CLI has every hidden character removed: control characters (C0, DEL, C1, so ESC too), format characters (bidirectional marks, embeddings, overrides and isolates, zero-width characters, soft hyphen, tag characters, BOM), line and paragraph separators, lone surrogates, private-use characters, unassigned code points and noncharacters, default-ignorable code points (Hangul and Khmer fillers, variation selectors) and the characters designed to render blank (braille blank U+2800, U+303F, U+A8F9, U+13441, U+13442, U+16FE4, U+1D159). A title also may not stack more than four combining marks on one character, have a character of more than 8 code points, or start with a combining mark or other extender. Only those characters are removed, never the visible text after them: an escape sequence is not interpreted, so `ESC[31m` is printed as `[31m`.

### Plan shape: `mail.create_draft_reply`

Added in M4a (ADR 0010). `actions.plan_json` for this kind (strict):

```
{ kind: "mail.create_draft_reply", rationale?, rationaleSha256? /* 64 lowercase hex */,
  draft: { threadId, messageIdHeader, inReplyTo: string | null, references: string[],
           from: email, to: email[], cc: email[], bcc: email[], subject,
           body?: string, bodyRemoved?: true, bodyChars: number, bodySha256: string /* 64 lowercase hex */ },
  observed: { latestMessageId: string,
             messageIdsSha256?: string /* 64 lowercase hex; the tool always sets it */,
             onThread: string[] /* the recipients that are on the thread, lowercased */ } }
```

Exactly one of `body` and `bodyRemoved` is present. When `body` is present, `bodyChars` (its UTF-16 length) and `bodySha256` (the SHA-256 of its UTF-8 bytes) must match it. `from` is the owner's address (`MailProvider.profile()`). `messageIdHeader` is `<deskhand.<idempotency key>@deskhand.invalid>`. `observed.onThread` is computed by the tool from the provider and never taken from the agent, so the hash covers it. So does `observed.messageIdsSha256`: the lowercase hex SHA-256 of `JSON.stringify` of the thread's unique non-draft, non-trash, non-spam message ids, sorted by code unit, read through `MailProvider.threadMessageIds` (no message cap) before the tool reads the thread, so a message that arrives between the two reads makes the plan stale. It is optional in the stored schema so applied M4a plans stay valid history; `hashablePlan` keeps `observed`, and the sweep leaves it alone. The plan is hashed with `hashablePlan` (see Conventions), which leaves out `body` and `bodyRemoved`: the hash covers the body through `bodySha256`, so removing the body never changes `plan_hash`. `plan_json` must still equal the canonical JSON of the plan byte for byte, body included.

**The agent's reason (owner decision, 2026-11-23).** `rationale` is optional, 1 to 500 characters, and follows the subject's rule (`isPlainLine`). While the body is present, `rationale` and `rationaleSha256` (the SHA-256 of its UTF-8 bytes) are both absent or both present and matching; an edited, added or removed reason is `PLAN_MODIFIED` at approve and apply. `hashablePlan` leaves `rationale` out and keeps `rationaleSha256`, so the hash covers the reason and the sweep can remove it. A swept plan has no `rationale`.

**Display equals write for drafts.** As for calendar plans, the schema only accepts what the diff can print verbatim. A stored row that breaks a rule below is an invalid plan: `pending` shows `(invalid plan)`, `approve` refuses it with `INTERNAL` before the prompt (check 5b, except the body-integrity case above, which is `PLAN_MODIFIED`) and `action_apply` does not write it. The tool applies the same rules to its input and answers `INVALID_INPUT` with no plan row.

- `subject`: one line that passes `isPlainLine` (the title rules: no control, format, bidirectional, zero-width or blank filler characters, single ASCII spaces only, none at either end), 1 to 250 characters.
- Every address (`from`, `to`, `cc`, `bcc`): `z.email()`, at most 254 characters, printable ASCII (`^[\x21-\x7e]+$`), so a non-ASCII or internationalised address is refused. At least one `to`, at most 50 recipients in total, and no address repeated across `to`, `cc` and `bcc` (compared case-insensitively).
- `body`: 1 to 20 000 UTF-16 characters and at most 500 lines. The tool turns `\r\n` into `\n` before it validates, stores and hashes the body, so the stored text has only `\n` and a lone `\r` is refused. A trailing newline makes one empty last line. Each line is empty or passes `isBodyLine`: no hidden character (the `stripControl` set), no tab, no more than four stacked combining marks, no grapheme of more than 8 code points, no leading extender. Leading spaces and repeated spaces are allowed (quoting, indentation), up to 16 whitespace characters in a run, and at most 16 consecutive lines may be empty, so filler cannot move text out of the approver's view. A trailing space is refused, except on the exact signature separator line `-- ` (two dashes and one space; owner ruling, 2026-11-17).
- `threadId`, `observed.latestMessageId` and the `inReplyTo` and `references` values: printable ASCII; the header values are `<…>` shaped; `references` holds at most 10.

**Diff lines** (`deskhand pending`, `deskhand approve`, `action_explain.diff`, the `inbox_draft_reply` result), in order:

```
create draft reply (not sent; Deskhand cannot send mail)
thread: <threadId>
in reply to message: <latestMessageId>
from: <owner address>
subject: <subject>
agent's reason: <rationale>           (only when the plan still holds one)
new recipients: none                  (or: new recipients: <n> not on this thread)
to: <n> recipient(s)
  <address>                           (followed by "  (new: not on this thread)" when not in observed.onThread)
cc: <n> recipient(s)
  <address> ...
bcc: <n> recipient(s)
  <address> ...
body: <l> lines, <c> chars, sha256:<8 hex>
  > <body line>                       (an empty body line prints "  >")
end of body
```

`<n> recipient(s)` is printed as written (`1 recipient(s)`). The `cc` and `bcc` blocks are printed even when empty (`cc: 0 recipient(s)`, no address rows). `<l>` is the line count, `<c>` is `bodyChars`, and the 8 hex characters are the first 8 of `bodySha256`. For the approver the subject and every address are printed verbatim (the rules above are what make that safe); for the agent they are omitted markers (see Audiences). `new recipients:` counts the recipients, in to, cc and bcc, that are not in `observed.onThread` (compared case-insensitively).

**Audiences.** `renderDiff(plan, viewerTimeZone, audience)` takes `"approver"` (used by `pending` and `approve`) or `"agent"` (the default, used by `action_explain` and the tool result, so a call site that forgets the argument omits the body and never leaks it). The approver gets every body row. The agent gets the same lines with the body rows replaced by one row `  [omitted <c> chars sha256:<8 hex>]`, and (controller ruling R3, M4a Task 6) with the thread id, the latest message id, the subject, the agent's reason and every address value (the `from:` value and each to, cc and bcc row) replaced by its own marker `[omitted <n> chars sha256:<8 hex>]` (the redactor's `omittedMarker` of the value), each line keeping its shape: `thread: [omitted …]`, `in reply to message: [omitted …]`, `from: [omitted …]`, `subject: [omitted …]`, `agent's reason: [omitted …]`, `  [omitted …]` and `  [omitted …]  (new: not on this thread)`. Mailbox text therefore never reaches the agent or a preview in clear through a diff. A calendar plan renders identically for both. A plan with `bodyRemoved` prints, for both audiences, `body removed after the action ended (<c> chars sha256:<8 hex>)` in place of the `body:` line, its rows and `end of body`.

**No body text can pose as a field.** Every body row starts with `  > `, and the CLI's continuation rows start with `    | ` (the M3a wrapping, unchanged). Body text therefore cannot start a row that looks like a field (`to:`), the `end of body` line or the approve footer; the fixed `end of body` line closes the body.

**Approve summary (owner ruling, 2026-11-17).** For a draft plan only, `deskhand approve` prints between the diff and the typed-confirmation prompt, so the key facts sit next to the prompt even when the body is long:

```
subject: <subject>
body: <n> lines, <n> chars            (or: body: removed)
summary: to <n>, cc <n>, bcc <n>
new recipients: none                  (or: new recipients: <n> not on this thread)
```

The subject comes first because the sender controls it and it may wrap, so the last rows above the prompt are always fixed text. The lines are wrapped by the same rules as the diff. They are printed for the approver only; `pending`, `action_explain` and calendar approvals are unchanged. They are display only and are not stored.

**The body exception and its limits (ADR 0010).** This is the only place a mailbox-derived body is stored. It lives only in `actions.plan_json` under `draft.body`. It is replaced by `[omitted N chars sha256:<8 hex>]` everywhere else: `actions.input_json` (the tool input key is `body`), every `events.preview_json`, `ledger_query`, `action_explain` (`plan` through the kind's `explainPlan`, and `diff`), the `inbox_draft_reply` and `action_apply` results, and the fixture `write_log` line. `result_json` stores the `DraftRef` (ids, header, addresses, subject) and `bodySha256`, never the text.

**The sweep and `bodyRemoved`.** `sweepDraftBodies` rewrites the `plan_json` of a draft row that still has `draft.body` (or a swept row that still has `rationale`) to the canonical JSON of the plan with `body` and `rationale` deleted and `bodyRemoved: true` (keeping `bodyChars`, `bodySha256` and `rationaleSha256`) when its status is `applied`, `rejected` or `failed`, or when its status is `planned` or `approved` and `now >= expires_at` (an unparseable `expires_at` counts as expired). It runs in one `BEGIN IMMEDIATE`, changes no other column (`plan_hash` and `approved_plan_hash` stay valid because `hashablePlan` leaves out `rationale`, `body` and `bodyRemoved`), writes no `events` row, and never touches an unexpired `approved` row. It runs at server start, after every `action_apply`, after `deskhand reject`, and at the start of `deskhand pending` and of `createPlan`. Every sweep, including one that changed no rows, then runs `PRAGMA wal_checkpoint(TRUNCATE)` with `busy_timeout` 0 (restored afterwards), best effort: a busy checkpoint returns at once and the next sweep retries it. The removed text leaves `ledger.db` and `ledger.db-wal` in that sweep when no other connection has an open read or write transaction. Until then, the removed text can remain in `ledger.db` and `ledger.db-wal`, including after a crash. The next successful sweep checkpoint, or a clean close of the last connection, removes it. The database sets `PRAGMA secure_delete = ON`. Copies and backups of `ledger.db` made before the sweep still hold the text (SECURITY.md). Editing a body of an unswept plan is caught by the body-integrity rule (approve and apply give `PLAN_MODIFIED`); a plan that has lost its body can never be written (approve and apply refusals above).

## `preview_json`

Shape: `{"v":1,"input":<redacted>,"output":<redacted|null>,"note":<string|null>}`; lifecycle previews may also carry `"action_id"`.

- `input`: the tool arguments (or CLI arguments) after redaction. `output`: the structured result after redaction, or `null` when there is none. `note`: short free text. The listed values are examples: `recovered`, `cancelled`, `preview failed`; on error and refusal rows (`tool_call` errors, `apply_refused`, `apply_failed`, `approve_refused`) it is the redacted human-readable error message; `null` otherwise. Success rows carry `null` unless one of the documented notes applies.
- Redaction is one function with a leak test, applied recursively to all strings and keys:
  1. Object keys matching `/token|secret|password|authorization|credential|api[_-]?key|private[_-]?key|cookie|passphrase/i` (substring, case-insensitive; a bare `auth` is deliberately not matched, it would hit `author`) have their value replaced by the string `"[redacted]"`.
  2. Values of keys matching `BODY_KEY`, `/^(body|html|content|text|snippet|body_text|html_body|raw|subject)$/i` (whole key, any depth; widened in M4a from `body|html|content`), store no text at all. These are the real names: the tool output fields `snippet` and `body_text`, the untrusted wrapper's `content`, the tool input key `body`, `raw`, which the M4b Gmail MIME code uses, and `subject` (controller ruling R3, M4a Task 6: the `inbox_draft_reply` input key and every mail `subject` field, so a subject is never in a preview in clear, even one an agent typed). Addresses are not body keys; in tool output they sit inside an untrusted wrapper's `content` (or, in a draft diff for the agent, are already omitted markers), so previews omit them. The value is replaced by the string `[omitted N chars sha256:<first 8 hex>]`, where N is the UTF-16 length (JavaScript `string.length`) and the hash is over the full string. A non-string value is hashed over its canonical JSON and N is that JSON's character count.
  3. Every other string longer than 200 characters is cut to its first 200 characters followed by `…[truncated sha256:<first 8 hex of the full string>]`.
  4. The serialised preview is capped at 4096 bytes (UTF-8). If it is larger, `output` is replaced by the string `"[omitted]"`; if still larger, `input` is too; if still larger, `note` is truncated to 200 characters (and any other top-level field is dropped). `note` and `action_id` are always kept.
  5. Nesting deeper than 32 levels is replaced by the string `"[omitted: too deep]"` (depth counted from the preview root). Canonical JSON used for omitted non-string values refuses input deeper than 256 levels, in which case the omission is described as `[unserialisable]`.
  6. `tool_call` rows of `inbox_*` tools (M4a review): a failed call stores its whole `input` as one omitted marker and the fixed note `inbox call refused or failed; details omitted` (`error_code` says what happened; a cancelled call keeps the note `cancelled`, and a minimal retry row keeps `input: "[omitted]"` and the note `preview failed`). An accepted call stores `rationale`, `reason`, `labels`, `query`, `to`, `cc` and `bcc` as omitted markers in `input` and `output`. An `action_explain` row stores every `rationale` in its `output` as an omitted marker. `actions.input_json` of a draft plan stores `rationale`, `to`, `cc` and `bcc` the same way.
- Rule 1 takes precedence over rule 2 for a matching key.

**Free-text secret scrubbing (`scrubSecrets`, Ruling 18, M3b fix waves 12-17).** `scrubSecrets` has two callers. (1) `apply.ts` `errText`: provider error text that apply stores in `actions.error` or in an `apply_refused` / `apply_failed` note, and returns from `action_apply`, passes through it before the redactor above; apply's own prefixes (`Provider write failed: `, `Provider lookup … failed: `) are added outside it. (2) `LoggingTransport` (wave 17): a `tool_call` row's `preview.note` passes through it whenever the text is not Deskhand's own, that is a JSON-RPC error message, or an error result without a valid `_meta.deskhand` error code (an SDK-built error or a thrown handler's message). A `toolError` result's text is stored as is. Only the stored note is scrubbed; the response forwarded to the client is unchanged. The other error paths carry only fixed text and are not scrubbed: `cli:auth` notes and stderr hold `OAuthError` / `ConfigError` sentences (fixed, or a fixed sentence with a file path), and the calendar tools' errors (`provider-guard.ts`) hold `AuthRequiredError` / `ProviderError` messages, built from fixed phrases, the HTTP status and a letters-only `reason` word (`^[A-Za-z]{1,40}$`), never response text.

`scrubSecrets` is all-or-nothing: if the text, or any of its decoded forms, looks like it holds a secret, the result is the fixed sentence `[redacted: text contained secret-like data]`. Otherwise the text is returned unchanged. Nothing is rewritten in place, so no partial redaction can leave a secret next to a `[redacted]`. There is no `[redacted]` exemption.

- **The predicate `looksSecret`.** It is case-insensitive and substring-based, with no word boundary, so `xaccess_token` counts. It matches any of:
  - **Token shapes:** `ya29.` followed by 10 or more of `[\w-]`; `1//` followed by 10 or more; `gocspx-` followed by 6 or more; the auth code `4/0` followed by 10 or more.
  - **A three-part JWT,** found by a linear scan: within a maximal run of `[\w.-]` split on `.`, three consecutive non-empty segments where the first holds `eyJ` with at least one character after it.
  - **A key word followed by a value:** `access_token`, `refresh_token`, `id_token`, `client_secret` (each also without the underscore), `authorization`, `bearer`, `api_key`, `apikey` or `password`, followed by a separator run of whitespace, quotes, `:` and `=` (any length, possibly empty) and then any other character. The bare word with nothing after it does not count.
  - **`code`** followed the same way by `4/`.
- **The decoded forms (`searchForms`, Rulings 19 and 20).** The check covers every form the text can take under any order of three operations:
  - strip: delete every backslash; no escape is interpreted;
  - decode: one percent-decode round; a malformed `%` stays;
  - plus: read `+` as a space.

  The forms come from a bounded breadth-first search that starts at the text as written. Each search step applies every operation to every form and keeps only new forms. A path may hold at most 4 decode rounds, and the search keeps at most 64 distinct forms. The predicate runs on each form as it is found, and the check stops at the first match. If the search cannot finish, the result is the fixed sentence (Ruling 20, fail closed). That happens when it would need a 65th form, or when a form that has already taken 4 decode rounds would still change under a fifth. Unrelated padding therefore cannot use up the cap and hide a secret further down the search. Benign text stays far below the cap: a test runs every string literal in `src/` and ordinary prose and URLs through the search, and each finishes with fewer than 32 forms. Because every order is covered, no single fixed order can hide a key word. A backslash inside a `%XX` triplet (`%\61`) is stripped before a decode. A key word that a later round would decode away is checked first: `%a\ccess_token` reads as `%access_token` before `%ac` becomes one character. A key word that the same round both completes and destroys is also caught: `%a\c%63ess_token` is decoded with its backslash still in place. Decoding never throws.
- **Accepted over-redaction.** Prose with a key word followed by anything fails closed, for example "the bearer of good news", "passwords" and "missing access_token in the response". So does a text with an empty secret value, `zip code + 4/5`, and any error that merely contains a token shape. The detail lost costs nothing today, because only Deskhand's own fixed error sentences reach `scrubSecrets` (through `apply.ts` `errText`).
- **Accepted under-redaction.** Token shapes shorter than the minimums above pass, for example `ya29.a0.b`. Real Google tokens are far longer.
- **Cost.** It is linear in the text length with a constant factor. The search produces at most 64 forms, and each form is built by one pass (decode is a plain scan, not a regex callback) and checked once. The tests check growth, not absolute time. Each adversarial input is timed at about 10 KB and about 100 KB, using the median of 3 runs, and the 100 KB time must stay under 25 × the 10 KB time + 5 ms. Linear work grows about 10×; quadratic work would grow about 100×. A 2 s ceiling per input guards against a hang. The cap-reaching worst case measured about 21-25 ms at 100 KB on a development machine. The separator run in the predicate is matched atomically (it is never re-tried shorter, and the run class and the next character are disjoint). JWTs are found by the scan, not a regex, because `eyJ[\w-]+\.` alone backtracks quadratically on long runs of `eyJ` with no dot.
- **What survives.** A fixed prefix that apply puts before the scrubbed text (for example `Provider write failed: `) sits outside the scrub and survives. Every string literal in `src/` passes through unchanged except four non-messages, which a test lists: the file name `client_secret.json`, the status line naming it, the `Bearer` header value, and the OAuth `authorization_code` grant type.

`actions.input_json` follows the same redaction. `plan_json` and `result_json` are stored in full because the hash and the apply need them. They never contain mailbox bodies (plans hold only what the write needs; the plan tools are responsible for not copying bodies into `plan_json`), with one exception: the body of a draft the agent wrote, in `plan_json` under `draft.body`, for a bounded time (ADR 0010; "Plan shape: `mail.create_draft_reply`" above). `result_json` never holds a body, only `bodySha256`.

## CLI-originated rows

`cli_command` rows have `tool = cli:<command>` and `preview.input` holding the command's arguments (action id, reason; never the typed confirmation). Typed confirmation text is never stored.

`cli:auth` rows (`deskhand auth login | status | upgrade`) have `preview = { v: 1, input: { subcommand }, output: { scopes } | null, note }`. `subcommand` is `login`, `status`, `upgrade`, or null for a usage error (`deskhand auth`, `deskhand auth bogus`, extra arguments: exit 2, `INVALID_INPUT`, note `usage: deskhand auth login | status | upgrade`; `runCli` hands every `auth` invocation to the command so this row is always written). `output.scopes` lists the granted scopes (login/upgrade success, or status with a token); `note` is NULL on success, else the one-line failure message. Failures use `outcome = error` with `AUTH_REQUIRED` (denied, expired, no token), `INVALID_INPUT` (bad or missing client file, usage, `upgrade` without `DESKHAND_ALLOW_WRITES=1`) or `PROVIDER_ERROR` (token endpoint failure). A row never contains a token, the client secret, the authorization code or the OAuth `state`.
