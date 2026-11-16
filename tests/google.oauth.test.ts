import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOOGLE_ENDPOINTS,
  OAuthError,
  refreshAccessToken,
  runLoopbackLogin,
  type OAuthDeps,
} from "../src/providers/google/oauth.js";
import type { StoredToken } from "../src/providers/google/token-store.js";
import { jsonReply, startFakeOAuth, type FakeOAuth } from "./helpers/fake-oauth.js";
import { startRedirectPair } from "./helpers/redirect-server.js";

const client = { clientId: "cid.apps.googleusercontent.com", clientSecret: "SECRET-XYZ" };
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const NOW = new Date("2026-11-14T10:00:00.000Z");

let fake: FakeOAuth;
function deps(over: Partial<OAuthDeps> = {}): OAuthDeps {
  return {
    fetch,
    endpoints: { authUrl: GOOGLE_ENDPOINTS.authUrl, tokenUrl: fake.tokenUrl },
    now: () => NOW,
    ...over,
  };
}

beforeEach(async () => {
  fake = await startFakeOAuth();
});
afterEach(async () => {
  await fake.close();
});

/** Starts a login and resolves with the consent URL and the settling promise. */
function start(over: Partial<OAuthDeps> = {}, opts?: { includeGrantedScopes?: boolean }, scopes: string[] = SCOPES) {
  let urlResolve!: (u: URL) => void;
  const urlP = new Promise<URL>((r) => (urlResolve = r));
  const result = runLoopbackLogin(client, scopes, deps(over), (u) => urlResolve(new URL(u)), opts);
  // Avoid unhandled rejection warnings while the test is still driving the browser.
  result.catch(() => undefined);
  return { urlP, result };
}

