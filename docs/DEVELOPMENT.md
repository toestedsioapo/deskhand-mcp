# Development

Requires Node >=24.15 (uses `node:sqlite`) and pnpm.

## Commands

```
pnpm install
pnpm typecheck # tsc --noEmit over src + tests + vitest.config.ts
pnpm build     # tsc -> dist/
pnpm test      # vitest (builds dist first via global setup)
pnpm dev       # run the built server over stdio
pnpm inspect   # MCP Inspector UI against the built server
pnpm redteam:sandbox # seed a throwaway ledger + fixture for the red-team review (after pnpm build)
```

## Ledger location and environment

The SQLite ledger is `ledger.db` in the data dir: `%LOCALAPPDATA%\deskhand` on Windows, `~/Library/Application Support/deskhand` on macOS, `$XDG_DATA_HOME/deskhand` (default `~/.local/share/deskhand`) on Linux. `DESKHAND_HOME` overrides it (ADR 0005); tests and the sandbox always use a temp one. The server and the CLI share the file (WAL, busy timeout 5 s).

| Variable | Meaning |
|---|---|
| `DESKHAND_HOME` | data and config dir, overrides the platform default |
| `DESKHAND_ALLOW_WRITES` | must be exactly `1` for `action_apply` to do anything; anything else (including `true`) leaves writes off |
| `DESKHAND_PLAN_TTL_HOURS` | plan lifetime, integer 1-168, default 24; out of range is a startup error |
| `DESKHAND_FIXTURE` | path to a fixture world JSON (`docs/fixture-format.md`) to load into the fixture provider, with its fixed `now` as the clock. It does not select the provider: in M2 the fixture provider is always wired, and when this is unset it starts with an empty in-memory world and the real clock (M3 adds explicit provider selection, see `docs/ASSUMPTIONS.md`) |

## CLI

```
node dist/cli.js pending                  # planned actions with diff, hash prefix, expiry
node dist/cli.js approve <id>             # needs a TTY on stdin and stdout; type the last 4 of the id; no --yes
node dist/cli.js reject <id> [reason]     # no TTY needed; the method is logged
```

`export` and `auth` are stubs until M5 and M3. Installed, the bin is `deskhand`.

## Red-team sandbox

`pnpm build && pnpm redteam:sandbox` creates a temp `DESKHAND_HOME` with a fixture world whose `settings.write_log` is an empty `writes.jsonl`, writes enabled, and seeds five actions: P1 planned, P2 rejected, P3 approved but already expired, P4 failed, P5 planned whose `plan_json` was edited after planning. It prints one JSON object: `home`, `env` (exactly `DESKHAND_HOME`, `DESKHAND_FIXTURE`, `DESKHAND_ALLOW_WRITES`), `serverCommand` + `serverArgs` (the MCP server over stdio), `cliCommand` (argv prefix for the CLI; append `approve <id>` etc.), `writeLog`, and `actions` (P1..P5 ids). Run the server or CLI with `env` merged over your environment. The goal is to get a line into `writeLog`, or any action to `applied`, without a valid human approval. The script touches only the temp dir; delete `home` when done. The fixture clock is fixed (2026-11-10T09:00Z), so P1 and P5 never expire during a session.

## Inspector check

Build first (`pnpm build`), then either:

- UI: `pnpm inspect`, connect, open Tools, confirm `ping` is listed and callable.
- CLI (no browser):
  ```
  pnpm exec mcp-inspector --cli node dist/server.js --method tools/list
  pnpm exec mcp-inspector --cli node dist/server.js --method tools/call --tool-name ping
  ```

Bin entry files (`src/server.ts`, `src/cli.ts`) must keep the `#!/usr/bin/env node` first line and LF endings (enforced by `.gitattributes` and `tests/packaging.test.ts`).
