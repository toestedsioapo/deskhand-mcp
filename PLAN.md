# PLAN — Deskhand MCP (Project 2 of 4)

> An MCP server that gives any AI client executive-assistant tools for calendar, inbox triage, itineraries and expense logging. **Read-only by default**, with approval gates and an audit ledger for every action.

**Timebox:** ~5–6 weeks · **Process:** Superpowers · **Depends on:** Tempo (P1) · **Status:** Planning, starts after Tempo v0.1.0

---

## 1. Why this exists

Generic Calendar/Gmail MCP servers let an agent act directly. Deskhand's difference: **every action is dry-run first, logged and explainable.** An EA never sends anything the boss didn't approve, and Deskhand enforces that at the tool layer, not in a prompt.

## 2. Goals

1. MCP server (official TypeScript SDK, stdio transport) installable with **one line**: `npx <pkg>`.
2. EA tool surface (draft):

| Tool | Kind | Notes |
|---|---|---|
| `calendar_list_events` | read | range, calendars |
| `calendar_find_slots` | read | **calls Tempo** with both parties' rules |
| `calendar_propose_event` | plan | returns `action_id` + human-readable diff, no side effect |
| `inbox_search` / `inbox_read_thread` | read | |
| `inbox_triage` | plan | proposes labels/priority/next action per thread |
| `inbox_draft_reply` | plan | proposes a draft, and creates a Gmail **draft** only after approval |
| `itinerary_build` | read | assembles a trip timeline from calendar events (+ optional structured flight fields from the caller; no parsing of pasted confirmations) |
| `expense_log` | plan | records an expense row in the local ledger; CSV via `deskhand export expenses` |
| `action_apply` | write | executes a previously planned `action_id` **only if approved** |
| `ledger_query` / `action_explain` | read | audit trail, "why did you propose this?" |

3. **Two-phase writes:** `plan → (human approval) → apply`. Writes are disabled entirely unless `DESKHAND_ALLOW_WRITES=1`.
4. **Audit ledger (SQLite):** append-only record of every plan, approval, apply and failure.
5. **Minimal OAuth scopes**, requested incrementally (read-only first).
6. **Generated tool docs** from the Zod schemas (`docs/tools.md`).
7. Ready-made **Claude Desktop / Claude Code config** snippet and a **Security** section in the README.

## 3. Non-goals (v1)

