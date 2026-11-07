# ROADMAP — Deskhand MCP (draft)

Timebox ~5–6 weeks after Tempo v0.1.0 (now published). Order follows approach A: ledger first.

| Wk | Milestone | Definition of done |
|---|---|---|
| 0 | Planning docs | SPEC, ARCHITECTURE, ADRs 0001–0007, SECURITY, TEST_PLAN, ASSUMPTIONS approved; ADR 0004 accepted (`node:sqlite`, `>=24.15`) |
| 1 | Skeleton | ESM + strict TS; server boots over stdio with `ping`; Inspector works; CI green on Node 24.15 (floor) and 26, Win + Linux; `deskhand --help` |
| 2 | Ledger + approvals | `db.ts`, schema/migrations, `events`/`actions`, canonical hash, plan store, apply engine gates, fixture provider + format v1, CLI `pending/approve/reject`, `ledger_query`, `action_explain`, concurrency tests |
| 3 | Calendar | `src/tempo/` adapter + contract test; list, find_slots, propose_event + apply with re-check; Google calendar adapter (recorded tests) |
| 4 | Inbox | search, read_thread, triage, draft_reply (draft only, re-check); Gmail adapter (recorded tests); untrusted wrapper everywhere |
| 5 | Itinerary, expense, docs | `itinerary_build` (structured flight fields), `expense_log`, `deskhand export expenses` (CSV, `--from/--to`), generated `docs/tools.md` |
| 6 | Release | README (Claude Desktop config using `npx @marvinliem/deskhand-mcp`; Claude Code deny-rule snippet for `deskhand approve*`), MIT LICENSE, SECURITY final, **npx smoke test passes on Windows and Linux**, release from GitHub Actions with npm provenance |
