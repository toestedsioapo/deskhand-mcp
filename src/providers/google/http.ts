import { SCOPE_CALENDAR_WRITE, SCOPE_GMAIL_COMPOSE } from "../../config/scopes.js";
import { AuthRequiredError, ProviderError } from "../errors.js";
import { loadOAuthClient } from "./client-file.js";
import { OAuthError, refreshAccessToken, type OAuthDeps } from "./oauth.js";
import { readToken, writeToken, type StoredToken } from "./token-store.js";

export interface GoogleHttpDeps {
  fetch: typeof fetch;
  configDir: string;
  now: () => Date;
  oauth: OAuthDeps;
  /** Per-request timeout. Default 10000. */
  timeoutMs?: number;
}

export interface GoogleResponse {
  status: number;
  json: unknown;
}

export type GoogleService = "calendar" | "gmail";
/** The provider label in error text. */
const providerOf = (service: GoogleService): string => `google ${service}`;
const API_HOST = "www.googleapis.com";
const REFRESH_MARGIN_MS = 60_000;
const NOT_SIGNED_IN = "Not signed in to Google. Run: deskhand auth login";
const NO_WRITE = "Google write access is not granted. Run: deskhand auth upgrade";
const EXPIRED = "The Google sign-in has expired or was revoked. Run: deskhand auth login";
const NO_CLIENT_FILE = "The Google OAuth client file is missing or unreadable. See docs/google-oauth-setup.md";

/** Only a missing write scope is fixed by `auth upgrade`; a missing read scope means signing in again. */
const missingScopeMessage = (scope: string): string =>
  scope === SCOPE_CALENDAR_WRITE || scope === SCOPE_GMAIL_COMPOSE ? NO_WRITE : NOT_SIGNED_IN;

const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GMAIL_BASE = ["gmail", "v1", "users", "me"];

/** A Gmail id path segment: the raw form and the once-decoded form must both match the id pattern. */
function isGmailId(raw: string | undefined): boolean {
  if (raw === undefined || !GMAIL_ID.test(raw)) return false;
  try {
    return GMAIL_ID.test(decodeURIComponent(raw));
  } catch {
    return false;
  }
}

/**
 * The only Gmail calls Deskhand makes (M4b decision 2): read the profile, threads and drafts, and create a draft.
 * Anything else, a send URL included, throws before any token is loaded and before any network call. The caller
 * adds the operation name; this carries no request content.
 */
export function assertAllowedGmailRequest(method: string, url: URL): void {
  const segments = url.pathname.split("/").slice(1);
  const rest = segments.slice(GMAIL_BASE.length);
  const [kind, id] = rest;
  let ok = false;
  if (GMAIL_BASE.every((s, i) => segments[i] === s)) {
    if (method === "GET" && rest.length === 1) ok = kind === "profile" || kind === "threads" || kind === "drafts";
    else if (method === "GET" && rest.length === 2) ok = (kind === "threads" || kind === "drafts") && isGmailId(id);
    else if (method === "POST" && rest.length === 1) ok = kind === "drafts";
  }
  if (!ok) throw new NotAllowed();
}

/** The refusal for a request outside the allowlist; it carries no request content. */
export const ENDPOINT_REFUSED = "refused request to an endpoint outside the allowlist";

class NotAllowed extends Error {
  constructor() {
    super(ENDPOINT_REFUSED);
  }
}

/** True when a raw path segment, decoded once and split on both separators, has a `.` or `..` component. Bad encoding counts. */
function hasDotComponent(path: string): boolean {
  return path.split("/").some((segment) => {
    try {
      return decodeURIComponent(segment).split(/[/\\]/).some((c) => c === "." || c === "..");
    } catch {
      return true;
    }
  });
}

/**
 * The path as written. WHATWG parsing strips leading and trailing C0 controls and spaces, drops tabs and line breaks,
 * and would then normalise a literal `..` away, so the same is stripped here first.
 */
