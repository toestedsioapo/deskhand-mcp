# ROADMAP — Deskhand MCP

Timebox ~5–6 weeks after Tempo v0.1.0 (published 2026-11-06). Order follows approach A: ledger first.

| Wk | Milestone | Definition of done |
|---|---|---|
| 0 | Planning docs | SPEC, ARCHITECTURE, ADRs 0001–0007, SECURITY, TEST_PLAN, ASSUMPTIONS approved; ADR 0004 accepted (`node:sqlite`, `>=24.15`). **Done** on `docs/planning`; M1 plan written, awaiting owner "go" |
| 1 | Skeleton | ESM + strict TS; server boots over stdio with `ping`; Inspector works; CI green on Node 24.15 (floor) and 26, Win + Linux; `deskhand --help`. **Gap, by design:** `ping` writes no ledger row in M1 (there is no ledger yet); M2 must make it write one like every other tool. **M1 additions beyond the minimum:** `LICENSE` (MIT), `deskhand --version`, a Node-version guard with a clear "requires Node >=24.15" message, `docs/DEVELOPMENT.md` |
| 2 | Ledger + approvals | **Contract docs first:** `docs/ledger-contract.md`, `docs/fixture-format.md`, `docs/tools-contract.md`. Then `db.ts`, schema/migrations (`PRAGMA user_version`, `src/ledger/migrations/`), `actions`/`events`/`expenses` tables, canonical hash, plan store (action-id last-4 collision regeneration), apply engine gates, fixture provider + format v1, CLI `pending/approve/reject` (approve refuses expired/duplicate/mismatched, every refusal is an event), `ledger_query`, `action_explain`, **`ping` writes its ledger row**, concurrency tests |
| 3 | Calendar | `src/tempo/` adapter + contract test; list, find_slots, propose_event (`sendUpdates` default `none`, notification wording in diff) + apply with re-check; Google calendar adapter (recorded tests); **`deskhand auth login/status/upgrade`** |
| 4 | Inbox | search, read_thread, triage (proposes only, never applies labels), draft_reply (draft only, re-check); Gmail adapter (recorded tests); no-send-endpoint test; untrusted wrapper everywhere |
| 5 | Itinerary, expense, docs | `itinerary_build` (structured flight fields), `expense_log` (row written only on apply), `deskhand export expenses` (CSV, `--from/--to`), generated `docs/tools.md` |
| 6 | Release | README (Claude Desktop config using `npx @marvinliem/deskhand-mcp`; canonical `npx -p @marvinliem/deskhand-mcp deskhand approve <id>`; Claude Code deny rules for `deskhand`, `npx`, `pnpm exec`, `node dist/cli.js` variants), MIT LICENSE, SECURITY final, **npx smoke test passes on Windows and Linux**, release from GitHub Actions with npm provenance |
