# ASSUMPTIONS

Closed by the owner on 2026-11-07 (round 1, round 2 and review answers now in SPEC/ADRs; Tempo v0.1.0 is published, 2026-11-06): approval flow and typed confirmation (last 4 chars of action id), drafts only, expenses + CSV export, itinerary input, plan expiry 24 h (1 h–7 d), Tempo pin, package/bins, Node `>=24.15`, MIT, two-table ledger, reject without TTY (method logged), `%LOCALAPPDATA%`, SQLite driver.

Calls I made after the builder check (reversible; please skim): ledger `kind`/`error_code` vocabulary and row sequences, `expenses` table and fields, `deskhand auth` command, Gmail draft idempotency via deterministic Message-ID, counterparty rules as tool input (all in ARCHITECTURE).

**Closed 2026-11-09 (consistency pass):**
- `schema_version` table dropped; `PRAGMA user_version` only, migrations in `src/ledger/migrations/`.
- Three tables: `actions`, `events`, `expenses`; `expense_log` is a plan tool, the expense row is written only on apply (ADR 0003).
- Action id: regenerated at plan time if its last 4 collide with a pending plan; `approve` keeps the refusal as a defensive check; both tested (ADR 0002).
- `ping` is a permanent tool with snapshot-tested schemas; no ledger row in M1 only because the ledger does not exist yet, M2 adds it (SPEC §4, ROADMAP).
- Drafts only is enforced in code (`MailProvider` has no send method, test asserts no send endpoint), because `gmail.compose` allows sending (ADR 0007, SECURITY.md).
- `deskhand auth` is a scheduled M3 deliverable; the contract documents are M2 deliverables (ROADMAP).
- `approve` refuses expired plans; every failed approval is an `events` row with status unchanged (ADR 0002, TEST_PLAN).
- Deny rules: canonical invocation `npx -p @marvinliem/deskhand-mcp deskhand approve <id>`; rules cover `deskhand`, `npx`, `pnpm exec`, `node dist/cli.js`; best-effort (SECURITY.md).
- Triage only proposes in v1; no `gmail.modify`; applying labels is post-v1 with its own ADR.
- `sendUpdates` defaults to `none`; notifying attendees must be stated in the diff and is covered by the plan hash.

**Closed 2026-11-10 (M2a contract documents):**
- **Action id format:** `act_` + 26-char Crockford-base32 ULID; the confirmation is the last 4 characters (random part), compared case-insensitively after trimming. `events.id` is `INTEGER AUTOINCREMENT`.
- **Fixture world shape:** `fixture_version: 1`, JSON only, `DESKHAND_FIXTURE`, `now` fake clock, `calendars`, optional `settings.latency_ms` and `settings.write_log` (`docs/fixture-format.md`).
- Documents: `docs/ledger-contract.md` (DDL, value sets, gate order, row sequences, redaction), `docs/fixture-format.md`, `docs/tools-contract.md`.

**Calls I made in M2a (reversible; please skim):**
- `error_code` adds `UNKNOWN_TOOL` and `NOT_PENDING` to the ARCHITECTURE list (`NOT_PENDING`: approve/reject on `rejected`/`failed`/`applied`; `ALREADY_APPROVED`: on `approved`).
- Apply gate order: `WRITES_DISABLED`, `UNKNOWN_ACTION`, replay if applied, `NOT_APPROVED`, hash check (`PLAN_MODIFIED`), recovery (provider already holds our idempotency key: finalise `applied`, `replayed: true`, no second write), `PLAN_EXPIRED`, re-check (`STALE_PLAN`), provider write (`PROVIDER_ERROR`). Idempotency key is the lowercase hex SHA-256 of the action id.
- Lifecycle rows are written before the `tool_call`/`cli_command` row; `tool_call` outcome is `rejected` for gate refusals and `error` otherwise.
- Redaction: keys `body`/`html`/`content` store no text (`[omitted N chars sha256:<8 hex>]`); other strings over 200 chars truncated with a hash; secret-like keys `[redacted]`; preview capped at 4 KB.
- An `approved` plan cannot be rejected (`ALREADY_APPROVED`); a refused reject writes only a `cli_command` row. `expenses.id` uses the action-id format and `expenses.action_id` is unique. Ledger open failure at startup exits the process (fail closed).
- Approve check order: TTY, exists, status, expiry, `PLAN_MODIFIED`, `ID_COLLISION`, typed confirmation (matches the M2b plan).
- `[omitted N chars ...]`: N is the UTF-16 length.
- Redaction depth cap of 32 levels (`[omitted: too deep]`); the preview size cap omits output, then input, and always keeps `note`/`action_id`.
- `events.tool` is stored capped at 200 characters.
- `tool_call` error rows store the redacted error message in `preview.note`.

**Open assumptions (recorded, to settle later):**
- **BODY_KEY widening:** `body|html|content` may need `text`, `snippet`, `body_text`, `html_body`; settle with the real M3/M4 field names.
- **Draft-reply plans (M4):** a plan must hold the drafted body in `plan_json`, which conflicts with "never log full email bodies"; needs an ADR before M4.
- **`action_explain` window:** it reads the last 1000 events, which repeated explains of the same action can dilute.
- **Deskbench/Deskflow access to the ledger:** the contract is the documented ledger schema plus `ledger_query` output. Whether they may read `ledger.db` directly is decided during Deskbench planning.

