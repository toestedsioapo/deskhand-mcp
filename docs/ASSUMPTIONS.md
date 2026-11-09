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

**Open assumptions (recorded, to settle later):**
- **Fixture world shape:** settled in M2 with `docs/fixture-format.md`; until then everything about the format is provisional (JSON only, `DESKHAND_FIXTURE`, deterministic clock/id seed are the working proposal).
- **Deskbench/Deskflow access to the ledger:** the contract is the documented ledger schema plus `ledger_query` output. Whether they may read `ledger.db` directly is decided during Deskbench planning.

Still open or unverified:

1. **Action id format** is not decided: it must make "last 4 chars" a usable confirmation (ADR 0002 regenerates on a last-4 collision at plan time). The plan should pick the format (e.g. ULID, which has a time-ordered prefix and random tail, or random base32; the last 4 must come from the random part).
2. **Calendar idempotency:** I rely on Google Calendar accepting a client-supplied event id for apply idempotency. To be verified against the API when the adapter is built (M3).
3. **npx bin rule for scoped packages** is inferred from npm-exec docs wording; the M6 smoke test is the real proof.
4. **Export columns / date semantics** are left to the plan (owner's instruction).
5. **macOS data dir** (`~/Library/Application Support/deskhand`) is my choice, not specified.
6. **Windows file protection** relies on the user-profile ACL; POSIX modes (0700/0600) are not applied there.
7. The Claude Code deny-rule syntax was checked against the permissions docs on 2026-11-09 (`Bash(cmd *)`, space before `*`; `:*` is an equivalent suffix form; deny rules match command text, so they are best-effort). Re-check when the README is written.

## Builder-check findings (2026-11-07), to resolve in M2

Contract gaps, all now scheduled as M2 deliverables (write `docs/ledger-contract.md`, `docs/fixture-format.md`, `docs/tools-contract.md` first): fixture world format (JSON only, `DESKHAND_FIXTURE`, deterministic clock/id seed); full ledger DDL, id formats, `preview_json` shape; diff rendered from `plan_json` by one deterministic function, never agent text; status transition table + CLI error codes + apply gate order vs idempotent replay; per-column redaction and fixed truncation for `input/plan/result_json`; `amount_minor` currency exponent.

Safety items now covered in SECURITY.md / TEST_PLAN: logging around SDK input validation and unknown tools, fail closed if the ledger cannot open; CLI strips control/ANSI characters; deny-rule variants; `sendUpdates=none`; `deskhand auth` test rows.
