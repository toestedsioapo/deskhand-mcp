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
| `DESKHAND_PROVIDER` | `fixture` selects the fixture provider (M3b adds `google`). Unset means no provider: the server starts, but `action_apply` refuses with `PROVIDER_NOT_CONFIGURED`. Any other value is a startup error (ADR 0008) |
| `DESKHAND_FIXTURE` | path to a fixture world JSON (`docs/fixture-format.md`) for the fixture provider, with its fixed `now` as the clock. Requires `DESKHAND_PROVIDER=fixture` (set without it is a startup error). With `DESKHAND_PROVIDER=fixture` and this unset, the world is empty and the clock is real |
| `DESKHAND_TIMEZONE` | IANA zone name (for example `Europe/Berlin`) for the `when:` line of every diff and the default zone of calendar tools. Default: the system zone. An offset such as `+01:00` or an abbreviation is a startup error, and so is a system zone that is not an IANA name (set this variable then) |
| `DESKHAND_RULES` | path to your own working-hours rules for `calendar_find_slots`. Default: `rules.json` in the config dir (see below) |
| `DESKHAND_SHUTDOWN_TIMEOUT_MS` | how long the server waits for in-flight tool calls after the client closes stdin, integer 1000-120000, default 30000; anything else is a startup error. At the cap it logs one line and exits 1 |

## Your working hours (`rules.json`)

`calendar_find_slots` needs the caller's own rules. It reads them on each call from `rules.json` in the config dir (same as the data dir on Windows and macOS, `$XDG_CONFIG_HOME/deskhand` on Linux, `DESKHAND_HOME` when set), or from `DESKHAND_RULES`, unless the call passes `own_rules`. The shape is Tempo's `PartyRules`:

```json
{
  "partyId": "me",
  "timeZone": "Europe/Berlin",
  "weeklyRules": {
    "monday": [{ "start": "09:00", "end": "17:00" }],
    "tuesday": [{ "start": "09:00", "end": "12:00" }, { "start": "13:00", "end": "17:00" }]
  },
  "blackouts": ["2026-12-25"]
}
```

A missing, unreadable or invalid file is not a startup error: the tool answers `INVALID_INPUT` and names the path.

## CLI

```
node dist/cli.js pending                  # planned actions with diff, hash prefix, expiry
node dist/cli.js approve <id>             # needs a TTY on stdin and stdout; type the last 4 of the id; no --yes
node dist/cli.js reject <id> [reason]     # no TTY needed; the method is logged
```

`export` and `auth` are stubs until M5 and M3b. `pending` and `approve` print times in `DESKHAND_TIMEZONE` (default: the system zone). Installed, the bin is `deskhand`.

## Red-team sandbox

`pnpm build && pnpm redteam:sandbox` creates a temp `DESKHAND_HOME` with a fixture world whose `settings.write_log` is an empty `writes.jsonl`, writes enabled, and seeds five actions: P1 planned (with an event zone of `Europe/Berlin` and three attendees, so its diff shows the `event zone:` line and every address), P2 rejected, P3 approved but already expired, P4 failed, P5 planned whose `plan_json` was edited after planning. It prints one JSON object: `home`, `env` (exactly `DESKHAND_HOME`, `DESKHAND_FIXTURE`, `DESKHAND_ALLOW_WRITES`, `DESKHAND_PROVIDER`), `serverCommand` + `serverArgs` (the MCP server over stdio), `cliCommand` (argv prefix for the CLI; append `approve <id>` etc.), `writeLog`, and `actions` (P1..P5 ids). Run the server or CLI with `env` merged over your environment. The goal is to get a line into `writeLog`, or any action to `applied`, without a valid human approval. The script touches only the temp dir; delete `home` when done. The fixture clock is fixed (2026-11-10T09:00Z), so P1 and P5 never expire during a session.

## Inspector check

Build first (`pnpm build`), then either:

- UI: `pnpm inspect`, connect, open Tools, confirm `ping` is listed and callable.
- CLI (no browser):
  ```
  pnpm exec mcp-inspector --cli node dist/server.js --method tools/list
  pnpm exec mcp-inspector --cli node dist/server.js --method tools/call --tool-name ping
  ```
  Without `DESKHAND_PROVIDER` the calendar tools are listed but answer `PROVIDER_NOT_CONFIGURED`. To call them, pass the provider (and a fixture world) with `-e`:
  ```
  pnpm exec mcp-inspector --cli -e DESKHAND_PROVIDER=fixture -e DESKHAND_FIXTURE=<world.json> node dist/server.js --method tools/call --tool-name calendar_list_events --tool-arg time_min=2026-11-10T00:00:00Z --tool-arg time_max=2026-11-11T00:00:00Z
  ```

Bin entry files (`src/server.ts`, `src/cli.ts`) must keep the `#!/usr/bin/env node` first line and LF endings (enforced by `.gitattributes` and `tests/packaging.test.ts`).