- No hosted/multi-user server (that's Deskflow). Users run it **locally with their own Google credentials**.
- No sending email directly. Drafts only in v1 (`gmail.send` deferred).
- No Outlook/Microsoft 365 in v1, but keep a provider interface so it can be added.

## 4. Architecture (target)

```
deskhand-mcp/
├─ src/
│  ├─ server.ts            # MCP wiring, tool registration
│  ├─ tools/               # one file per tool: zod input/output schema + handler
│  ├─ approval/            # plan store, approval, apply engine
│  ├─ ledger/              # SQLite schema + migrations + queries
│  ├─ providers/
│  │  ├─ google/           # Calendar + Gmail adapters (real)
│  │  └─ fixture/          # in-memory fake world, used by tests AND Deskbench
│  └─ config/              # env, scopes, paths
├─ scripts/gen-tool-docs.ts
└─ docs/ (ARCHITECTURE.md, adr/, SECURITY.md, tools.md [generated])
```

### Key design decisions (ADRs)

1. **Provider interface + fixture provider.** All Google calls go through `CalendarProvider` / `MailProvider` interfaces. A `fixture` provider loads a fake inbox/calendar from JSON/YAML. This is **required by Deskbench (P3)** and **Deskflow's demo mode (P4)**. ⚠️ Cross-project contract.
2. **Approval mechanism.** Options: (a) MCP elicitation/confirmation in the client, (b) explicit `action_apply` call with `action_id` that the human triggers, (c) approval via the Deskflow inbox (P4). **Superseded:** v1 is out-of-band approval via the `deskhand` CLI (TTY + typed last-4 of the action id); `action_apply` only reads approvals from the ledger. Seam kept for (a) and (c). See `docs/adr/0002`.
3. **Ledger format.** Table `actions(id, created_at, tool, input_json, plan_json, status[planned|approved|applied|rejected|failed], approved_by, applied_at, result_json, error)`. This **is the contract** Deskbench scores against and Deskflow displays. **Superseded:** two tables (`actions` + append-only `events`), versioned via `PRAGMA user_version` + migrations. See `docs/adr/0003`.
4. **Token storage.** OAuth refresh token stored in the user config dir with restrictive permissions (flag: consider OS keychain). Never logged.
5. **SQLite driver:** `better-sqlite3` vs Node's built-in `node:sqlite`. **Decided:** `node:sqlite`, Node `>=24.15`, behind `src/ledger/db.ts` (`docs/adr/0004`).

### OAuth scopes (incremental)

| Feature | Scope |
|---|---|
| Read calendar | `calendar.readonly` |
| Create events (writes on) | `calendar.events` |
| Read mail | `gmail.readonly` (restricted) |
| Create drafts (writes on) | `gmail.compose` (restricted) |

## 5. Test strategy

- Vitest unit tests per tool against the **fixture provider**.
- Approval engine tests: an apply without approval is rejected, a double apply is idempotent, and an expired plan is rejected.
- Ledger tests: every tool call writes exactly the expected rows, and there are no PII leaks in logs.
- Contract tests: tool input/output schemas snapshot-tested (breaking change = major bump).
- Manual smoke test with **MCP Inspector** each milestone.
- Google adapters: recorded-response tests. No live API in CI.

## 6. Milestones

| Week | Milestone | Definition of done |
|---|---|---|
| 0 | Planning docs | SPEC, ARCHITECTURE + ADRs, SECURITY draft, TEST_PLAN, ROADMAP approved |
| 1 | Skeleton | MCP server boots over stdio, one `ping` tool, Inspector works, CI green |
| 2 | Ledger + approvals | SQLite ledger, plan/apply engine, fixture provider, `ledger_query`, `action_explain` |
| 3 | Calendar | list/find_slots (Tempo)/propose_event + apply; Google adapter behind interface |
| 4 | Inbox | search/read/triage/draft_reply (draft only) |
| 5 | Itinerary + expense + docs | `itinerary_build`, `expense_log`, generated `docs/tools.md` |
| 6 | Release | README with Claude Desktop config, SECURITY.md, npx install verified on Windows + Linux, npm provenance release |

## 7. Ecosystem contract

- Exposes the **fixture provider** so Deskbench can run it as the system under test with no Google account.
- **Ledger schema + tool schemas** are versioned and consumed by Deskbench (scoring) and Deskflow (UI).
- Imports `@marvinliem/tempo-core` pinned exactly to `0.1.0`, only via `src/tempo/` (supersedes "pinned to a major"; see `docs/adr/0006`).

## 8. Risks & assumptions (flagged)

- ⚠️ **Gmail scopes are restricted.** A *public* app needs Google verification and a security assessment. Mitigation: users bring their own OAuth client (local, "Testing" mode). Document setup step by step.
- ⚠️ **Testing-mode refresh tokens expire after ~7 days.** Users will need to re-auth weekly unless the app is published. Document this clearly.
- ⚠️ Prompt injection via email content. Tool output must clearly mark email bodies as untrusted data, and no write can happen without approval regardless.
- Package is scoped (`@marvinliem/deskhand-mcp`), bins `deskhand-mcp` + `deskhand`; supersedes the unscoped-name risk. Detail in `docs/SPEC.md` (D1). Design docs now live in `docs/` (SPEC, ARCHITECTURE, ADRs, ASSUMPTIONS); where they differ from this file, `docs/` wins.

## 9. Open questions for the kickoff session

**All closed 2026-11-07** (approval: CLI out-of-band; drafts only, no `gmail.send`; expenses: ledger + CSV export; itinerary: calendar + structured flight fields; plan expiry 24 h, 1 h–7 d). Details in `docs/SPEC.md` and `docs/ASSUMPTIONS.md`.

## 10. Kickoff

Adapt the Tempo kickoff prompt (Master Plan p.2): swap the context/goals for sections 2–4 above, keep the same rules (planning only, ≤5 questions, flag assumptions, stop for approval).
