# 0002 — Out-of-band approval, plan-hash binding, apply-time re-check

Status: Proposed · 2026-11-07

**Context.** The agent drives MCP tools, so any approval path reachable through a tool can be driven by a prompt-injected agent.

**Decision.**
1. **Approval is a CLI action, not an MCP tool.** `action_apply` only reads approvals from the ledger. `deskhand approve <id>` requires an interactive TTY on both stdin and stdout, prints the human-readable diff and the first 8 hex chars of the plan hash, and requires the user to type the **last 4 characters of the action_id**. No `--yes`, no piped input. The ledger records `approved_by` and `approval_method` (`cli_tty`). `deskhand reject <id> [reason]` needs no TTY (worst case an agent rejects a good plan, which is safe) but records `rejection_method` (`cli_tty` or `cli_no_tty`). The README ships a Claude Code permissions deny-rule snippet for `deskhand approve*`.
2. **Hash binding.** At plan time store `plan_hash = sha256(canonical_json(plan_json))`. Approve recomputes from stored `plan_json`, verifies it equals `plan_hash`, and records `approved_plan_hash`. `action_apply` recomputes again and refuses (status `failed`, code `PLAN_MODIFIED`) unless all three match. `plan_json` is never updated after planning.
3. **Apply-time re-check.** Before a calendar write, confirm the slot is still free and referenced events are unchanged (etag/updated). Otherwise fail with `STALE_PLAN`, log it, and do not write. Failed is terminal; the agent re-plans.
4. **Idempotency.** Provider writes use an idempotency key derived from `action_id` (e.g. a deterministic Calendar event id), so a crash between the provider write and the ledger update can't double-apply.
5. `ApprovalSource` seam: the CLI is the only v1 implementation; MCP elicitation (B) or Deskflow approval (P4) can be added later by recording a different `approval_method`, without changing apply. Action ids must be long enough that 4 trailing characters aren't the only thing distinguishing pending plans in practice; the CLI shows the full id and refuses if two pending ids share the same last 4.

**Consequences / honest limits.** The TTY rule is a speed bump, not a security boundary: an agent with shell access could allocate a pty and type the confirmation. The hash protects against bugs and in-flight modification, not an attacker who can already write the SQLite file as the same user (they can edit all three values). Documented in SECURITY.md. Mitigation if needed later: HMAC with a key outside the DB.

**Rejected.** Approval via an MCP tool (self-approvable); elicitation as v1 (client-controlled, uneven support).