const rawPath = (rawUrl: string): string => /^[a-z][a-z0-9+.-]*:[/\\]+[^/\\?#]*([^?#]*)/i.exec(rawUrl.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, ""))?.[1] ?? "/..";

/** A calendar request stays under the prefix, and neither its written nor its parsed path holds a dot segment. */
const isCalendarRequest = (rawUrl: string, url: URL): boolean =>
  url.pathname.startsWith("/calendar/v3/") && !hasDotComponent(rawPath(rawUrl)) && !hasDotComponent(url.pathname);

const nearExpiry = (t: StoredToken, now: Date): boolean => !(Date.parse(t.expires_at) - now.getTime() >= REFRESH_MARGIN_MS);

/** A missing or malformed token.json is "not signed in"; the file's content is never echoed. */
function loadToken(configDir: string): StoredToken {
  let t: StoredToken | null;
  try {
    t = readToken(configDir);
  } catch {
    throw new AuthRequiredError(NOT_SIGNED_IN);
  }
  if (t === null) throw new AuthRequiredError(NOT_SIGNED_IN);
  return t;
}

/** One in-flight refresh per config dir, so parallel requests do not both rotate and write the token. */
const inflight = new Map<string, Promise<StoredToken>>();

function refresh(deps: GoogleHttpDeps, service: GoogleService, op: string, staleAccessToken: string): Promise<StoredToken> {
  let p = inflight.get(deps.configDir);
  if (p === undefined) {
    p = doRefresh(deps, service, op, staleAccessToken).finally(() => inflight.delete(deps.configDir));
    inflight.set(deps.configDir, p);
  }
  return p;
}

class TimedOut extends Error {}

/** Runs `run` with an abort signal and rejects with TimedOut after the request timeout, even if `run` ignores the signal. */
function withTimeout<T>(deps: GoogleHttpDeps, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ms = deps.timeoutMs ?? 10_000;
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new TimedOut());
    }, ms);
  });
  return Promise.race([run(ctl.signal), timeout]).finally(() => clearTimeout(timer));
}

async function doRefresh(deps: GoogleHttpDeps, service: GoogleService, op: string, staleAccessToken: string): Promise<StoredToken> {
  // Re-read: another process (or an earlier request) may already have refreshed.
  const current = loadToken(deps.configDir);
  if (current.access_token !== staleAccessToken && !nearExpiry(current, deps.now())) return current;
  let client;
  try {
    client = loadOAuthClient(deps.configDir);
  } catch {
    // A fixed sentence (never the file's content); `deskhand auth login` reports exactly what is wrong with it.
    throw new AuthRequiredError(NO_CLIENT_FILE);
  }
  let next: StoredToken;
  try {
    next = await withTimeout(deps, (signal) =>
      refreshAccessToken(client, current, { ...deps.oauth, fetch: (u, init) => deps.oauth.fetch(u, { ...init, signal }) }),
    );
  } catch (e) {
    // The API request was not sent: trying again is safe (retryable).
    if (e instanceof TimedOut) throw new ProviderError(providerOf(service), op, { phrase: "timed out", retryable: true });
    if (e instanceof OAuthError && e.code === "AUTH_REQUIRED") throw new AuthRequiredError(EXPIRED);
    throw new ProviderError(providerOf(service), op, { phrase: "token refresh failed", retryable: true });
  }
  // Re-read before writing: a `deskhand auth login` or `upgrade` in another process may have saved a new sign-in
  // while we waited for Google. That token is newer than ours: keep the file as it is and use it.
  const onDisk = loadToken(deps.configDir);
  if (onDisk.refresh_token !== current.refresh_token || onDisk.obtained_at !== current.obtained_at) return onDisk;
  try {
    writeToken(deps.configDir, next);
  } catch {
    throw new ProviderError(providerOf(service), op, { phrase: "could not save token", retryable: true });
  }
  return next;
}

const reasonOf = (json: unknown): string | undefined => {
  const err = (json as { error?: { errors?: { reason?: unknown }[] } } | null)?.error;
  const reason = Array.isArray(err?.errors) ? err.errors[0]?.reason : undefined;
  return typeof reason === "string" ? reason : undefined;
};

