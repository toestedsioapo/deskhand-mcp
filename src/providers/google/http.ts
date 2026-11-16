import { SCOPE_CALENDAR_WRITE } from "../../config/scopes.js";
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

const PROVIDER = "google calendar";
const API_HOST = "www.googleapis.com";
const REFRESH_MARGIN_MS = 60_000;
const NOT_SIGNED_IN = "Not signed in to Google. Run: deskhand auth login";
const NO_WRITE = "Google write access is not granted. Run: deskhand auth upgrade";
const EXPIRED = "The Google sign-in has expired or was revoked. Run: deskhand auth login";
const NO_CLIENT_FILE = "The Google OAuth client file is missing or unreadable. See docs/google-oauth-setup.md";

/** Only a missing write scope is fixed by `auth upgrade`; a missing read scope means signing in again. */
const missingScopeMessage = (scope: string): string => (scope === SCOPE_CALENDAR_WRITE ? NO_WRITE : NOT_SIGNED_IN);

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

function refresh(deps: GoogleHttpDeps, op: string, staleAccessToken: string): Promise<StoredToken> {
  let p = inflight.get(deps.configDir);
  if (p === undefined) {
    p = doRefresh(deps, op, staleAccessToken).finally(() => inflight.delete(deps.configDir));
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

async function doRefresh(deps: GoogleHttpDeps, op: string, staleAccessToken: string): Promise<StoredToken> {
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
    if (e instanceof TimedOut) throw new ProviderError(PROVIDER, op, { phrase: "timed out", retryable: true });
    if (e instanceof OAuthError && e.code === "AUTH_REQUIRED") throw new AuthRequiredError(EXPIRED);
    throw new ProviderError(PROVIDER, op, { phrase: "token refresh failed", retryable: true });
  }
  // Re-read before writing: a `deskhand auth login` or `upgrade` in another process may have saved a new sign-in
  // while we waited for Google. That token is newer than ours: keep the file as it is and use it.
  const onDisk = loadToken(deps.configDir);
  if (onDisk.refresh_token !== current.refresh_token || onDisk.obtained_at !== current.obtained_at) return onDisk;
  try {
    writeToken(deps.configDir, next);
  } catch {
    throw new ProviderError(PROVIDER, op, { phrase: "could not save token", retryable: true });
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
    throw new ProviderError(PROVIDER, op, { phrase: timedOut ? "timed out" : "network error", retryable: true });
  }
}

/**
 * One authenticated Google API call. Returns 2xx, 404 and 409 to the caller;
 * every other outcome is an AuthRequiredError or a ProviderError whose text
 * never holds a token, header or response body. A ProviderError is `retryable`
 * for a timeout, a network error, HTTP 429 and 5xx (outcome unknown or
 * transient), and definite for every other status. A redirect is never
 * followed (a network error to the caller).
 */
export async function googleRequest(
  deps: GoogleHttpDeps,
  op: string,
  req: { method: "GET" | "POST"; url: string; body?: unknown; requiredScope: string },
): Promise<GoogleResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new ProviderError(PROVIDER, op, { phrase: "invalid request URL" });
  }
  if (url.protocol !== "https:" || url.hostname !== API_HOST || url.port !== "" || url.username !== "" || url.password !== "") {
    throw new ProviderError(PROVIDER, op, { phrase: "refused request to an unexpected host" });
  }

  let token = loadToken(deps.configDir);
  if (!token.scopes.includes(req.requiredScope)) throw new AuthRequiredError(missingScopeMessage(req.requiredScope));
  if (nearExpiry(token, deps.now())) token = await refresh(deps, op, token.access_token);

  let res = await send(deps, op, req, token.access_token);
  if (res.status === 401) {
    token = await refresh(deps, op, token.access_token);
    res = await send(deps, op, req, token.access_token);
    if (res.status === 401) throw new AuthRequiredError(EXPIRED);
  }
  const reason = reasonOf(res.json);
  if (res.status === 403 && reason === "insufficientPermissions") throw new AuthRequiredError(missingScopeMessage(req.requiredScope));
  if ((res.status >= 200 && res.status < 300) || res.status === 404 || res.status === 409) return res;
  throw new ProviderError(PROVIDER, op, { status: res.status, reason });
}
