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

- **The TTY + typed confirmation (last 4 chars of the action id) is a speed bump, not a boundary.** An agent with shell access can drive `deskhand approve` through a pseudo-terminal: Python `pty`, `script` (util-linux or BSD), `unbuffer`/`expect`, Windows ConPTY or `winpty`, or a Node program (for example `child_process` with a pty module, or a ConPTY host) that allocates a pty, reads the plan from `deskhand pending` and types the last 4 characters. That is a known, documented way to approve without a human, not a bug we can close: a program running as your user can always present itself as a terminal. Piped stdin or redirected stdout is refused, but a pty is not distinguishable from a person. The gate protects against an agent that only speaks MCP and against accidents, not against an agent with a shell. Two mitigations: don't give the agent a shell in your user session, and use the **Claude Code deny rules** shipped in the README so Claude Code is blocked from the usual ways of invoking approve. The ledger records `approved_by` and `approval_method` for later audit (what the approving process claimed; see the next item for why that is not proof).
- **The cheapest bypasses need no terminal at all.** An agent or process that can run code as your user can (a) import `dist/approval/approve.js` (for example next to `dist/composition.js`, which builds the context) and call `approveAction` with a hand-made `CliIo` object that claims both streams are TTYs and returns the last 4 characters from `readLine`; or (b) write the SQLite file directly (set `status`, the approval columns and `approved_plan_hash` in one `UPDATE`). The TTY gate is therefore a speed bump against an agent **without** code-execution rights, **not** a barrier against one that has them. `approved_by` and `approval_method` record what the caller claimed and have no audit value against such an attacker. The future mitigation is ADR 0002's HMAC with a key outside the DB: apply would verify an HMAC over the approval, so a forged row does not verify. It only helps as far as the key is out of the agent's reach (a key file readable by the same user is readable by the agent too).
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
- **Red-team review result (M2b, 2026-11-10):** an independent reviewer that had not seen the implementation attacked a seeded sandbox (`pnpm redteam:sandbox`: P1 planned, P2 rejected, P3 approved but expired, P4 failed, P5 planned with an edited `plan_json`) black box, through the MCP server and the CLI. **No intended-path bypass:** the sandbox write log stayed empty and none of P1-P5 became `applied`. Blocked: every `action_apply` shape (undeclared fields such as `approved`/`approved_by`/`force`/`status` are rejected by the strict schema; `__proto__` keys are inert; odd ids give `UNKNOWN_ACTION`; calls before `initialize`, after a cancel, and replays are all re-gated from the ledger), unknown `approve`/`action_approve` tools, piped or redirected `deskhand approve` (including the correct last 4, `--yes`/`--force` flags and invented env vars: `NOT_A_TTY` or a usage error), and approve/apply on the rejected, expired, failed and tampered plans (`NOT_APPROVED`, `PLAN_EXPIRED`, `PLAN_MODIFIED`). Every attempt left a ledger row. **Documented limits reproduced:** (1) *Fake TTY:* a Node `--import` preload that replaces `process.stdin` with a stream whose `isTTY` is true, and sets `process.stdout.isTTY`, got past the `NOT_A_TTY` gate (the run reached the hash and status checks). It did not finish an approval, because the plans it was pointed at were the tampered P5 (`PLAN_MODIFIED`, independent of the typed text) and P1 after the reviewer had rejected it (`NOT_PENDING`); on a fresh untampered plan it should be expected to succeed. `winpty` and Unix `pty` were unavailable from the non-interactive Windows shell. (2) *Direct database write:* on a scratch copy of the ledger, `UPDATE actions SET status='approved', approved_plan_hash=plan_hash` on P1 followed by `action_apply` wrote exactly one fixture event, and a second apply replayed with no second write. Both match the limits above. Observation, not a safety issue: the SDK server executed a `tools/call` sent before `initialize` completed; every gate still applied (see `docs/ASSUMPTIONS.md`).
- **The plan hash is not tamper-proof against local compromise.** Anyone who can write the SQLite file as your user can edit plan, hash and approval together.
- Prompt injection can still make the agent *propose* bad plans. You see the diff before approving; read it.
- Restricted Gmail scopes: you use your own OAuth client in Testing mode; refresh tokens expire after ~7 days.

## Files and permissions

Data dir per ADR 0005 (`%LOCALAPPDATA%\deskhand` on Windows; `DESKHAND_HOME` overrides). POSIX: dirs `0700`, files `0600` (db, `-wal`, `-shm`, token). Windows: POSIX modes don't apply; protection is the user-profile ACL, so keep `DESKHAND_HOME` inside your profile. WAL doesn't work on network drives. The ledger contains redacted previews, never tokens or full email bodies. The token file is the sensitive one.

## Repo hygiene

`.env*`, `credentials*.json`, `token*.json` are gitignored. No live Google calls in tests/CI. Releases only from GitHub Actions with npm provenance.

## Reporting

Contact: _TBD before release_.