**For M3 (recorded 2026-11-10):** the Google Calendar adapter must treat a `409` on `events.insert` with our idempotency-derived event id as "already created": fetch that event and return it, never retry with a new id. This keeps the apply recovery path (M2b) honest against the real API.

**M2b Task 3 review rulings (recorded 2026-11-10):**
- A provider **read** error during apply (recovery lookup, re-check, or a post-failure lookup) is retryable: `apply_refused` / `PROVIDER_ERROR`, status stays `approved`. Only a confirmed write failure (createEvent rejected and a follow-up lookup finds no event under our key) makes the plan `failed`.
- After a failed re-check or a failed write, apply looks up our idempotency key again and finalises `applied` (`recovered`) if our event exists, so the ledger never says `failed` while our event is in the calendar.
- `CalendarProvider.createEvent` with an existing key must return the existing event (documented on the interface); M3's Google adapter maps the `409` accordingly.
- The expiry gate fails closed (`now >= expires_at` or unparseable is expired).

Still open or unverified:

1. **Calendar idempotency:** I rely on Google Calendar accepting a client-supplied event id for apply idempotency. To be verified against the API when the adapter is built (M3).
2. **npx bin rule for scoped packages** is inferred from npm-exec docs wording; the M6 smoke test is the real proof.
3. **Export columns / date semantics** are left to the plan (owner's instruction).
4. **macOS data dir** (`~/Library/Application Support/deskhand`) is my choice, not specified.
5. **Windows file protection** relies on the user-profile ACL; POSIX modes (0700/0600) are not applied there.
6. The Claude Code deny-rule syntax was checked against the permissions docs on 2026-11-09 (`Bash(cmd *)`, space before `*`; `:*` is an equivalent suffix form; deny rules match command text, so they are best-effort). Re-check when the README is written.

**M1 findings (2026-11-09), recorded so none is lost:**
- **TypeScript is pinned exactly to `7.0.2`** (the lockfile version). TS 7 is the native compiler and ships platform binaries as optional dependencies (`@typescript/typescript-<platform>`); it is build-time only and not a Node addon, so the "no native modules" rule is not triggered. Pinned so CI and local builds cannot drift. Bump deliberately.
- **`@types/node` is `~24.19.2`:** no 24.15.x exists on npm. Types may allow a few APIs that Node 24.15 lacks; CI on Node 24.15 is the guard.
- **pnpm `engineStrict` only checks dependencies' `engines`, not the root package's** (`pnpm-workspace.yaml` sets it; `.npmrc` `engine-strict` is ignored by pnpm 12). The runtime `assertSupportedNode` check is what enforces the Node floor.
- **`.gitattributes` is `* text=auto eol=lf`** repo-wide so shebang files cannot get CRLF.
- **Inspector is pinned to 1.0.4** (2.x needs Node `^24.22.1`, above our floor); it prints a deprecation banner. Re-evaluate when the floor moves. The M1 check used `mcp-inspector --cli`; the UI route (`pnpm inspect`) is a manual owner check.
- **Parked from M1 review, scheduled in ROADMAP:** M2: stdin-close `process.exit` vs in-flight async work (with test). **Done in M2b Task 6** (`src/shutdown.ts`: drain tracked handlers and response flushes, close the ledger, exit). M6: local-publish guard, `repository` field, CI action versions and push/PR trigger. Minor, no milestone: `server.ts` entry guard is silent for an extensionless path (`node dist/server`; bins are unaffected); the CLI stub test does not assert milestone labels.

**M2b shutdown limits (Task 6, 2026-11-10):**
- **The stdin-close drain is capped at 10 s by default.** A real Google write in M3 that is still running at the cap is cut off (exit 1). The re-check and the idempotency key make the retry safe: the recovery gate finds the event and records it as `applied`.
- **SIGINT/SIGTERM keep Node's default immediate exit** (M1 behaviour). A SIGTERM mid-apply can leave a provider write without its `applied` row; recovery handles it on the next `action_apply`.
- **Exit after a failed stdout flush reports the original code.** If stdout never drains (the client is alive but not reading), the 2 s fallback exits with the drain's code, not 1. A client that closed stdout (EPIPE and similar) counts as gone: no log, exit 0.

## Builder-check findings (2026-11-07), to resolve in M2

Contract gaps, all now scheduled as M2 deliverables (write `docs/ledger-contract.md`, `docs/fixture-format.md`, `docs/tools-contract.md` first): fixture world format (JSON only, `DESKHAND_FIXTURE`, deterministic clock/id seed); full ledger DDL, id formats, `preview_json` shape; diff rendered from `plan_json` by one deterministic function, never agent text; status transition table + CLI error codes + apply gate order vs idempotent replay; per-column redaction and fixed truncation for `input/plan/result_json`; `amount_minor` currency exponent.

Safety items now covered in SECURITY.md / TEST_PLAN: logging around SDK input validation and unknown tools, fail closed if the ledger cannot open; CLI strips control/ANSI characters; deny-rule variants; `sendUpdates=none`; `deskhand auth` test rows.
