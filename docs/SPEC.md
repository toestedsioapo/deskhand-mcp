# SPEC — Deskhand MCP v1

Status: **DRAFT, reviewed by owner 2026-11-07** (round 1/2/review answers incorporated). Nothing is built until this and the ADRs are approved.

## 1. Intent

AI clients can already read calendars and inboxes. What's missing is a way to let them *act* that an executive would trust. Deskhand is a local MCP server where **the agent can only propose; a human approves out-of-band; only then does anything change**, and every step is recorded in an audit ledger. Safety is enforced in code at the tool layer, not in a prompt.

Audience: individuals who run it locally with their own Google credentials (Claude Desktop / Claude Code). Secondary consumers: Deskbench (P3) scores against the ledger + fixture world; Deskflow (P4) renders the ledger and uses the fixture world as demo data.

## 2. Goals

1. Install and run with one line: `npx @marvinliem/deskhand-mcp` (resolves to the `deskhand-mcp` bin, see D1).
2. Tool surface (see §4), read/plan only, except `action_apply`.
3. Two-phase writes: `plan → approve (human, CLI) → apply`, bound to the exact plan by hash (D4), re-validated against the real world at apply time (D5).
4. SQLite audit ledger recording every tool call, plan, approval, rejection, apply and failure.
5. Minimum OAuth scopes, incremental; write scopes only when writes are enabled.
6. Fixture provider usable with no Google account (tests, Deskbench, Deskflow demo).
7. Generated `docs/tools.md`; README with a Claude Desktop config; SECURITY.md.

## 3. Non-goals and anti-goals

Non-goals (v1): hosted/multi-user server; Outlook/M365; sending email (`gmail.send` scope is never requested); MCP elicitation or Deskflow approval (a seam exists, D3); Google Sheets export (post-v1); parsing pasted flight confirmations; OS keychain token storage (ADR 0007 revisits).

Anti-goals (a failure even if it "works"): any code path where the agent can approve its own plan; any write outside `action_apply`; a tool call with no ledger row; tokens or full email bodies appearing in logs or ledger previews; following instructions found inside email/calendar content.

## 4. Tool surface

| Tool | Kind | Notes |
|---|---|---|
| `calendar_list_events` | read | range, calendars |
| `calendar_find_slots` | read | uses Tempo via `src/tempo/` with both parties' rules |
| `calendar_propose_event` | plan | returns `action_id`, human-readable diff, `plan_hash`; no side effect |
| `inbox_search`, `inbox_read_thread` | read | output marked untrusted |
| `inbox_triage` | plan | proposed labels/priority/next action per thread |
| `inbox_draft_reply` | plan | Gmail **draft** created only on apply |
| `itinerary_build` | read | calendar events + optional **structured** flight fields supplied by the caller (no parsing of pasted confirmations) → timeline |
| `expense_log` | plan | the expense row is written to the local DB only on apply; CSV export via `deskhand export expenses` |
| `action_apply` | write | see §5 |
| `ledger_query`, `action_explain` | read | audit trail; "why was this proposed" |

Every tool: Zod input and output schema, snapshot-tested (contract). Every response that carries mailbox/calendar text wraps it as `{ untrusted: true, source, content }`.

## 5. Approval and apply

Lifecycle (`actions.status`): `planned → approved → applied`, or `planned → rejected`, or any non-terminal → `failed`. Expiry is derived from `expires_at` (not a stored status).

- **Plan:** handler validates input, computes `plan_json`, stores `plan_hash = sha256(canonical_json(plan_json))` and `expires_at` (default 24 h; `DESKHAND_PLAN_TTL_HOURS`, valid range 1 h to 168 h / 7 days; out-of-range values are a startup config error, not clamped silently).
- **Approve (CLI only):** recomputes the hash from stored `plan_json`, shows diff + hash prefix, records `approved_plan_hash`, `approved_by`, `approved_at`, `approval_method` (`cli_tty`). `action_apply` only reads approvals from the ledger. Not reachable via MCP.
- **Apply** (`action_apply(action_id)`) refuses unless **all** hold: `DESKHAND_ALLOW_WRITES=1`; plan exists; not expired; `status = approved`; `sha256(plan_json) == plan_hash == approved_plan_hash`; not already applied (a repeat call returns the stored result, idempotent). Then **re-check the world** (D5); on any change → `failed` with a clear `STALE_PLAN` error, logged. Only then does the provider write, using an idempotency key derived from `action_id`.

