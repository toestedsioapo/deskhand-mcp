# 0001 — Provider interface and fixture provider

Status: Accepted (owner review, 2026-11-09)

**Context.** Deskbench (P3) and Deskflow demo mode (P4) need to run Deskhand with no Google account; CI forbids live API calls.

**Decision.** All calendar/mail access goes through `CalendarProvider` / `MailProvider` interfaces. A `fixture` provider loads a versioned fake world. Tools never import Google adapters directly. Interfaces include the apply-time re-check primitives (`freeBusy`, `getEvent` with etag, latest message id). `MailProvider` has **no send method**: it can read, search and create drafts, nothing else. That is how "drafts only" is enforced (the Gmail `gmail.compose` scope itself also allows sending; see ADR 0007 and SECURITY.md).

**Consequences.** The fixture format is a cross-project contract (breaking changes = major bump). Google adapters are tested with recorded responses only. A future Outlook provider is possible without touching tools.