function callbackBase(url: URL): string {
  return new URL(url.searchParams.get("redirect_uri")!).origin;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

function portOf(url: URL): number {
  return Number(new URL(callbackBase(url)).port);
}

describe("runLoopbackLogin", () => {
  it("returns a token with response scopes and obtained_at = now, and closes the port", async () => {
    const { urlP, result } = start();
    const url = await urlP;
    const state = url.searchParams.get("state")!;
    const res = await fetch(`${callbackBase(url)}/oauth2callback?code=CODE1&state=${state}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).not.toContain("CODE1");
    expect(page).not.toContain("ya29");
    const token = await result;
    expect(token).toEqual<StoredToken>({
      version: 1,
      client_id: client.clientId,
      scopes: SCOPES,
      refresh_token: "1//refresh",
      access_token: "ya29.access",
      expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
      obtained_at: NOW.toISOString(),
    });
    expect(await portOpen(portOf(url))).toBe(false);
  });

  it("builds the consent URL with every parameter and no client_secret", async () => {
    const { urlP, result } = start({ timeoutMs: 100 });
    const url = await urlP;
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe(GOOGLE_ENDPOINTS.authUrl);
    expect(p.get("client_id")).toBe(client.clientId);
    expect(p.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe(SCOPES.join(" "));
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    // Login never asks Google to fold earlier grants in (minimum scope): only upgrade does.
    expect(p.has("include_granted_scopes")).toBe(false);
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain("client_secret");
    expect(url.toString()).not.toContain(client.clientSecret);
    await expect(result).rejects.toBeInstanceOf(OAuthError);
  });

  it("sends include_granted_scopes=true only when asked (auth upgrade)", async () => {
    const { urlP, result } = start({ timeoutMs: 100 }, { includeGrantedScopes: true });
    expect((await urlP).searchParams.get("include_granted_scopes")).toBe("true");
    await expect(result).rejects.toBeInstanceOf(OAuthError);
  });

  it("stores only the requested scopes that were granted, never an extra scope Google reports", async () => {
    fake.respond((_req, res) =>
      jsonReply(res, 200, {
        access_token: "ya29.access",
        refresh_token: "1//refresh",
        expires_in: 3600,
        scope: `${SCOPES[0]} https://www.googleapis.com/auth/calendar.events openid`,
      }),
    );
    const { urlP, result } = start();
    const url = await urlP;
    await fetch(`${callbackBase(url)}/oauth2callback?code=CODE1&state=${url.searchParams.get("state")}`);
    expect((await result).scopes).toEqual(SCOPES);
  });

  it("exchanges the code with a verifier matching the challenge", async () => {
    const { urlP, result } = start();
    const url = await urlP;
    await fetch(`${callbackBase(url)}/oauth2callback?code=CODE1&state=${url.searchParams.get("state")}`);
    await result;
    expect(fake.requests).toHaveLength(1);
    const b = fake.requests[0]!.body;
    expect(b.get("grant_type")).toBe("authorization_code");
    expect(b.get("code")).toBe("CODE1");
    expect(b.get("client_id")).toBe(client.clientId);
    expect(b.get("client_secret")).toBe(client.clientSecret);
    expect(b.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
    const verifier = b.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
  });

  it("rejects a wrong state, exchanges nothing and closes the port", async () => {
    const { urlP, result } = start();
    const url = await urlP;
    const res = await fetch(`${callbackBase(url)}/oauth2callback?code=CODE1&state=nope`);
    expect(res.status).toBe(400);
    await expect(result).rejects.toBeInstanceOf(OAuthError);
    expect(fake.requests).toHaveLength(0);
    expect(await portOpen(portOf(url))).toBe(false);
  });

  it("maps access_denied to a fixed sentence", async () => {
    const { urlP, result } = start();
    const url = await urlP;
    await fetch(`${callbackBase(url)}/oauth2callback?error=access_denied&state=${url.searchParams.get("state")}`);
    await expect(result).rejects.toThrow("Google sign-in was cancelled or denied.");
    expect(fake.requests).toHaveLength(0);
    expect(await portOpen(portOf(url))).toBe(false);
  });

  it("times out, rejects and closes the port", async () => {
    const { urlP, result } = start({ timeoutMs: 100 });
    const url = await urlP;
    await expect(result).rejects.toBeInstanceOf(OAuthError);
    expect(await portOpen(portOf(url))).toBe(false);
  });

  it("answers 400 to a second callback while the exchange is running", async () => {
    fake.respond((_req, res) => {
      setTimeout(
        () => jsonReply(res, 200, { access_token: "a", refresh_token: "r", expires_in: 60, scope: SCOPES.join(" ") }),
        200,
      );
    });
    const { urlP, result } = start();
    const url = await urlP;
    const cb = `${callbackBase(url)}/oauth2callback?code=CODE1&state=${url.searchParams.get("state")}`;
    const first = fetch(cb);
    await new Promise((r) => setTimeout(r, 50));
    const second = await fetch(cb);
    expect(second.status).toBe(400);
    await first;
    await result;
    expect(fake.requests).toHaveLength(1);
  });

  it("answers 404 on other paths without ending the flow", async () => {
    const { urlP, result } = start();
    const url = await urlP;
    const other = await fetch(`${callbackBase(url)}/favicon.ico`);
    expect(other.status).toBe(404);
    const wrongPathWithState = await fetch(`${callbackBase(url)}/other?code=X&state=${url.searchParams.get("state")}`);
    expect(wrongPathWithState.status).toBe(404);
    await fetch(`${callbackBase(url)}/oauth2callback?code=CODE1&state=${url.searchParams.get("state")}`);
    await expect(result).resolves.toMatchObject({ refresh_token: "1//refresh" });
  });

  it("tells the user what to do when no refresh_token comes back", async () => {
    fake.respond((_req, res) => jsonReply(res, 200, { access_token: "a", expires_in: 60, scope: SCOPES.join(" ") }));
    const { urlP, result } = start();
    const url = await urlP;
    await fetch(`${callbackBase(url)}/oauth2callback?code=C&state=${url.searchParams.get("state")}`);
    await expect(result).rejects.toThrow(/remove .*access.*Google account.*deskhand auth login/i);
    expect(await portOpen(portOf(url))).toBe(false);
  });

  it("never puts a token endpoint body in the thrown message", async () => {
    fake.respond((_req, res) => jsonReply(res, 400, { error: "weird", error_description: "ya29.SECRET" }));
    const { urlP, result } = start();
    const url = await urlP;
    await fetch(`${callbackBase(url)}/oauth2callback?code=C&state=${url.searchParams.get("state")}`);
    const err = await result.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as Error).message).toBe("Google sign-in failed: the token endpoint returned HTTP 400.");
    expect((err as Error).message).not.toContain("ya29.SECRET");
    expect(await portOpen(portOf(url))).toBe(false);
  });
});