async function send(
  deps: GoogleHttpDeps,
  service: GoogleService,
  op: string,
  req: { method: "GET" | "POST"; url: string; body?: unknown },
  accessToken: string,
): Promise<GoogleResponse> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: "application/json" };
  // Never follow a redirect: it would take the bearer token and the body past the API host check.
  const init: RequestInit = { method: req.method, headers, redirect: "error", signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) };
  if (req.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }
  try {
    const res = await deps.fetch(req.url, init);
    let json: unknown = null;
    try {
      json = await res.json();
    } catch (e) {
      if ((e as { name?: string }).name === "TimeoutError") throw e;
      // Non-JSON body: status handling below does not need it.
    }
    return { status: res.status, json };
  } catch (e) {
    const timedOut = (e as { name?: string } | null)?.name === "TimeoutError";
    // The outcome is unknown (the request may have reached Google): retryable, never a definite rejection.
    throw new ProviderError(providerOf(service), op, { phrase: timedOut ? "timed out" : "network error", retryable: true });
  }
}

/**
 * One authenticated Google API call. Returns 2xx, 404 and 409 to the caller;
 * every other outcome is an AuthRequiredError or a ProviderError whose text
 * never holds a token, header or response body. A ProviderError is `retryable`
 * for a timeout, a network error, HTTP 429 and 5xx (outcome unknown or
 * transient), and definite for every other status. A redirect is never
 * followed (a network error to the caller).
 *
 * `singleSend` is for a write with no unique key (a Gmail draft): the request is sent at most once, so it ends inside
 * the write claim's hold. A 401 still refreshes the token for the next apply, then throws a retryable ProviderError;
 * an error from that refresh propagates unchanged.
 */
export async function googleRequest(
  deps: GoogleHttpDeps,
  op: string,
  req: { service: GoogleService; method: "GET" | "POST"; url: string; body?: unknown; requiredScope: string; singleSend?: boolean },
): Promise<GoogleResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new ProviderError(providerOf(req.service), op, { phrase: "invalid request URL" });
  }
  if (url.protocol !== "https:" || url.hostname !== API_HOST || url.port !== "" || url.username !== "" || url.password !== "") {
    throw new ProviderError(providerOf(req.service), op, { phrase: "refused request to an unexpected host" });
  }
  // The service label is bound to the path (checked on the parsed URL, the form that is sent), so a Gmail URL cannot
  // pass under the calendar label and skip the allowlist.
  try {
    if (req.service === "gmail") assertAllowedGmailRequest(req.method, url);
    else if (!isCalendarRequest(req.url, url)) throw new NotAllowed();
  } catch (e) {
    if (e instanceof NotAllowed) throw new ProviderError(providerOf(req.service), op, { phrase: e.message });
    throw e;
  }

  let token = loadToken(deps.configDir);
  if (!token.scopes.includes(req.requiredScope)) throw new AuthRequiredError(missingScopeMessage(req.requiredScope));
  if (nearExpiry(token, deps.now())) token = await refresh(deps, req.service, op, token.access_token);

  let res = await send(deps, req.service, op, req, token.access_token);
  if (res.status === 401) {
    token = await refresh(deps, req.service, op, token.access_token);
    if (req.singleSend === true) throw new ProviderError(providerOf(req.service), op, { phrase: "access token refreshed; retry", retryable: true });
    res = await send(deps, req.service, op, req, token.access_token);
    if (res.status === 401) throw new AuthRequiredError(EXPIRED);
  }
  const reason = reasonOf(res.json);
  if (res.status === 403 && reason === "insufficientPermissions") throw new AuthRequiredError(missingScopeMessage(req.requiredScope));
  if ((res.status >= 200 && res.status < 300) || res.status === 404 || res.status === 409) return res;
  throw new ProviderError(providerOf(req.service), op, { status: res.status, reason });
}
