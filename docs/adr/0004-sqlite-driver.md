# 0004 — SQLite driver: `node:sqlite` vs `better-sqlite3`

Status: **Accepted (owner, 2026-11-07): `node:sqlite`, `engines.node ">=24.15"`, behind a wrapper module.** `better-sqlite3` stays the documented fallback.

**Evidence (Node docs checked 2026-11-07; local tests).**

| | `node:sqlite` | `better-sqlite3` |
|---|---|---|
| Native build on Windows | none (built in) | prebuilt binaries usually, source build (MSVC + Python) if none matches; CLAUDE.md says avoid native modules unless an ADR justifies |
| Stability | Node 24: **1.2 Release candidate from v24.15.0**, experimental before. Node 26: 1.2 RC (RC since v25.7.0) | mature |
| Flag needed | no (since v23.4.0 / v22.13.0) | n/a |
| Busy timeout | `new DatabaseSync(path, { timeout })`, v24.0.0+ | `timeout` option |
| WAL | `PRAGMA journal_mode = WAL` works (tested: returns `wal`) | yes |
| API | synchronous (fine: local, tiny). `defensive` default on from v24.14.0 | synchronous |
| Naming | `DatabaseSync` on Node 24; Node 26 docs name it `Database`, `DatabaseSync` a deprecated alias (DEP0210) | stable |

**ExperimentalWarning test.** Same script (open DB with `timeout`, set WAL, read pragmas, close) run on: Node 24.11.1 → prints `ExperimentalWarning: SQLite is an experimental feature` on stderr; **Node 24.15.0, 24.22.2 and 26.13.0 → no warning**, using the `DatabaseSync` name on all of them (no deprecation warning on 26 either). Conclusion: on our floor (≥24.15) the warning does not print, so **no warning filter is added**. If a later Node reintroduces it, filter only that one warning (match `name === 'ExperimentalWarning'` and the SQLite message) in the server and CLI entry points, never all warnings, and note it here. CI keeps a test that spawns both bins and asserts clean stderr on startup (TEST_PLAN).

**Decision.** `node:sqlite`, `engines.node: ">=24.15"`, all access through `src/ledger/db.ts` (hides the class-name difference, applies pragmas: WAL, busy timeout, foreign keys; nothing else imports `node:sqlite`). CI runs Node 24.15 (floor) and 26.

**Consequences.** Local dev needs Node ≥24.15 (the maintainer's 24.11.1 must be upgraded). The API is still a release candidate; if it changes incompatibly or proves unreliable, swap in `better-sqlite3` behind `db.ts` (that seam is the point of the wrapper) and record a new ADR.