describe("runLoopbackLogin fail-closed paths", () => {
  async function loginWith(body: Record<string, unknown>) {
    fake.respond((_req, res) => jsonReply(res, 200, body));
    const { urlP, result } = start();
    const url = await urlP;
    await fetch(`${callbackBase(url)}/oauth2callback?code=C&state=${url.searchParams.get("state")}`);
    return { url, err: await result.catch((e: unknown) => e) };
  }

  it("fails when the token response has no scope", async () => {
    const { url, err } = await loginWith({ access_token: "a", refresh_token: "r", expires_in: 60 });
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as Error).message).toBe("Google did not report which permissions were granted. Run the sign-in again.");
    expect(await portOpen(portOf(url))).toBe(false);
  });

  it("fails on a partial grant", async () => {
    const { err } = await loginWith({ access_token: "a", refresh_token: "r", expires_in: 60, scope: "openid" });
    expect((err as Error).message).toBe(
      "Google sign-in did not grant every requested permission. Run the sign-in again and allow all requested access.",
    );
  });

  it("closes the listener and rejects when onUrl throws", async () => {
    let port = 0;
    const result = runLoopbackLogin(client, SCOPES, deps(), (u) => {
      port = Number(new URL(new URL(u).searchParams.get("redirect_uri")!).port);
      throw new Error("boom");
    });
    await expect(result).rejects.toBeInstanceOf(OAuthError);
    expect(await portOpen(port)).toBe(false);
  });

  it("survives a malformed request target", async () => {
    const { urlP, result } = start();
    const url = await urlP;
    const reply = await new Promise<string>((resolve) => {
      const s = createConnection({ port: portOf(url), host: "127.0.0.1" });
      let data = "";
      s.on("data", (d) => (data += d));
      s.on("close", () => resolve(data));
      s.on("error", () => resolve(data));
      s.write("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    await fetch(`${callbackBase(url)}/oauth2callback?code=C&state=${url.searchParams.get("state")}`);
    await expect(result).resolves.toMatchObject({ refresh_token: "1//refresh" });
  });

  it("uses fixed sentences for a network failure and a timeout", async () => {
    const failing = (() => Promise.reject(new Error("ya29.SECRET"))) as unknown as typeof fetch;
    const { urlP, result } = start({ fetch: failing });
    const url = await urlP;
    await fetch(`${callbackBase(url)}/oauth2callback?code=C&state=${url.searchParams.get("state")}`);
    await expect(result).rejects.toThrow("Google sign-in failed: could not reach the token endpoint.");
    const t = start({ timeoutMs: 50 });
    await t.urlP;
    await expect(t.result).rejects.toThrow("Google sign-in timed out waiting for the browser. Run: deskhand auth login");
  });
});

describe("refreshAccessToken", () => {
  const stored: StoredToken = {
    version: 1,
    client_id: client.clientId,
    scopes: SCOPES,
    refresh_token: "1//refresh",
    access_token: "old",
    expires_at: "2026-11-14T09:00:00.000Z",
    obtained_at: "2026-11-10T09:00:00.000Z",
  };

  it("updates access_token and expires_at, keeps refresh_token and obtained_at", async () => {
    fake.respond((_req, res) =>
      jsonReply(res, 200, { access_token: "new", expires_in: 1800, scope: SCOPES.join(" "), token_type: "Bearer" }),
    );
    const out = await refreshAccessToken(client, stored, deps());
    expect(out).toEqual({ ...stored, access_token: "new", expires_at: new Date(NOW.getTime() + 1800_000).toISOString() });
    const b = fake.requests[0]!.body;
    expect(b.get("grant_type")).toBe("refresh_token");
    expect(b.get("refresh_token")).toBe("1//refresh");
    expect(b.get("client_id")).toBe(client.clientId);
    expect(b.get("client_secret")).toBe(client.clientSecret);
  });

  it("keeps a rotated refresh_token when the response has one", async () => {
    fake.respond((_req, res) => jsonReply(res, 200, { access_token: "new", refresh_token: "1//rotated", expires_in: 60 }));
    const out = await refreshAccessToken(client, stored, deps());
    expect(out.refresh_token).toBe("1//rotated");
  });

  it("maps invalid_grant to the fixed sentence", async () => {
    fake.respond((_req, res) => jsonReply(res, 400, { error: "invalid_grant", error_description: "ya29.SECRET" }));
    const err = await refreshAccessToken(client, stored, deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as Error).message).toBe("The Google sign-in has expired or was revoked. Run: deskhand auth login");
  });

  it("uses a fixed sentence for other failures", async () => {
    fake.respond((_req, res) => jsonReply(res, 500, { error: "boom ya29.SECRET" }));
    const err = await refreshAccessToken(client, stored, deps()).catch((e: unknown) => e);
    expect((err as Error).message).toBe("Google sign-in failed: the token endpoint returned HTTP 500.");
  });
});

describe("token endpoint redirects (red-team round 18)", () => {
  const stored: StoredToken = {
    version: 1,
    client_id: client.clientId,
    scopes: SCOPES,
    refresh_token: "1//refresh",
    access_token: "old",
    expires_at: "2026-11-14T09:00:00.000Z",
    obtained_at: "2026-11-10T09:00:00.000Z",
  };

  for (const status of [307, 308] as const) {
    it(`a refresh answered with ${status} is refused and the refresh token and client secret go nowhere else`, async () => {
      const pair = await startRedirectPair(status);
      try {
        const over = { endpoints: { authUrl: GOOGLE_ENDPOINTS.authUrl, tokenUrl: pair.redirectUrl } };
        const err = await refreshAccessToken(client, stored, deps(over)).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(OAuthError);
        expect((err as OAuthError).code).toBe("PROVIDER_ERROR");
        expect(pair.landed).toHaveLength(0);
      } finally {
        await pair.close();
      }
    });
  }

  it("a code exchange answered with 307 fails the login and the code, verifier and secret go nowhere else", async () => {
    const pair = await startRedirectPair(307);
    try {
      const { urlP, result } = start({ endpoints: { authUrl: GOOGLE_ENDPOINTS.authUrl, tokenUrl: pair.redirectUrl } });
      const url = await urlP;
      await fetch(`${callbackBase(url)}/oauth2callback?code=CODE1&state=${url.searchParams.get("state")}`);
      const err = await result.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe("PROVIDER_ERROR");
      expect(pair.landed).toHaveLength(0);
    } finally {
      await pair.close();
    }
  });
});
