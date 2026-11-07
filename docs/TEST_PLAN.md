# TEST PLAN — Deskhand MCP (draft)

Test first (TDD). Vitest. No live Google calls; fixture provider or recorded responses only.

| Area | Must prove |
|---|---|
| Tools | each tool against the fixture provider; Zod input rejects bad input |
| Contracts | tool input/output schemas snapshot-tested; ledger schema + status values snapshot; fixture format version |
| Ledger | every tool call writes exactly the expected `events` rows (reads, errors, rejections included); `events` can't be UPDATEd/DELETEd; redaction/leak test (no tokens, no full bodies in rows or logs) |
| Apply gates | each refusal case: writes off; unknown id; expired; not approved; rejected; already applied (idempotent, returns stored result) |
| Hash binding | tampered `plan_json` after plan → refused; tampered after approval → `PLAN_MODIFIED`; canonical-JSON fixed vectors |
| Re-check | slot taken between approve and apply → `STALE_PLAN`, no provider write, event logged; referenced event etag changed → same |
| Idempotency | crash between provider write and ledger update → retry doesn't double-create (fixture provider simulates) |
| CLI | `approve` refuses with non-TTY stdin or stdout and with piped input; refuses on wrong last-4 confirmation; refuses if two pending ids share last 4; records `approved_by` + `approval_method`; `pending` shows diffs; `reject` works without TTY and records reason + `rejection_method` |
| Config | `DESKHAND_PLAN_TTL_HOURS` accepts 1–168, default 24, out-of-range is a startup error |
| Export | `deskhand export expenses` emits CSV, `--from`/`--to` filter inclusive/exclusive per plan; only applied expenses |
| Itinerary | structured flight fields validated by Zod; pasted free text is not parsed |
| Startup | both bins start with clean stderr on Node 24.15 and 26 (guards the ADR 0004 ExperimentalWarning result) |
| Ledger version | `PRAGMA user_version` matches latest migration; migrating an old fixture DB forward works |
| Concurrency | server + CLI processes on one DB: WAL on, busy timeout honoured, CAS transition loses cleanly under a race |
| Paths | `DESKHAND_HOME`, Windows `%LOCALAPPDATA%` (not `%APPDATA%`), Linux XDG resolution (env-injected unit tests); POSIX file modes incl. `-wal`/`-shm` |
| Tempo | contract test over `src/tempo/` using tempo-core's `fixtures/*` |
| Packaging | pack the tarball, run `npx` against it on Windows and Linux: `npx @marvinliem/deskhand-mcp` starts the server bin and `deskhand --help` works (M6) |
| Matrix | CI on Node 24.15 (floor) and 26, Windows + Linux |
| Manual | MCP Inspector each milestone (`pnpm inspect`) |
