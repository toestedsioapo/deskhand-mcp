# 0007 — OAuth token storage and scopes

Status: Accepted (owner review, 2026-11-09)

**Decision (v1).** Users bring their own OAuth client (Testing mode). The refresh token lives in the config dir (ADR 0005: `DESKHAND_HOME`, else `%LOCALAPPDATA%\deskhand` on Windows, `$XDG_CONFIG_HOME/deskhand` on Linux, `~/Library/Application Support/deskhand` on macOS) in `token.json`, mode `0600` on POSIX; never logged, never in the ledger.

**Scopes**, requested incrementally: `calendar.readonly` and `gmail.readonly` first; `calendar.events` and `gmail.compose` only when `DESKHAND_ALLOW_WRITES=1`. `gmail.send` is never requested, and `gmail.modify` is not requested in v1: `inbox_triage` only *proposes* labels, priority and next action and never applies them. Applying labels is post-v1 and needs its own ADR.

**`gmail.compose` caveat.** Google describes `gmail.compose` as "Manage drafts and send emails", so the scope alone does not make Deskhand drafts-only. "Drafts only" is enforced in our code: the `MailProvider` interface has no send method (ADR 0001), and a test asserts no send endpoint is ever called (fixture provider and recorded responses). Narrower scopes are not an option for draft creation.

**Open.** OS keychain would need a native module or a CLI shell-out; deferred, needs its own ADR. Testing-mode refresh tokens expire after ~7 days; README must document re-auth.
