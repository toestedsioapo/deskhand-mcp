# SECURITY — Deskhand MCP (draft)

## Model

The AI client and anything it reads (email, calendar text) are **untrusted**. The human at the terminal is trusted. Deskhand is local, single-user.

## Guarantees

- Read-only by default. Writes need `DESKHAND_ALLOW_WRITES=1`.
- Only `action_apply` has side effects, and only for plans that are unexpired, approved by a human via the CLI, unmodified since approval (hash), unapplied, and still valid against the real world (re-check).
- Approval is not reachable through MCP.
- Every tool call, including failures and rejections, is recorded in an append-only ledger.
- Mailbox/calendar content is returned wrapped as untrusted data; Deskhand never acts on instructions inside it.
- Minimum OAuth scopes; write scopes only when writes are enabled; no `gmail.send`, no `gmail.modify`.
- **Drafts only is enforced in our code, not by the scope.** Google describes `gmail.compose` as "Manage drafts and send emails", so the scope alone would allow sending. The `MailProvider` interface has no send method, and a test asserts no send endpoint is ever called (fixture provider and recorded responses).
- `inbox_triage` only proposes labels/priority/next action; Deskhand never applies them in v1.
- Calendar plans default to `sendUpdates=none`; a plan that would notify attendees says so in the diff, and that setting is covered by the plan hash.

## Limits (be honest in the README too)

- **The TTY + typed confirmation (last 4 chars of the action id) is a speed bump, not a boundary.** An agent with shell access can drive `deskhand approve` through a pseudo-terminal: Python `pty`, `script` (util-linux or BSD), `unbuffer`/`expect`, Windows ConPTY or `winpty`, or a Node program (for example `child_process` with a pty module, or a ConPTY host) that allocates a pty, reads the plan from `deskhand pending` and types the last 4 characters. That is a known, documented way to approve without a human, not a bug we can close: a program running as your user can always present itself as a terminal. Piped stdin or redirected stdout is refused, but a pty is not distinguishable from a person. The gate protects against an agent that only speaks MCP and against accidents, not against an agent with a shell. Two mitigations: don't give the agent a shell in your user session, and use the **Claude Code deny rules** shipped in the README so Claude Code is blocked from the usual ways of invoking approve. The ledger records `approved_by` and `approval_method` for later audit.
- **The TTY gate cannot stop type-ahead or terminal injection into your own terminal.** Anything that can write to the terminal you are about to run `approve` in (for example `TIOCSTI` on older Linux kernels, or escape sequences that stuff the input buffer) can pre-type the confirmation. Run `approve` in a terminal no agent can write to.
- **Deny rules are best-effort, not a boundary**, in the same "speed bump" sense. Claude Code matches the command text, not the program: `/usr/bin/deskhand approve`, `sh -c '...'` or a renamed copy are not matched. Claude Code does strip wrappers like `timeout` and leading env assignments before matching deny rules, and checks each part of a compound command.
- Canonical invocation: `npx -p @marvinliem/deskhand-mcp deskhand approve <id>`. Rules to ship (syntax checked against the Claude Code permissions docs on 2026-11-09; `Bash(cmd *)` with a space before `*`, the `:*` suffix is an equivalent form; re-check when the README is written):
  ```json
  { "permissions": { "deny": [
    "Bash(deskhand approve *)",
    "Bash(npx *deskhand approve *)",
    "Bash(pnpm exec deskhand approve *)",
    "Bash(pnpm dlx *deskhand approve *)",
    "Bash(node *dist/cli.js approve *)"
  ] } }
  ```
- The `approve` command also refuses without a TTY on both stdin and stdout, and strips control/ANSI characters from untrusted text it prints.
- **Red-team review result (M2b):** _PLACEHOLDER. To be filled in by the controller after the independent red-team review of the M2b approval path (sandbox: `pnpm redteam:sandbox`, see `docs/DEVELOPMENT.md`). It must record every attempt, any successful bypass, and any approval driven through a faked TTY with the exact method. Nothing has been claimed here yet._
- **The plan hash is not tamper-proof against local compromise.** Anyone who can write the SQLite file as your user can edit plan, hash and approval together.
- Prompt injection can still make the agent *propose* bad plans. You see the diff before approving; read it.
- Restricted Gmail scopes: you use your own OAuth client in Testing mode; refresh tokens expire after ~7 days.

## Files and permissions

Data dir per ADR 0005 (`%LOCALAPPDATA%\deskhand` on Windows; `DESKHAND_HOME` overrides). POSIX: dirs `0700`, files `0600` (db, `-wal`, `-shm`, token). Windows: POSIX modes don't apply; protection is the user-profile ACL, so keep `DESKHAND_HOME` inside your profile. WAL doesn't work on network drives. The ledger contains redacted previews, never tokens or full email bodies. The token file is the sensitive one.

## Repo hygiene

`.env*`, `credentials*.json`, `token*.json` are gitignored. No live Google calls in tests/CI. Releases only from GitHub Actions with npm provenance.

## Reporting

Contact: _TBD before release_.
