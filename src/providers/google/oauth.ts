import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthClient } from "./client-file.js";
import type { StoredToken } from "./token-store.js";

export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
}

export const GOOGLE_ENDPOINTS: OAuthEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
};

export interface OAuthDeps {
  fetch: typeof fetch;
  endpoints: OAuthEndpoints;
  now: () => Date;
  /** How long to wait for the browser callback. Default 300000 (5 minutes). */
  timeoutMs?: number;
}

/** The message is always one of our fixed sentences, never Google's response. */
export class OAuthError extends Error {
  /** AUTH_REQUIRED: the user must sign in again. PROVIDER_ERROR: Google or the network failed. */
  readonly code: "AUTH_REQUIRED" | "PROVIDER_ERROR";
  constructor(message: string, code: "AUTH_REQUIRED" | "PROVIDER_ERROR" = "AUTH_REQUIRED") {
    super(message);
    this.name = "OAuthError";
    this.code = code;
  }
}

const CALLBACK_PATH = "/oauth2callback";
const EXPIRED_MESSAGE = "The Google sign-in has expired or was revoked. Run: deskhand auth login";

interface TokenResponse {
  error?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/** POSTs to the token endpoint, never following a redirect. Returns the parsed body only on HTTP 2xx; otherwise throws a fixed sentence. */
async function postToken(deps: OAuthDeps, params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await deps.fetch(deps.endpoints.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      // The body holds the client secret and a code or refresh token: a 307/308 would resend it to another host.
      redirect: "error",
    });
  } catch {
    throw new OAuthError("Google sign-in failed: could not reach the token endpoint.", "PROVIDER_ERROR");
  }
  let body: TokenResponse = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed !== null && typeof parsed === "object") body = parsed as TokenResponse;
  } catch {
    // Non-JSON body: fall through to the status-based sentence.
  }
  if (!res.ok) {
    if (body.error === "invalid_grant") throw new OAuthError(EXPIRED_MESSAGE);
    throw new OAuthError(`Google sign-in failed: the token endpoint returned HTTP ${res.status}.`, "PROVIDER_ERROR");
  }
  return body;
}

function expiresAt(body: TokenResponse, now: Date): string {
  const secs = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return new Date(now.getTime() + secs * 1000).toISOString();
}

function plainPage(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  res.end(text);
}

export interface LoginOptions {
  /**
   * Sends `include_granted_scopes=true`, so Google folds earlier grants into the new token. Only `deskhand auth
   * upgrade` sets it; `login` never does (minimum scope: a plain login must not bring back an earlier write grant).
   */
  includeGrantedScopes?: boolean;
}

/**
 * Loopback sign-in for `scopes`. The stored token lists only the requested scopes that Google granted (every
 * requested one must be), never an extra scope Google reports from an earlier grant.
 */
export function runLoopbackLogin(
  client: OAuthClient,
  scopes: string[],
  deps: OAuthDeps,
  onUrl: (url: string) => void,
  opts: LoginOptions = {},
): Promise<StoredToken> {
  return new Promise<StoredToken>((resolve, reject) => {
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let redirectUri = "";
    let handled = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const server: Server = createServer((req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        plainPage(res, 400, "Bad request.");
        return;
      }
      if (url.pathname !== CALLBACK_PATH) {
        plainPage(res, 404, "Not found.");
        return;
      }
      if (handled) {
        plainPage(res, 400, "This sign-in link was already used.");
        return;
      }
      handled = true;
      if (url.searchParams.get("state") !== state) {
        plainPage(res, 400, "Sign-in failed: the response did not match this login attempt. You can close this tab.");
        finish(new OAuthError("Google sign-in failed: the browser response did not match this login attempt."));
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error !== null || code === null || code === "") {
        plainPage(res, 200, "Sign-in was not completed. You can close this tab and return to the terminal.");
        finish(
          new OAuthError(
            error === "access_denied"
              ? "Google sign-in was cancelled or denied."
              : "Google sign-in failed: Google returned no sign-in code.",
          ),
        );
        return;
      }
      plainPage(res, 200, "Return to the terminal to finish signing in. You can close this tab.");
      exchange(code).then(
        (token) => finish(token),
        (err: unknown) =>
          finish(err instanceof OAuthError ? err : new OAuthError("Google sign-in failed: the code exchange did not complete.", "PROVIDER_ERROR")),
      );
    });

    function finish(result: StoredToken | OAuthError): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      // Drop keep-alive sockets so the port is released promptly (the success page has already been written).
      setImmediate(() => server.closeAllConnections());
      if (result instanceof OAuthError) reject(result);
      else resolve(result);
    }

    async function exchange(code: string): Promise<StoredToken> {
      const body = await postToken(deps, {
        grant_type: "authorization_code",
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      if (typeof body.access_token !== "string" || body.access_token === "") {
        throw new OAuthError("Google sign-in failed: the token response had no access token.", "PROVIDER_ERROR");
      }
      if (typeof body.refresh_token !== "string" || body.refresh_token === "") {
        throw new OAuthError(
          "Google did not return a refresh token. Remove Deskhand's access in your Google account (myaccount.google.com/permissions), then run: deskhand auth login",
        );
      }
      if (typeof body.scope !== "string") {
        throw new OAuthError("Google did not report which permissions were granted. Run the sign-in again.");
      }
      const granted = body.scope.split(" ").filter((s) => s !== "");
      if (!scopes.every((s) => granted.includes(s))) {
        throw new OAuthError(
          "Google sign-in did not grant every requested permission. Run the sign-in again and allow all requested access.",
        );
      }
      const now = deps.now();
      return {
        version: 1,
        client_id: client.clientId,
        scopes: scopes.filter((s) => granted.includes(s)),
        refresh_token: body.refresh_token,
        access_token: body.access_token,
        expires_at: expiresAt(body, now),
        obtained_at: now.toISOString(),
      };
    }

    server.once("error", () => finish(new OAuthError("Google sign-in failed: could not start the local callback listener.", "PROVIDER_ERROR")));
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
      timer = setTimeout(
        () => finish(new OAuthError("Google sign-in timed out waiting for the browser. Run: deskhand auth login")),
        deps.timeoutMs ?? 300_000,
      );
      const auth = new URL(deps.endpoints.authUrl);
      auth.searchParams.set("client_id", client.clientId);
      auth.searchParams.set("redirect_uri", redirectUri);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", scopes.join(" "));
      auth.searchParams.set("access_type", "offline");
      auth.searchParams.set("prompt", "consent");
      if (opts.includeGrantedScopes === true) auth.searchParams.set("include_granted_scopes", "true");
      auth.searchParams.set("state", state);
      auth.searchParams.set("code_challenge", challenge);
      auth.searchParams.set("code_challenge_method", "S256");
      try {
        onUrl(auth.toString());
      } catch {
        finish(new OAuthError("Google sign-in failed: could not show the sign-in link.", "PROVIDER_ERROR"));
      }
    });
  });
}

export async function refreshAccessToken(client: OAuthClient, token: StoredToken, deps: OAuthDeps): Promise<StoredToken> {
  const body = await postToken(deps, {
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new OAuthError("Google sign-in failed: the token response had no access token.", "PROVIDER_ERROR");
  }
  const refreshed = typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : token.refresh_token;
  return { ...token, refresh_token: refreshed, access_token: body.access_token, expires_at: expiresAt(body, deps.now()) };
}
