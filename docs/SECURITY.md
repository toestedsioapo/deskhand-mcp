# SECURITY — Deskhand MCP (draft)

## Model

The AI client and anything it reads (email, calendar text) are **untrusted**. The human at the terminal is trusted. Deskhand is local, single-user.

## Guarantees

- Read-only by default. Writes need `DESKHAND_ALLOW_WRITES=1`.
- Only `action_apply` has side effects, and only for plans that are unexpired, approved by a human via the CLI, unmodified since approval (hash), unapplied, and still valid against the real world (re-check).
- Approval is not reachable through MCP.
- Every tool call, including failures and rejections, is recorded in an append-only ledger.
- Mailbox/calendar content is returned wrapped as untrusted data; Deskhand never acts on instructions inside it.
- Minimum OAuth scopes; write scopes only when writes are enabled; no `gmail.send`.

## Limits (be honest in the README too)

- **The TTY + typed confirmation (last 4 chars of the action id) is a speed bump, not a boundary.** An agent with shell access could drive the CLI through a pty. Two mitigations: don't give the agent a shell in your user session, and use the **Claude Code deny rule** shipped in the README (`Bash(deskhand approve*)` under `permissions.deny`) so Claude Code can't invoke approve at all. The ledger records `approved_by` and `approval_method` for later audit.
- **The plan hash is not tamper-proof against local compromise.** Anyone who can write the SQLite file as your user can edit plan, hash and approval together.
- Prompt injection can still make the agent *propose* bad plans. You see the diff before approving; read it.
- Restricted Gmail scopes: you use your own OAuth client in Testing mode; refresh tokens expire after ~7 days.

## Files and permissions

Data dir per ADR 0005 (`%LOCALAPPDATA%\deskhand` on Windows; `DESKHAND_HOME` overrides). POSIX: dirs `0700`, files `0600` (db, `-wal`, `-shm`, token). Windows: POSIX modes don't apply; protection is the user-profile ACL, so keep `DESKHAND_HOME` inside your profile. WAL doesn't work on network drives. The ledger contains redacted previews, never tokens or full email bodies. The token file is the sensitive one.

## Repo hygiene

`.env*`, `credentials*.json`, `token*.json` are gitignored. No live Google calls in tests/CI. Releases only from GitHub Actions with npm provenance.

## Reporting

Contact: _TBD before release_.
