# ARCHITECTURE — Deskhand MCP

Status: DRAFT. ESM-only, TypeScript strict, Node floor per ADR 0004.

## Layout

```
src/server.ts           MCP wiring (stdio), tool registration
src/tools/              one file per tool: Zod schemas + handler
src/approval/           plan store, hashing, approval source, apply engine
src/ledger/             db open (pragmas), schema, migrations, queries
src/providers/
  types.ts              CalendarProvider, MailProvider interfaces
  google/               real adapters (recorded-response tests only)
  fixture/              in-memory fake world (versioned JSON/YAML format)
src/tempo/              the ONLY place that imports @marvinliem/tempo-core
src/cli/                `deskhand` bin: pending | approve | reject | export | auth
src/config/             env, scopes, paths (DESKHAND_HOME resolution)
scripts/gen-tool-docs.ts   schemas -> docs/tools.md
```

Rules: tools never import `providers/google` directly (inject via interface); nothing outside `src/tempo/` imports Tempo; nothing outside `src/ledger/` touches SQLite.

## Data flow (write path)

```
agent --calendar_propose_event--> tool handler
   -> validate, build plan_json, plan_hash, expires_at
   -> ledger: actions(status=planned) + events row
human --deskhand approve <id>--> CLI (TTY + diff + typed last 4)
   -> refuse if expired / not planned / hash mismatch (events row, status unchanged)
   -> recompute hash, ledger: status=approved, approved_plan_hash
agent --action_apply(id)--> apply engine
   -> gates (writes flag, exists, replay if applied, approved, hashes equal, recovery, not expired)
   -> provider re-check (free/busy, etag/updated)  --stale--> failed STALE_PLAN
   -> provider write (idempotency key from id) -> status=applied, result_json
```

The server and CLI are separate processes sharing the ledger file. The CLI never runs provider writes; only the server's `action_apply` does.

## Ledger (contract, versioned via `PRAGMA user_version`)

`actions(id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status, approved_by, approved_at, approval_method, approved_plan_hash, rejected_at, rejected_reason, rejection_method, applied_at, result_json, error)`
`approval_method ∈ cli_tty` (reserved for later: `mcp_elicitation`, `deskflow`); `rejection_method ∈ cli_tty | cli_no_tty`; `approved_by` is the OS username.
`status ∈ planned | approved | applied | rejected | failed`

`events(id, ts, action_id NULL, tool, kind, outcome, error_code, preview_json)` — append-only; one row per tool call (reads included, failures and rejections included) and per lifecycle transition. `outcome ∈ ok | error | rejected`. Previews are redacted (no tokens, bodies truncated/hashed).

Three tables (`actions`, `events`, `expenses`; ADR 0003). PLAN.md's single `actions` table can't record read-tool calls, which CLAUDE.md requires. `events` covers that; `actions` is the current-state row; `expenses` is described below. **All three tables, their columns and the `status`/`outcome`/`kind`/`error_code`/method value sets are the Deskbench/Deskflow contract**, documented as such in `docs/ledger-contract.md` (M2, written before migration 1) and versioned explicitly: `PRAGMA user_version` is the only schema version (no `schema_version` table), bumped by forward-only migrations in `src/ledger/migrations/`; breaking changes bump the package major. Triggers prevent UPDATE/DELETE on `events`. Whether Deskbench/Deskflow read `ledger.db` directly or only via `ledger_query` is decided during Deskbench planning; the documented schema plus `ledger_query` output is the contract either way.

Transitions are compare-and-set inside `BEGIN IMMEDIATE`: `UPDATE actions SET status='approved' ... WHERE id=? AND status='planned'`; zero rows changed means refuse and log.

## Ledger vocabulary and row sequences (proposed; part of the contract)

- `events.tool`: MCP tool name, or `cli:pending|approve|reject|export|auth` for CLI-originated rows.
- `events.kind ∈ tool_call | cli_command | plan_created | approved | approve_refused | rejected | applied | apply_refused | apply_failed`.
- `events.outcome ∈ ok | error | rejected`; `error_code ∈ INVALID_INPUT | WRITES_DISABLED | UNKNOWN_ACTION | PLAN_EXPIRED | NOT_APPROVED | ALREADY_APPROVED | NOT_A_TTY | CONFIRMATION_MISMATCH | ID_COLLISION | UNKNOWN_TOOL | NOT_PENDING | PLAN_MODIFIED | STALE_PLAN | PROVIDER_ERROR | AUTH_REQUIRED | INTERNAL | UNTRUSTED_RUNTIME`. `UNTRUSTED_RUNTIME` is `deskhand approve` refused under a preload, loader or inspector flag (speed bump, SECURITY.md). `UNKNOWN_TOOL` is for a `tools/call` naming an unregistered tool; `NOT_PENDING` is the approve/reject refusal for a plan whose status is `rejected`, `failed` or `applied` (`ALREADY_APPROVED` is for `approved`). The final set is fixed in `docs/ledger-contract.md`, which wins on any difference.
- Types: ids `TEXT` (`act_` + 26-char ULID; format fixed in `docs/ledger-contract.md`), timestamps `TEXT` ISO-8601 UTC with milliseconds and `Z`, JSON columns `TEXT`. Nullability per column is specified in `docs/ledger-contract.md` (M2 deliverable, written before migration 1).

