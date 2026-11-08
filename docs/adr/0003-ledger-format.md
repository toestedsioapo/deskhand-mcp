# 0003 — Ledger format

Status: Accepted (owner review, 2026-11-09)

**Decision.** Three tables in one `ledger.db`, defined in ARCHITECTURE.md:
- `actions`: current state of each planned write; `status ∈ planned|approved|applied|rejected|failed`.
- `events`: append-only; every tool call and every lifecycle transition.
- `expenses`: rows written only by `action_apply` for an applied `expense_log` plan (see ARCHITECTURE.md, Expenses).

The schema version is `PRAGMA user_version`, and nothing else (no `schema_version` table). Migrations are forward-only files in `src/ledger/migrations/`.

**Why `events` besides `actions`.** PLAN.md's `actions` table records writes only; CLAUDE.md requires a ledger row for *every* tool call including reads, failures and rejections. `events` covers that; `actions` is the current-state row.

**Why `expenses`.** `expense_log` stays a plan tool: the expense row is written only on apply, so "no side effects outside `action_apply`" has no exceptions. The row needs somewhere to live that `deskhand export expenses` can read, and a CSV over `actions.plan_json` would couple the export to plan internals.

**Contract.** Owner-approved. All three tables, their columns and all value sets (`status`, `outcome`, `approval_method`, `rejection_method`, `events.kind`, `error_code`) are the contract Deskbench scores against and Deskflow renders, and are documented as such in `docs/ledger-contract.md` (M2, before migration 1). Column or status changes are breaking and bump the major version. `expired` is derived from `expires_at`, deliberately not a status, to keep the status set small. Whether Deskbench/Deskflow read `ledger.db` directly or only via `ledger_query` is decided during Deskbench planning (ASSUMPTIONS); the documented schema plus `ledger_query` output is the contract either way.

**Redaction.** Previews never contain tokens; email bodies are truncated and not stored in full; previews are built by one function that is leak-tested.
