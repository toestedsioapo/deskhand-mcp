# 0003 — Ledger format

Status: Proposed · 2026-11-07

**Decision.** Two tables, defined in ARCHITECTURE.md: `actions` (current state of each planned write; `status ∈ planned|approved|applied|rejected|failed`) and append-only `events` (every tool call and every lifecycle transition). Schema version tracked with `PRAGMA user_version` and a `schema_version` table; forward-only migrations in `src/ledger/`.

**Why two tables.** PLAN.md's `actions` table records writes only; CLAUDE.md requires a ledger row for *every* tool call including reads, failures and rejections. This extends PLAN.md and is my proposal.

**Contract.** Owner-approved. Both tables, their columns and all value sets (`status`, `outcome`, `approval_method`, `rejection_method`) are the contract Deskbench scores against and Deskflow renders, and are documented as such. Schema version is explicit: `PRAGMA user_version` plus forward-only migrations. Column or status changes are breaking and bump the major version. `expired` is derived from `expires_at`, deliberately not a status, to keep the status set small.

**Redaction.** Previews never contain tokens; email bodies are truncated and not stored in full; previews are built by one function that is leak-tested.