Rows per flow (lifecycle rows are written first and the `tool_call`/`cli_command` row last; exact order in `docs/ledger-contract.md`): read tool (`ping` included, from M2) → 1 `tool_call`. Plan tool → `tool_call` + `plan_created`. Approve → `cli_command` + `approved`. Approve refused (wrong last 4, expired, already approved, hash mismatch, no TTY, id collision) → `cli_command` (rejected) + `approve_refused`, **action status unchanged**. Reject → `cli_command` + `rejected`. Apply ok → `tool_call` + `applied`. Apply repeated on an applied action → 1 `tool_call` (ok, stored result returned). Apply refused by a gate (`WRITES_DISABLED`, `UNKNOWN_ACTION`, `PLAN_EXPIRED`, `NOT_APPROVED`) → `tool_call` (rejected) + `apply_refused`, **action status unchanged**. `PLAN_MODIFIED`, `STALE_PLAN` and provider failures → `tool_call` (error) + `apply_failed`, **status becomes `failed`** (terminal).

## Expenses

The third table, `expenses(id, action_id, date, amount_minor, currency, category, merchant, note, created_at)`, lives in the same `ledger.db` with the same `user_version` migrations, and is covered by the same contract document. `expense_log` is a plan tool: it creates an `actions` row only, and the `expenses` row is inserted by `action_apply` and nothing else, so there is no side effect outside apply. Fields are my proposal (no receipts in v1). `deskhand export expenses` reads it.

## Auth (M3 deliverable, in ROADMAP, SPEC §6 and TEST_PLAN)

`deskhand auth login | status | upgrade` runs a loopback OAuth flow with the user's own client file (`client_secret.json` in the config dir) and stores `token.json` (ADR 0007). Enabling `DESKHAND_ALLOW_WRITES=1` after login needs `deskhand auth upgrade` to add write scopes. The server starts without a token; Google-backed tools return `AUTH_REQUIRED` (logged). The fixture provider needs no auth.

## Gmail draft idempotency (to verify against the API in M4)

`drafts.create` has no client-supplied id. The draft gets a deterministic `Message-ID` derived from `action_id`; before creating, apply searches drafts for that Message-ID, so a retry after a crash finds the existing draft instead of making a second. Draft id is stored in `result_json`.

## `calendar_find_slots` rules

The caller's own rules come from config; the counterparty's rules are caller-supplied tool input validated against Tempo's `rules.schema.json` shape (through `src/tempo/`). The fixture world can also carry rule sets per person.

## Canonical JSON for `plan_hash`

UTF-8, object keys sorted recursively, no insignificant whitespace, no `undefined`, numbers via `JSON.stringify`, dates as ISO-8601 strings in UTC. Same function used at plan, approve and apply. Unit-tested with fixed vectors.

## Calendar notifications

`calendar_propose_event` defaults `sendUpdates` to `none`. If a plan would notify attendees, the rendered diff says so in plain words ("will email 3 attendees") and the setting is part of `plan_json`, so it is covered by `plan_hash`. The diff is rendered from `plan_json` by one deterministic function, never from agent-supplied text.

## Apply-time re-check (D5)

Provider interface exposes `freeBusy(range)` and `getEvent(id)` returning an `etag`/`updated`. A calendar plan records the observed `etag`s and the slot it assumed free. At apply: slot still free **and** referenced events unchanged, else `STALE_PLAN` (no write, status `failed`, event logged, error tells the agent to re-plan). Mail drafts: re-check the thread's latest message id.

## Fixture world

Versioned file format (`fixture_version`), loaded by `providers/fixture`. Contract for Deskbench and Deskflow. The shape is settled in M2 and written down in `docs/fixture-format.md` (an assumption until then, see ASSUMPTIONS).

## Contract documents (M2, before the code they describe)

`docs/ledger-contract.md` (full DDL, id formats, nullability, `preview_json` shape, status transition table, CLI error codes, apply gate order vs idempotent replay), `docs/fixture-format.md`, `docs/tools-contract.md` (tool schemas and `ping`). `docs/tools.md` stays generated (M5).

## Tempo adapter

`src/tempo/index.ts` re-exports the narrow functions Deskhand uses (e.g. slot finding) with Deskhand-owned types. `tests/tempo.contract.test.ts` pins behaviour over fixed inputs (using tempo-core's shipped `fixtures/*`), so a future Tempo bump fails here loudly.

## Packaging

`bin: { "deskhand-mcp": "dist/server.js", "deskhand": "dist/cli.js" }`, `"type": "module"`, `engines.node: ">=24.15"` (ADR 0004), MIT license. Publish only from GitHub Actions with provenance.