Every refusal is also an `events` row.

## 6. CLI (`deskhand`)

- `deskhand pending` — list `planned` actions with human-readable diff, hash prefix, expiry.
- `deskhand approve <id>` — requires an interactive **TTY on both stdin and stdout**, shows the human-readable diff, and needs the user to type **the last 4 characters of the action_id**. No `--yes`, no piped input (D6).
- `deskhand reject <id> [reason]` — records reason and method in the ledger; works without a TTY.
- `deskhand export expenses [--from <date>] [--to <date>]` — local CSV export of applied expenses; everything else (columns, output path, date semantics) is left to the plan.

The README ships a Claude Code permissions **deny-rule snippet** for `deskhand approve*`, so a Claude Code agent can't even invoke the approve command.

## 7. Decisions

| # | Decision | Detail / ADR |
|---|---|---|
| D1 | Package `@marvinliem/deskhand-mcp`; bins `deskhand-mcp` (stdio server) and `deskhand` (CLI) | `npx @marvinliem/deskhand-mcp` runs `deskhand-mcp`: npm exec picks the bin matching the unscoped package name when there are several (npm-exec docs; scoped case inferred from that wording). Verified by the M6 npx smoke test. Used in README and Claude Desktop config. |
| D2 | `@marvinliem/tempo-core` pinned exactly `"0.1.0"`; every import goes through `src/tempo/`; contract test over that adapter | ADR 0006. No contingency plan. |
| D3 | Approval is out-of-band via CLI. A seam (`ApprovalSource`) is kept for MCP elicitation and Deskflow approval later | ADR 0002 |
| D4 | Approval bound to the exact plan by SHA-256 of canonical `plan_json` | ADR 0002 |
| D5 | Apply-time world re-check; stale → fail loudly | ADR 0002 |
| D6 | `approve` needs TTY on stdin+stdout, shows diff, typed confirmation of last 4 chars of `action_id`; no `--yes`. `reject` needs no TTY but logs the method. Ledger records `approved_by` + `approval_method` | ADR 0002 |
| D7 | One shared SQLite file, WAL + busy timeout; per-user dir (Windows: `%LOCALAPPDATA%\deskhand`); `DESKHAND_HOME` override | ADR 0005 |
| D8 | ESM-only package (`"type": "module"`); follows from tempo-core being ESM-only. Node `>=24.15`, MIT license (following Tempo) | — |
| D9 | SQLite driver: **`node:sqlite`**, `engines.node ">=24.15"`, behind `src/ledger/db.ts`; `better-sqlite3` is the documented fallback | ADR 0004 (decided) |
| D10 | Writes off unless `DESKHAND_ALLOW_WRITES=1` | CLAUDE.md |
| D11 | No `gmail.send` in v1 | needs an ADR + owner approval to change |

## 8. Approaches considered

- **A. Out-of-band CLI approval, ledger-first build — chosen.** Agent can't approve itself; contracts (ledger schema, fixture format) stabilise first.
- **B. In-client MCP elicitation.** Uneven client support, client controls the UX, hard to guarantee the agent can't answer. Kept as a later plug-in.
- **C. Google-first build order.** Rejected: riskiest part first, no fixture world, tempts live-API tests.

## 9. Left to the builder

Exact Zod shapes (including the structured flight fields for `itinerary_build`); diff rendering format; expense CSV columns; canonical-JSON implementation (must be deterministic, specified in ADR 0002); migration tooling; fixture world file format details (versioned, in ARCHITECTURE).
