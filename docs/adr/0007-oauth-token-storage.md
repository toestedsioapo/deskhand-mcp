# 0007 — OAuth token storage

Status: Proposed · 2026-11-07

**Decision (v1).** Users bring their own OAuth client (Testing mode). The refresh token lives in the config dir (ADR 0005: `DESKHAND_HOME`, else `%LOCALAPPDATA%\deskhand` on Windows, `$XDG_CONFIG_HOME/deskhand` on Linux) in `token.json`, mode `0600` on POSIX; never logged, never in the ledger. Scopes requested incrementally: `calendar.readonly` and `gmail.readonly` first; `calendar.events` and `gmail.compose` only when `DESKHAND_ALLOW_WRITES=1`. `gmail.send` is never requested.

**Open.** OS keychain would need a native module or a CLI shell-out; deferred, needs its own ADR. Testing-mode refresh tokens expire after ~7 days; README must document re-auth.
