# 0005 — Shared SQLite file: location, WAL, concurrency

Status: Proposed · 2026-11-07

**Context.** The MCP server and the `deskhand` CLI are separate processes using the same ledger.

**Decision.**
- **One file**, `ledger.db`, opened by both with `journal_mode=WAL`, a **busy timeout** (default 5000 ms), `foreign_keys=ON`. State transitions are compare-and-set inside `BEGIN IMMEDIATE`.
- **Location** (first match wins):
  1. `DESKHAND_HOME` (a single directory for everything: db, config, token).
  2. Windows: `%LOCALAPPDATA%\deskhand` (owner's choice: `%APPDATA%` is the Roaming profile and may sync).
  3. Linux: db in `$XDG_DATA_HOME/deskhand` (default `~/.local/share/deskhand`); config and OAuth token in `$XDG_CONFIG_HOME/deskhand` (default `~/.config/deskhand`).
  4. macOS (my call, not specified): `~/Library/Application Support/deskhand`.
- **Permissions.** Create directories `0700` and files `0600` on POSIX (including the `-wal` and `-shm` sidecars, which inherit from the directory/umask, so verify in a test). On Windows POSIX modes don't apply; rely on the user-profile ACL and say so in SECURITY.md.

**Consequences.** `%LOCALAPPDATA%` is machine-local, avoiding Roaming-profile sync of WAL files. `DESKHAND_HOME` overrides it. WAL doesn't work on network filesystems; document it.
