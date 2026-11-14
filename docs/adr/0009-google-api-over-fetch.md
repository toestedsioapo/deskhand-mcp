# 0009 — Google API over `fetch`, no `googleapis` dependency

Status: Accepted (owner-approved decisions, 2026-11-11, M3b plan decisions 3 and 7)

**Context.** The Google Calendar adapter needs three read calls (`events.list`, `freeBusy`, `events.get`) and one write (`events.insert`). The `googleapis` package is large, pulls many transitive dependencies, and would hide the exact requests Deskhand sends and the exact errors it can leak.

**Decision.**

1. **Plain `fetch`, no `googleapis` and no `google-auth-library`.** The adapter (`src/providers/google/http.ts`, `calendar.ts`) calls the Calendar API v3 REST endpoints directly. The OAuth loopback flow with PKCE is also hand-written (`oauth.ts`). Nothing new enters `package.json`, and tests replay recorded responses through an injected `fetch`.
2. **One request path.** Every call goes through `googleRequest`: it checks the host (`www.googleapis.com`, https only), the token's scope (before any request), refreshes an access token within 60 s of expiry (one shared in-flight refresh per config dir), retries once after a `401`, and maps outcomes to `AuthRequiredError` or `ProviderError`. Error text is built from fixed phrases, the HTTP status and a validated reason; response bodies, headers and tokens never reach a message.
3. **10 s timeout per request** (`AbortSignal.timeout`), surfaced as `ProviderError` "timed out".
4. **No automatic retry on 429 or 5xx.** The adapter reports `PROVIDER_ERROR` and the caller decides. This is safe because `action_apply` is retryable and idempotent: `createEvent` derives the event id from the idempotency key, so applying again after a failure cannot create a duplicate (ADR 0001, M3b plan decision 7).

**Rejected alternatives.** `googleapis` (size, hidden requests, error text that may carry response data); automatic exponential backoff (hides failures from the ledger and multiplies the time a tool call can hang).

**Consequences.** Deskhand owns request construction and response parsing, so recorded responses (`tests/recorded/google/`) are hand-written from the API reference and the adapter validates every field it reads. `tests/setup-no-network.ts` makes any un-injected fetch fail in tests (loopback excepted for the fake OAuth server).
