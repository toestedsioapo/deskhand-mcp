# ASSUMPTIONS

Closed by the owner on 2026-11-07 (round 1, round 2 and review answers now in SPEC/ADRs): approval flow and typed confirmation (last 4 chars of action id), drafts only, expenses + CSV export, itinerary input, plan expiry 24 h (1 h–7 d), Tempo pin, package/bins, Node `>=24.15`, MIT, two-table ledger, reject without TTY (method logged), `%LOCALAPPDATA%`, SQLite driver.

Calls I made after the builder check (reversible; please skim): ledger `kind`/`error_code` vocabulary and row sequences, `expenses` table and fields, `deskhand auth` command, Gmail draft idempotency via deterministic Message-ID, counterparty rules as tool input (all in ARCHITECTURE).

**Awaiting owner answers (builder check):** triage apply behaviour and Gmail scope; attendees/updates in `calendar_propose_event`; fixture world shape; whether Deskbench/Deskflow read `ledger.db` directly or via `ledger_query`.

Still open or unverified:

1. **Action id format** is not decided: it must make "last 4 chars" a usable confirmation (ADR 0002 adds a collision check among pending plans). The plan should pick the format (e.g. ULID or random base32).
2. **Calendar idempotency:** I rely on Google Calendar accepting a client-supplied event id for apply idempotency. To be verified against the API when the adapter is built (M3).
3. **npx bin rule for scoped packages** is inferred from npm-exec docs wording; the M6 smoke test is the real proof.
4. **Export columns / date semantics** are left to the plan (owner's instruction).
5. **macOS data dir** (`~/Library/Application Support/deskhand`) is my choice, not specified.
6. **Windows file protection** relies on the user-profile ACL; POSIX modes (0700/0600) are not applied there.
7. The Claude Code deny-rule syntax in the README snippet must be checked against current Claude Code settings docs when the README is written.

## Builder-check findings (2026-11-07), to resolve before or in M2

Contract gaps (write `docs/ledger-contract.md`, `docs/fixture-format.md`, `docs/tools-contract.md` first): fixture world format (JSON only, `DESKHAND_FIXTURE`, deterministic clock/id seed); full ledger DDL, id formats, `preview_json` shape; diff must be rendered from `plan_json` by one deterministic function, never agent text; direct read-only `ledger.db` vs `ledger_query` for Deskbench/Deskflow; status transition table + CLI error codes + apply gate order vs idempotent replay; `user_version` as the single version source (drop `schema_version` or define it as a log); per-column redaction and fixed truncation for `input/plan/result_json`; `amount_minor` currency exponent.

Safety: log around SDK input validation and unknown tools, fail closed if the ledger cannot open; CLI must strip control/ANSI characters from untrusted text in `pending`/`approve`; deny rule should also cover `npx`/`pnpm exec`/`node dist/cli.js` variants; Calendar invites to attendees are an implicit send path (decide: no attendees in v1 or `sendUpdates=none`); regenerate action id at plan time on last-4 collision instead of refusing at approve; add TEST_PLAN rows for `deskhand auth`.
