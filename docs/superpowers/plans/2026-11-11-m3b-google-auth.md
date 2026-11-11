# M3b Google Calendar Adapter and `deskhand auth` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the M3a calendar tools against a real Google Calendar through the owner's own OAuth client, with minimum scopes, tokens that never reach the ledger or logs, and an apply path that cannot double-create an event.

**Architecture:** A Google adapter implements `CalendarProvider` over the built-in `fetch` (no Google SDK). `deskhand auth login | status | upgrade` runs a loopback OAuth flow with PKCE and stores `token.json` in the config dir. The server starts without a token; Google-backed calls then fail with `AUTH_REQUIRED`. Every HTTP dependency is injected, so tests use recorded responses and a fake OAuth endpoint, never the network.

**Tech Stack:** Node >=24.15 built-ins only (`fetch`, `node:http`, `node:crypto`), TypeScript strict, Zod 4.6.7, Vitest. No new dependencies.

**Spec:** `docs/SPEC.md` (§2.5, §6 `deskhand auth`), `docs/ARCHITECTURE.md` ("Auth", "Apply-time re-check"), ADR 0007, ADR 0001, `docs/SECURITY.md`, `docs/TEST_PLAN.md` ("Auth (M3)", "Scopes"), `docs/ASSUMPTIONS.md` (the `409` rule, tokens out of adapter errors, calendar idempotency), `docs/google-oauth-setup.md` (owner's setup guide).

**Depends on:** M3a merged (`DESKHAND_PROVIDER`, `listEvents`, `EventRef.allDay`, `PROVIDER_NOT_CONFIGURED`, ledger schema v3 with `NOT_FOUND` reserved, the three calendar tools, the viewer-zone diff). M3b starts only after the owner merges the M3a PR.

## Decisions (all owner-approved 2026-11-11, including staying with the ADR 0007 scopes in decision 2)

1. **M3 requests calendar scopes only.** ADR 0007 lists `calendar.readonly` and `gmail.readonly` together as the first step. M3 has no Gmail tool, so `login` asks for `calendar.readonly` alone, and `upgrade` adds `calendar.events`. `gmail.readonly` and `gmail.compose` wait for M4. This is the minimum for the feature, and it means M3 uses no restricted scope at all. Recorded as an addendum to ADR 0007.
2. **Narrower scopes exist; I recommend staying with ADR 0007 for now.** Google also offers `calendar.events.readonly` plus `calendar.freebusy` (instead of `calendar.readonly`) and `calendar.events.owned` (instead of `calendar.events`). They are narrower, but `calendar.events.owned` cannot touch events on calendars you do not own, and I have not verified free/busy behaviour under the narrower pair. Your call; switching later only changes two constants and needs a re-login.
3. **No Google SDK.** Four REST calls and a token refresh over `fetch`. The `googleapis` package would be the largest dependency in the project for the same result. Recorded as ADR 0009.
4. **`deskhand auth login` prints the consent URL; it does not launch a browser.** Launching needs a child process and differs per OS. You click or paste the link.
5. **Client-supplied event id is best-effort on Google's side.** The API reference says ids must be base32hex (`a-v`, `0-9`), 5 to 1024 characters, and that collisions are not guaranteed to be detected at creation time. Our key (64 lowercase hex characters) is valid. So the recovery lookup before the write (M2b gate 6) stays the primary guard, and the `409` mapping is the second one. The owner live check in Task 7 confirms both against the real API.
6. **Recorded responses are written by hand from the API reference**, with made-up ids and no personal data, because nothing may call Google from tests. Task 7's live check is what proves they match reality; any mismatch found there is fixed in the recording and the adapter together.
7. **Per-request HTTP timeout is 10 s**, no automatic retry on `429` or `5xx`. Apply is already retryable and idempotent; a hidden retry loop would only make the drain cap harder to reason about.

## Global Constraints

- Scope sets are exactly: read `["https://www.googleapis.com/auth/calendar.readonly"]`; write adds `"https://www.googleapis.com/auth/calendar.events"` and only when `DESKHAND_ALLOW_WRITES=1`. The strings `gmail.send` and `gmail.modify` never appear in `src/`.
- Tokens, the client secret, authorization codes and Google response bodies never appear in the ledger, `actions.error`, stdout, stderr or thrown error messages.
- No live network in tests or CI: a test setup file replaces `globalThis.fetch` with a function that throws.
- Tools never import `src/providers/google`; only `src/composition.ts` and `src/cli/auth.ts` do.
- The only provider write stays `createEvent`, called only through the apply engine (`tests/safety.structure.test.ts`).
- OAuth and API endpoints are constants; tests override them by injection, never by environment variable.
- `token.json` and `client_secret.json` live in the config dir, never in the repo; both patterns are gitignored.
- Test first. Commits carry no attribution lines.

## Review Focus

1. **Testing-mode refresh token expired (after about 7 days) or revoked:** Google answers `invalid_grant`. Every tool must return `AUTH_REQUIRED` telling the user to run `deskhand auth login`; `token.json` is left in place, nothing crashes. Test in Task 5.
2. **Writes enabled but the token has only the read scope:** `action_apply` must refuse with `AUTH_REQUIRED` naming `deskhand auth upgrade` before any HTTP request, status stays `approved`. Test in Task 6.
3. **An event with our id exists but is cancelled** (the user deleted it after a crashed apply): must not be reported as applied and must not be recreated silently. Test in Task 6.
4. **`client_secret.json` is the wrong kind** (a "Web application" client, a service-account key, or not JSON): `auth login` must say which kind is needed, in one line, without printing the file. Test in Task 1.
5. **The browser callback arrives with the wrong `state`, an `error=access_denied`, or never arrives:** login must fail cleanly (exit 1, one line, `cli:auth` row), store nothing, and close the listener. Test in Task 2.

---

### Task 1: Scopes, client file and token store

**Files:**
- Modify: `.gitignore` (already has `client_secret*.json` from the planning commit; verify), `docs/adr/0007-oauth-token-storage.md` (addendum: decision 1)
- Create: `src/config/scopes.ts`, `src/providers/google/client-file.ts`, `src/providers/google/token-store.ts`
- Test: `tests/scopes.test.ts`, `tests/google.client-file.test.ts`, `tests/google.token-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/config/scopes.ts
  export const SCOPE_CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";
  export const SCOPE_CALENDAR_WRITE = "https://www.googleapis.com/auth/calendar.events";
  export function requestedScopes(writesEnabled: boolean): string[];   // read only, or read + write
  // src/providers/google/client-file.ts
  export interface OAuthClient { clientId: string; clientSecret: string }
  export function loadOAuthClient(configDir: string): OAuthClient;      // reads <configDir>/client_secret.json; throws ConfigError
  // src/providers/google/token-store.ts
  export interface StoredToken {
    version: 1; client_id: string; scopes: string[];
    refresh_token: string; access_token: string;
    expires_at: string;      // access token expiry, ISO UTC
    obtained_at: string;     // when the refresh token was issued (login or upgrade)
  }
  export function tokenPath(configDir: string): string;                 // <configDir>/token.json
  export function readToken(configDir: string): StoredToken | null;     // null when missing; ConfigError when malformed
  export function writeToken(configDir: string, token: StoredToken): void;  // temp file + rename; mode 0600 on POSIX
  ```
- `loadOAuthClient` accepts only the Desktop-app shape `{ "installed": { "client_id", "client_secret", ... } }`.

- [ ] **Step 1: Write failing tests:** `requestedScopes(false)` equals `[SCOPE_CALENDAR_READ]`; `requestedScopes(true)` equals both, in that order; a scan of `src/` finds no `gmail.send` and no `gmail.modify`. Client file: missing gives `ConfigError` containing the full expected path and `docs/google-oauth-setup.md`; a `{ "web": … }` file says `create a "Desktop app" client`; a service-account key (`"type": "service_account"`) and non-JSON each give a one-line error; no error message contains the `client_secret` value. Token store: round trip; missing gives `null`; malformed gives `ConfigError` without echoing content; on POSIX the file mode is `0600` (skipped on Windows like the existing mode test); a failed write leaves the previous file intact; no temp file remains.
- [ ] **Step 2: Run** `pnpm test tests/scopes.test.ts tests/google.client-file.test.ts tests/google.token-store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: OAuth scope sets, client file loader and token store`.

### Task 2: Loopback OAuth flow

**Files:**
- Create: `src/providers/google/oauth.ts`
- Test: `tests/google.oauth.test.ts`, `tests/helpers/fake-oauth.ts` (a local `node:http` server on `127.0.0.1` playing Google's token endpoint)

**Interfaces:**
- Consumes: `OAuthClient`, `StoredToken`.
- Produces:
  ```ts
  export interface OAuthEndpoints { authUrl: string; tokenUrl: string }
  export const GOOGLE_ENDPOINTS: OAuthEndpoints;  // https://accounts.google.com/o/oauth2/v2/auth, https://oauth2.googleapis.com/token
  export interface OAuthDeps { fetch: typeof fetch; endpoints: OAuthEndpoints; now: () => Date; timeoutMs?: number /* default 300000 */ }
  export class OAuthError extends Error {}        // message is always one of our fixed sentences
  export function runLoopbackLogin(
    client: OAuthClient, scopes: string[], deps: OAuthDeps,
    onUrl: (url: string) => void,                 // called once with the consent URL
  ): Promise<StoredToken>;
  export function refreshAccessToken(client: OAuthClient, token: StoredToken, deps: OAuthDeps): Promise<StoredToken>;
  ```
- Flow: listen on `127.0.0.1` port `0`; redirect URI `http://127.0.0.1:<port>/oauth2callback`; consent URL parameters `client_id`, `redirect_uri`, `response_type=code`, `scope` (space-joined), `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`, `state` (32 random bytes, base64url), `code_challenge` (S256 of a 32-byte verifier), `code_challenge_method=S256`. The callback is accepted only on that path with a matching `state`; the browser gets a short plain page with no token in it. The code is exchanged at `tokenUrl` with the verifier. The listener closes on success, failure and timeout. The stored `scopes` are the ones the token response's `scope` field lists.
- `refreshAccessToken` posts `grant_type=refresh_token`. A response `error` of `invalid_grant` throws `OAuthError("The Google sign-in has expired or was revoked. Run: deskhand auth login")`.

- [ ] **Step 1: Write failing tests** against `fake-oauth`: happy path returns a token whose `scopes` match and whose `obtained_at` is `deps.now()`; the consent URL has every parameter above and no `client_secret`; the exchange request carries `code_verifier` matching the challenge; a callback with a wrong `state` gives `OAuthError`, exchanges nothing and closes the port; `error=access_denied` gives `OAuthError("Google sign-in was cancelled or denied.")`; no callback within `timeoutMs: 100` rejects and closes the port; a second callback after success gets a 400; a request to any other path gets 404 and does not end the flow; a token response without `refresh_token` gives `OAuthError` telling the user to remove the app's access in their Google account and log in again; a token endpoint body containing `ya29.SECRET` on an error path never appears in the thrown message; refresh: happy path updates `access_token` and `expires_at` and keeps `refresh_token` and `obtained_at`; `invalid_grant` gives the fixed sentence.
- [ ] **Step 2: Run** `pnpm test tests/google.oauth.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS on Windows and Linux (loopback only).
- [ ] **Step 5: Commit** `feat: loopback OAuth with PKCE and state; token refresh`.

### Task 3: `deskhand auth login | status | upgrade`

**Files:**
- Modify: `src/cli/index.ts` (remove `auth` from `PLANNED`, help text, dispatch), `docs/ledger-contract.md` ("CLI-originated rows": `cli:auth` preview shape)
- Create: `src/cli/auth.ts`
- Test: `tests/cli.auth.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2; `AppContext` (for `config`, `db`, `clock`).
- Produces: `authCommand(ctx: AppContext, io: CliIo, args: readonly string[], deps?: Partial<OAuthDeps>): Promise<number>`.
- Behaviour:
  - `login`: scopes are `requestedScopes(false)` always. Prints `Open this link in your browser to sign in:` and the URL, waits, writes the token, prints the granted scopes and `Sign-in saved. In Testing mode Google expires it after about 7 days.` Exit 0.
  - `upgrade`: refuses unless `ctx.config.writesEnabled` (`deskhand: auth upgrade needs DESKHAND_ALLOW_WRITES=1`, exit 1) and unless a token exists (`run deskhand auth login first`). Then the same flow with `requestedScopes(true)`.
  - `status`: no network. Prints whether `client_secret.json` and `token.json` exist, the granted scopes, whether the write scope is present, `obtained_at`, and `about N days left` computed as 7 days from `obtained_at` (or `probably expired`). Exit 0 when a token exists, 1 when not.
  - Anything else: usage, exit 2.
- Ledger: each run writes one `cli_command` row, `tool: "cli:auth"`, preview `{ v: 1, input: { subcommand }, output: { scopes } | null, note }`. Failures: outcome `error`, `error_code` `AUTH_REQUIRED` (denied, expired, missing token), `INVALID_INPUT` (bad or missing client file, usage), `PROVIDER_ERROR` (token endpoint failure).
- No output line and no ledger row ever contains a token, the client secret, the authorization code or the `state`.

- [ ] **Step 1: Write failing tests** with a scripted `CliIo` and `fake-oauth`: `login` writes `token.json`, prints the URL and the scope, exit 0, one `cli:auth` row `ok`; with `DESKHAND_ALLOW_WRITES=1`, `login` still requests the read scope only; `upgrade` without the flag exits 1 and requests nothing; `upgrade` with the flag requests both scopes and the stored token lists both; `status` with no token exits 1 and says how to log in; `status` 3 days after `obtained_at` says `about 4 days left`, 8 days after says `probably expired`; a denied login exits 1 with one stderr line, one row `error`/`AUTH_REQUIRED`, and no `token.json`; a missing client file exits 1 naming the path; leak test: serialise all io output and every ledger row and `token.json`'s sibling files, and assert the fake access token, refresh token, client secret and code appear nowhere except inside `token.json`; `deskhand --help` lists `auth` without "not implemented"; `deskhand auth` alone exits 2.
- [ ] **Step 2: Run** `pnpm test tests/cli.auth.test.ts tests/cli.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm build && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: deskhand auth login, status and upgrade`.

### Task 4: Provider errors, `AUTH_REQUIRED` mapping and secret scrubbing

**Files:**
- Modify: `src/approval/apply.ts`, `src/ledger/redact.ts`, `src/ledger/logging-transport.ts`, `src/tools/provider-guard.ts`, the three calendar tool files, `docs/ledger-contract.md` (apply: an auth failure at any provider call is an `apply_refused` with `AUTH_REQUIRED`, status unchanged; outcome `rejected`)
- Create: `src/providers/errors.ts`
- Test: `tests/apply.test.ts`, `tests/ledger.redact.test.ts`, `tests/tools.calendar-list-events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/providers/errors.ts
  export class AuthRequiredError extends Error {}          // message: a fixed sentence naming the deskhand auth command to run
  export class ProviderError extends Error {               // message: `<provider> <op> failed: HTTP <status>[ <reason>]` or `<provider> <op> failed: <fixed phrase>`
    constructor(provider: string, op: string, detail: { status?: number; reason?: string; phrase?: string });
  }
  // src/ledger/redact.ts
  export function scrubSecrets(text: string): string;
  // src/tools/provider-guard.ts
  export function providerFailure(e: unknown, extra?: { action_id?: string }): ToolErrorResult;
  ```
- `ProviderError` drops a `reason` that does not match `/^[A-Za-z]{1,40}$/`. It never stores a response body or headers.
- `scrubSecrets` replaces with `[redacted]`: `ya29.` access tokens, `1//` refresh tokens, `GOCSPX-` client secrets, `Bearer <anything>`, and three-part JWTs (`eyJ….….…`).
- `providerFailure`: `AuthRequiredError` gives `AUTH_REQUIRED` with its message; `ProviderError` gives `PROVIDER_ERROR` with its message; anything else gives `PROVIDER_ERROR` with `Calendar provider call failed.` (the unknown error's text is not used).
- Apply: `errText` runs `scrubSecrets` before the existing redactor. At the recovery lookup, the re-check, the post-failure lookups and the write, an `AuthRequiredError` is a refusal `AUTH_REQUIRED`, status unchanged, and it never marks a plan `failed`. `AUTH_REQUIRED` joins `GATE_REFUSALS` in `apply.ts` and `logging-transport.ts`.

- [ ] **Step 1: Write failing tests:** `scrubSecrets` on a string holding one of each pattern leaves none of them and keeps the surrounding words; a provider whose `createEvent` throws `new Error("401 Bearer ya29.A0AbC… refresh 1//0gXyZ…")` and whose lookup finds nothing: `actions.error` and every event preview contain no `ya29.`, no `1//0g`, no `Bearer `; a provider whose `getEvent` throws `AuthRequiredError`: apply answers `AUTH_REQUIRED`, one `apply_refused` row with outcome `rejected`, status `approved`; `AuthRequiredError` thrown by `createEvent` and again by the follow-up lookup: `AUTH_REQUIRED`, status still `approved`, not `failed`; `calendar_list_events` with a provider throwing `AuthRequiredError` gives `AUTH_REQUIRED` and a `tool_call` row `rejected`; with a provider throwing `new TypeError("fetch failed", { cause: new Error("secret-host") })` the tool answers `PROVIDER_ERROR: Calendar provider call failed.`; `new ProviderError("google calendar", "events.insert", { status: 403, reason: "rate<script>" })` has message `google calendar events.insert failed: HTTP 403`.
- [ ] **Step 2: Run** `pnpm test tests/apply.test.ts tests/ledger.redact.test.ts tests/tools.calendar-list-events.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: provider error types, AUTH_REQUIRED on every provider path, secret scrubbing in error text`.

### Task 5: Google HTTP client and read adapter

**Files:**
- Create: `src/providers/google/http.ts`, `src/providers/google/calendar.ts`, `docs/adr/0009-google-api-over-fetch.md`, `tests/recorded/google/*.json`, `tests/helpers/replay-fetch.ts`, `tests/setup-no-network.ts`
- Modify: `vitest.config.ts` (`setupFiles: ["tests/setup-no-network.ts"]`)
- Test: `tests/google.http.test.ts`, `tests/google.calendar.read.test.ts`

**Interfaces:**
- Consumes: `readToken`, `writeToken`, `refreshAccessToken`, `loadOAuthClient`, `AuthRequiredError`, `ProviderError`.
- Produces:
  ```ts
  // src/providers/google/http.ts
  export interface GoogleHttpDeps { fetch: typeof fetch; configDir: string; now: () => Date; oauth: OAuthDeps; timeoutMs?: number /* default 10000 */ }
  export interface GoogleResponse { status: number; json: unknown }
  export function googleRequest(
    deps: GoogleHttpDeps, op: string,
    req: { method: "GET" | "POST"; url: string; body?: unknown; requiredScope: string },
  ): Promise<GoogleResponse>;
  // src/providers/google/calendar.ts
  export function createGoogleCalendarProvider(deps: GoogleHttpDeps): CalendarProvider;
  ```
- `googleRequest`: no `token.json` gives `AuthRequiredError("Not signed in to Google. Run: deskhand auth login")`; a token lacking `requiredScope` gives `AuthRequiredError("Google write access is not granted. Run: deskhand auth upgrade")` **before any request**; an access token within 60 s of expiry is refreshed first and the new token written; a `401` triggers one refresh and one retry, a second `401` is `AuthRequiredError`; `403` with reason `insufficientPermissions` is the upgrade `AuthRequiredError`; a refresh `invalid_grant` is `AuthRequiredError` with the login sentence; timeout (`AbortSignal.timeout`) and network errors are `ProviderError` with phrase `timed out` or `network error`. It returns `2xx`, `404` and `409` to the caller and turns every other status into `ProviderError` with the status and the validated `error.errors[0].reason`. The URL host must be `www.googleapis.com`.
- Read methods (base `https://www.googleapis.com/calendar/v3`, calendar id passed through `encodeURIComponent`):
  - `listEvents`: `GET /calendars/{id}/events` with `timeMin`, `timeMax`, `singleEvents=true`, `orderBy=startTime`, `maxResults=<limit>`, `fields=items(id,etag,status,summary,start,end,attendees/email),nextPageToken`. `truncated` is true when `nextPageToken` is present. Cancelled items are dropped. A timed event maps `start.dateTime`/`end.dateTime` to UTC `…Z` with milliseconds and `allDay: false`; an all-day event (`start.date` present) maps to `allDay: true` with `start.date`/`end.date` passed through unchanged as `YYYY-MM-DD` (Google's `end.date` is already exclusive, the M3a representation), never to a midnight instant. An item with neither `dateTime` nor `date`, or mixing the two, is a `ProviderError` with phrase `unreadable event time`. A missing `summary` is `""`.
  - `freeBusy`: `POST /freeBusy` with `{ timeMin, timeMax, items: [{ id }] }`; returns `calendars[id].busy` sorted; a non-empty `calendars[id].errors` is a `ProviderError` with that entry's validated `reason`.
  - `getEvent`: `GET /calendars/{id}/events/{eventId}`; `404` gives `null`; an event with `status: "cancelled"` gives `null`; the same timed/all-day mapping as `listEvents`.
- `tests/setup-no-network.ts` sets `globalThis.fetch` to a function that throws `Error("network access is forbidden in tests")`. `replay-fetch` serves `tests/recorded/google/<name>.json` files (`{ request: { method, url }, response: { status, body } }`), fails the test on any unmatched or unused recording, and fails on any request whose URL contains `/send` or whose host is not `www.googleapis.com` or `oauth2.googleapis.com`.

- [ ] **Step 1: Write the recordings** by hand from the Calendar API v3 reference (decision 6): `events.list` (two timed events, one all-day, one cancelled, with and without `nextPageToken`), `freebusy` (two busy blocks; a `notFound` calendar error), `events.get` (found, `404`, cancelled), `401` then success, `403 insufficientPermissions`, `429 rateLimitExceeded`, `500` with a body containing a fake token string. Ids are made up; addresses are `@example.com`.
- [ ] **Step 2: Write failing tests** for every rule in the Interfaces block, plus: the all-day recording item (`start.date` `2026-11-12`, `end.date` `2026-11-13`) comes back as `{ allDay: true, start: "2026-11-12", end: "2026-11-13" }` and the timed ones as `allDay: false` with `Z` instants; through `calendar_list_events` it is `all_day: true` with the same dates; the `Authorization` header is `Bearer <access token>` and appears in no thrown message; the `500` recording's body text appears in no thrown message; a refresh that returns a new access token rewrites `token.json` and keeps the refresh token; `invalid_grant` leaves `token.json` unchanged; two concurrent requests with an expired access token both succeed; a calendar id `team/room@x` is percent-encoded in the path; with no injected `fetch`, a call hits the global guard and fails with the forbidden-network error.
- [ ] **Step 3: Run** `pnpm test tests/google.http.test.ts tests/google.calendar.read.test.ts` — Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm typecheck && pnpm test` — Expected: PASS, and the whole existing suite still passes under the no-network guard.
- [ ] **Step 6: Commit** `feat: Google Calendar read adapter over fetch with recorded-response tests`.

### Task 6: Google `createEvent` and the `409` rule

**Files:**
- Modify: `src/providers/google/calendar.ts`, `tests/recorded/google/` (insert recordings), `tests/safety.structure.test.ts`
- Test: `tests/google.calendar.write.test.ts`, `tests/apply.google.test.ts`

**Interfaces:**
- `createEvent(event, idempotencyKey)`: `POST /calendars/{id}/events?sendUpdates=<event.sendUpdates>` with body `{ id: idempotencyKey, summary: title, start: { dateTime: start, timeZone? }, end: { dateTime: end, timeZone? }, attendees: [{ email }] }`, `requiredScope: SCOPE_CALENDAR_WRITE`.
  - `200`: map the response to `EventRef` (`allDay: false`).
  - `409`: the id exists. `GET` that event. Found and not cancelled: return it (no second insert, never a new id). Cancelled: `ProviderError` with phrase `an event with this action's id was created and later deleted`. `404` on that `GET`: `ProviderError` with phrase `id conflict but the event is not readable`.
  - Before sending, the key must match `/^[a-v0-9]{5,1024}$/`, else `ProviderError` with phrase `invalid event id` (guards a future change to the key derivation).

- [ ] **Step 1: Write the recordings:** insert `200`; insert `409 duplicate` followed by get `200`; `409` followed by get cancelled; `409` followed by get `404`; insert `403 insufficientPermissions`; insert `500`.
- [ ] **Step 2: Write failing tests.**
  - Adapter: the request body and query match exactly, `sendUpdates=none` by default plan, `all` when planned; `409` then found returns the existing event and makes exactly two requests; the two `409` failure cases give the phrases above; a token with only the read scope throws the upgrade `AuthRequiredError` and makes **zero** requests; a key with an uppercase letter gives `invalid event id` and zero requests; no request URL in any recording or test contains `/send`.
  - Through the apply engine with the Google provider on `replay-fetch` (`tests/apply.google.test.ts`): a normal apply makes lookup `404`, free/busy empty, insert `200` and ends `applied`; a retry after a simulated crash (lookup finds the event) ends `applied`, `replayed: true`, with no insert request; insert `409` then found ends `applied`; insert `500` then lookup `404` ends `failed` with `PROVIDER_ERROR`, and neither `actions.error` nor any row contains the fake token from the `500` body; insert `409` then cancelled ends `failed` with the deleted-event phrase; read-only token with writes on: `AUTH_REQUIRED`, status `approved`, zero requests to the insert URL.
- [ ] **Step 3: Run** `pnpm test tests/google.calendar.write.test.ts tests/apply.google.test.ts tests/safety.structure.test.ts` — Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `pnpm typecheck && pnpm test` — Expected: PASS.
- [ ] **Step 6: Commit** `feat: Google createEvent with a client-supplied id; 409 means already created`.

### Task 7: Wiring, docs, owner live check

**Files:**
- Modify: `src/config/env.ts` (`DESKHAND_PROVIDER` accepts `google`), `src/composition.ts` (`selectProvider` builds the Google provider with the real `fetch`, `GOOGLE_ENDPOINTS` and the real clock; no token is read at startup), `docs/google-oauth-setup.md` (replace the "after M3b" notes with the real commands and outputs), `docs/SECURITY.md` (token file, scopes actually requested, the 7-day expiry, the id-collision caveat), `docs/TEST_PLAN.md` (Auth and Scopes rows now name the tests; a "Manual Google check" section), `docs/DEVELOPMENT.md`, `docs/ROADMAP.md` (M3 done), `docs/ASSUMPTIONS.md` (close "Calendar idempotency" with the live result; record decisions 2, 4, 6, 7), `CLAUDE.md`
- Test: `tests/config.test.ts`, `tests/server.stdio.test.ts`, `tests/packaging.test.ts`

**Interfaces:**
- Consumes: everything above. Produces no new names.

- [ ] **Step 1: Write failing tests:** `DESKHAND_PROVIDER=google` is accepted; `DESKHAND_PROVIDER=google` with `DESKHAND_FIXTURE` set is a `ConfigError`; the built server with `DESKHAND_PROVIDER=google` and an empty `DESKHAND_HOME` starts with clean stderr, answers `ping`, and `calendar_list_events` answers `AUTH_REQUIRED` with a `tool_call` row `rejected` (no network: there is no token, so no request is attempted); `action_apply` on an approved plan in that state answers `AUTH_REQUIRED` and leaves it `approved`; a structural test asserts that only `src/composition.ts` and `src/cli/auth.ts` import from `src/providers/google/`.
- [ ] **Step 2: Run** `pnpm test tests/config.test.ts tests/server.stdio.test.ts tests/safety.structure.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** and update the docs.
- [ ] **Step 4: Run** `pnpm typecheck && pnpm build && pnpm test` — Expected: all PASS, stderr pristine. Inspector CLI check in fixture mode as in M3a.
- [ ] **Step 5: Manual Google check (owner, real account, not CI).** Follow `docs/google-oauth-setup.md`, then in a real terminal with `DESKHAND_PROVIDER=google`:
  1. `deskhand auth login`, then `deskhand auth status`: the read scope only, about 7 days left.
  2. `calendar_list_events` through the Inspector for this week: your events, titles wrapped as untrusted.
  3. `calendar_propose_event` for a free 30-minute slot tomorrow with no attendees: a plan; your calendar is unchanged.
  4. `deskhand approve <id>`, then `action_apply` without `DESKHAND_ALLOW_WRITES`: `WRITES_DISABLED`. With `DESKHAND_ALLOW_WRITES=1` but before `upgrade`: `AUTH_REQUIRED` naming `deskhand auth upgrade`.
  5. `deskhand auth upgrade`, then `action_apply`: the event appears once at the right local time. `action_apply` again: `replayed: true`, still one event.
  6. Delete the test event in Google Calendar. Check `ledger.db` rows and `token.json`'s directory: no token text in the ledger.
  Record each result in the PR description. Any difference from the hand-written recordings is fixed before merge.
- [ ] **Step 6: Commit** `feat: DESKHAND_PROVIDER=google; docs: M3 done, Google setup and manual check`.

---

## Self-review

- **Spec coverage:** ROADMAP M3 "Google calendar adapter (recorded tests)" (T5, T6); "`deskhand auth login/status/upgrade`" (T1 to T3). TEST_PLAN "Auth (M3)": fake OAuth endpoint, token in the config dir with restrictive mode, never in ledger or logs (T1 to T3), `upgrade` adds write scopes only (T3), server starts without a token and Google-backed tools return `AUTH_REQUIRED` (T7), fixture needs no auth (unchanged). TEST_PLAN "Scopes" (T1). ASSUMPTIONS: `409` on insert means already created (T6); tokens and response bodies out of `actions.error` and previews (T4, T5, T6); calendar idempotency verified against the API (T7 Step 5).
- **Type consistency:** `OAuthDeps` (T2) is used by `authCommand` (T3) and nested in `GoogleHttpDeps` (T5). `StoredToken.scopes` (T1) drives the `requiredScope` check (T5, T6). `AuthRequiredError` and `ProviderError` (T4) are the only errors the adapter throws (T5, T6) and the only ones apply and the tools branch on.
- **Contract changes:** none to tables or value sets (`AUTH_REQUIRED` already exists; checked again in M3a decision 10: M3b needs no new error code, and `NOT_FOUND` from migration 3 stays unused until M4). `cli:auth` preview shape documented. `AUTH_REQUIRED` is logged as outcome `rejected`.
- **Not in M3b, on purpose:** Gmail scopes and tools (M4); launching a browser; OS keychain (ADR 0007, deferred); retries with backoff; updating or deleting events; a recording tool that captures live responses.
