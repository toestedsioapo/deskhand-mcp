import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE } from "../src/config/scopes.js";
import { AuthRequiredError, ProviderError } from "../src/providers/errors.js";
import { googleRequest, type GoogleHttpDeps } from "../src/providers/google/http.js";
import { GOOGLE_ENDPOINTS } from "../src/providers/google/oauth.js";
import { readToken, tokenPath, writeToken, type StoredToken } from "../src/providers/google/token-store.js";
import { startRedirectPair } from "./helpers/redirect-server.js";
import { replayFetch, type Replay } from "./helpers/replay-fetch.js";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const LIST_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
  new URLSearchParams({
    timeMin: "2026-11-12T00:00:00.000Z",
    timeMax: "2026-11-14T00:00:00.000Z",
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    fields: "items(id,etag,status,summary,start,end,attendees(email,self),organizer(self),recurrence,recurringEventId),nextPageToken",
  }).toString();
const LOGIN = "Not signed in to Google. Run: deskhand auth login";
const UPGRADE = "Google write access is not granted. Run: deskhand auth upgrade";
const EXPIRED = "The Google sign-in has expired or was revoked. Run: deskhand auth login";
const CLIENT_FILE = "The Google OAuth client file is missing or unreadable. See docs/google-oauth-setup.md";

function token(over: Partial<StoredToken> = {}): StoredToken {
  return {
    version: 1,
    client_id: "cid.apps.googleusercontent.com",
    scopes: [SCOPE_CALENDAR_READ],
    refresh_token: "1//REFRESH-SECRET",
    access_token: "ya29.OLD-ACCESS-TOKEN",
    expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    obtained_at: "2026-11-10T10:00:00.000Z",
    ...over,
  };
}
const expired = (): Partial<StoredToken> => ({ expires_at: new Date(NOW.getTime() - 60_000).toISOString() });

let dir: string;
let replay: Replay | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskhand-http-"));
  writeFileSync(
    join(dir, "client_secret.json"),
    JSON.stringify({ installed: { client_id: "cid.apps.googleusercontent.com", client_secret: "CLIENT-SECRET-XYZ" } }),
  );
});
afterEach(() => {
  try {
    replay?.verify();
  } finally {
    replay = undefined;
    rmSync(dir, { recursive: true, force: true });
  }
});

function deps(f: typeof fetch, over: Partial<GoogleHttpDeps> = {}): GoogleHttpDeps {
  return {
    fetch: f,
    configDir: dir,
    now: () => NOW,
    oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW },
    ...over,
  };
}
function use(names: string[], over: Partial<GoogleHttpDeps> = {}): GoogleHttpDeps {
  replay = replayFetch(names);
  return deps(replay.fetch, over);
}
const never: typeof fetch = (() => {
  throw new Error("fetch must not be called");
}) as typeof fetch;
const getList = (d: GoogleHttpDeps, scope = SCOPE_CALENDAR_READ) =>
  googleRequest(d, "events.list", { method: "GET", url: LIST_URL, requiredScope: scope });
const reject = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};

describe("googleRequest sign-in state", () => {
  it("no token.json is AuthRequiredError (not signed in) and no request is made", async () => {
    const e = await reject(getList(deps(never)));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(LOGIN);
  });

  it("a malformed token.json is the same sentence and its content is not echoed", async () => {
    writeFileSync(tokenPath(dir), "{ not json SECRET-CONTENT");
    const e = await reject(getList(deps(never)));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(LOGIN);
    expect(e.message).not.toContain("SECRET-CONTENT");
  });

  it("a token lacking the required scope is the upgrade sentence before any request", async () => {
    writeToken(dir, token());
    const e = await reject(getList(deps(never), SCOPE_CALENDAR_WRITE));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(UPGRADE);
  });

  it("the request carries Authorization: Bearer <access token>", async () => {
    writeToken(dir, token());
    const d = use(["events-list-page"]);
    const r = await getList(d);
    expect(r.status).toBe(200);
    expect(replay!.seen[0]!.headers["authorization"]).toBe("Bearer ya29.OLD-ACCESS-TOKEN");
  });
});

describe("googleRequest refresh", () => {
  it("refreshes an access token within 60 s of expiry first, writes it and keeps the refresh token", async () => {
    writeToken(dir, token({ expires_at: new Date(NOW.getTime() + 59_000).toISOString() }));
    const d = use(["oauth-refresh", "events-list-page"]);
    await getList(d);
    expect(replay!.seen[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(replay!.seen[1]!.headers["authorization"]).toBe("Bearer ya29.NEW-ACCESS-TOKEN");
    const stored = readToken(dir)!;
    expect(stored.access_token).toBe("ya29.NEW-ACCESS-TOKEN");
    expect(stored.refresh_token).toBe("1//REFRESH-SECRET");
    expect(stored.scopes).toEqual([SCOPE_CALENDAR_READ]);
  });

  it("does not refresh a token that is more than 60 s from expiry", async () => {
    writeToken(dir, token({ expires_at: new Date(NOW.getTime() + 61_000).toISOString() }));
    await getList(use(["events-list-page"]));
    expect(replay!.seen).toHaveLength(1);
  });

  it("invalid_grant is AuthRequiredError (expired) and token.json is left unchanged", async () => {
    writeToken(dir, token(expired()));
    const before = readFileSync(tokenPath(dir), "utf8");
    const e = await reject(getList(use(["oauth-invalid-grant"])));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(EXPIRED);
    expect(readFileSync(tokenPath(dir), "utf8")).toBe(before);
  });

  it("a refresh network failure is ProviderError 'token refresh failed' with no inner text", async () => {
    writeToken(dir, token(expired()));
    const boom: typeof fetch = (() => Promise.reject(new Error("socket hang up 1//REFRESH-SECRET"))) as typeof fetch;
    const e = await reject(getList(deps(boom)));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar events.list failed: token refresh failed");
    // Nothing reached the API: a retry is safe.
    expect((e as ProviderError).retryable).toBe(true);
  });

  it("a missing OAuth client file on refresh is AuthRequiredError naming the client file, not 'not signed in'", async () => {
    writeToken(dir, token(expired()));
    rmSync(join(dir, "client_secret.json"));
    const e = await reject(getList(deps(never)));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(CLIENT_FILE);
  });

  it("an unreadable (malformed) OAuth client file on refresh is the same sentence, without its content", async () => {
    writeToken(dir, token(expired()));
    writeFileSync(join(dir, "client_secret.json"), "{ GOCSPX-LEAK");
    const e = await reject(getList(deps(never)));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(CLIENT_FILE);
  });

  it("a refresh does not overwrite a token written concurrently by auth upgrade/login; the on-disk token is used", async () => {
    writeToken(dir, token({ expires_at: new Date(NOW.getTime() + 30_000).toISOString() }));
    const upgraded = token({
      scopes: [SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE],
      refresh_token: "1//NEW-UPGRADED-REFRESH",
      access_token: "ya29.UPGRADED-ACCESS",
      expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
      obtained_at: NOW.toISOString(),
    });
    replay = replayFetch(["oauth-refresh", "events-list-page"]);
    const served = replay.fetch;
    const f = ((input: string | URL | Request, init?: RequestInit) => {
      // Another process (deskhand auth upgrade) saves its token while our refresh is in flight.
      if (String(input).startsWith("https://oauth2.googleapis.com/")) writeToken(dir, upgraded);
      return served(input, init);
    }) as typeof fetch;
    await getList(deps(f));
    expect(readToken(dir)).toEqual(upgraded);
    expect(replay.seen[1]!.headers["authorization"]).toBe("Bearer ya29.UPGRADED-ACCESS");
  });

  it("two concurrent requests with an expired access token both succeed on one refresh", async () => {
    writeToken(dir, token(expired()));
    const d = use(["oauth-refresh", "events-list-page", "events-list-page"]);
    const [a, b] = await Promise.all([getList(d), getList(d)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(replay!.seen.filter((s) => s.url.startsWith("https://oauth2.googleapis.com/"))).toHaveLength(1);
  });
});

describe("googleRequest status handling", () => {
  it("a 401 triggers one refresh and one retry with the new token", async () => {
    writeToken(dir, token());
    const d = use(["events-list-401", "oauth-refresh", "events-list-page"]);
    const r = await getList(d);
    expect(r.status).toBe(200);
    expect(replay!.seen.map((s) => s.headers["authorization"])).toEqual([
      "Bearer ya29.OLD-ACCESS-TOKEN",
      undefined,
      "Bearer ya29.NEW-ACCESS-TOKEN",
    ]);
  });

  it("a second 401 is AuthRequiredError (expired)", async () => {
    writeToken(dir, token());
    const e = await reject(getList(use(["events-list-401", "oauth-refresh", "events-list-401"])));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(EXPIRED);
  });

  it("403 insufficientPermissions on a write request is the upgrade AuthRequiredError", async () => {
    writeToken(dir, token({ scopes: [SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE] }));
    const e = await reject(getList(use(["events-list-403-insufficient"]), SCOPE_CALENDAR_WRITE));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(UPGRADE);
  });

  it("404 and 409 are returned to the caller", async () => {
    writeToken(dir, token());
    const stub = (status: number): typeof fetch =>
      (() => Promise.resolve(new Response(JSON.stringify({ error: { code: status } }), { status }))) as typeof fetch;
    expect((await getList(deps(stub(404)))).status).toBe(404);
    expect((await getList(deps(stub(409)))).status).toBe(409);
  });

  it("429 is ProviderError with the status and validated reason", async () => {
    writeToken(dir, token());
    const e = await reject(getList(use(["events-list-429"])));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar events.list failed: HTTP 429 rateLimitExceeded");
    expect((e as ProviderError).retryable).toBe(true);
  });

  it("500 is ProviderError and neither the body text nor any token appears in the message", async () => {
    writeToken(dir, token());
    const e = await reject(getList(use(["events-list-500"])));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar events.list failed: HTTP 500 backendError");
    for (const secret of ["ya29.FAKE-TOKEN-IN-BODY", "Backend Error", "ya29.OLD-ACCESS-TOKEN", "Bearer", "REFRESH-SECRET"]) {
      expect(e.message).not.toContain(secret);
    }
  });

  it("an invalid reason in the body is dropped", async () => {
    writeToken(dir, token());
    const f = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { errors: [{ reason: "ya29.FAKE <b>x</b>" }] } }), { status: 503 }),
      )) as typeof fetch;
    const e = await reject(getList(deps(f)));
    expect(e.message).toBe("google calendar events.list failed: HTTP 503");
  });
});

describe("googleRequest transport", () => {
  it("a timeout is ProviderError 'timed out'", async () => {
    writeToken(dir, token());
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_, rej) => {
        init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason));
      })) as typeof fetch;
    const e = await reject(getList(deps(hang, { timeoutMs: 20 })));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar events.list failed: timed out");
    expect((e as ProviderError).retryable).toBe(true);
  });

  it("a network error is ProviderError 'network error' without the inner text", async () => {
    writeToken(dir, token());
    const boom = (() => Promise.reject(new Error("ECONNRESET ya29.OLD-ACCESS-TOKEN"))) as typeof fetch;
    const e = await reject(getList(deps(boom)));
    expect(e.message).toBe("google calendar events.list failed: network error");
    expect((e as ProviderError).retryable).toBe(true);
  });

  it("a host other than www.googleapis.com is refused before any request", async () => {
    writeToken(dir, token());
    for (const url of ["https://evil.example.com/x", "http://www.googleapis.com/x", "https://www.googleapis.com.evil.example/x"]) {
      const e = await reject(googleRequest(deps(never), "events.list", { method: "GET", url, requiredScope: SCOPE_CALENDAR_READ }));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).toContain("unexpected host");
      expect((e as ProviderError).retryable).toBe(false);
    }
  });

  it("with the global fetch the no-network guard answers (a network error to the caller)", async () => {
    writeToken(dir, token());
    expect(() => fetch("https://www.googleapis.com/calendar/v3/x")).toThrow("network access is forbidden in tests");
    const viaGlobal = ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)) as typeof fetch;
    const e = await reject(getList(deps(viaGlobal)));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar events.list failed: network error");
  });

  it("the guard still lets loopback through", async () => {
    const e = await reject(fetch("http://127.0.0.1:1/"));
    expect(e.message).not.toContain("forbidden in tests");
  });
});

describe("googleRequest fixes", () => {
  it("a hung token endpoint times out as ProviderError 'timed out' and the next request can retry", async () => {
    writeToken(dir, token(expired()));
    const hang = (() => new Promise(() => undefined)) as typeof fetch;
    const e = await reject(getList(deps(hang, { timeoutMs: 20 })));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar events.list failed: timed out");
    // The in-flight entry was cleared: a later request refreshes normally.
    const d = use(["oauth-refresh", "events-list-page"]);
    expect((await getList(d)).status).toBe(200);
  });

  it("a URL with a port or userinfo is refused before any request", async () => {
    writeToken(dir, token());
    for (const url of ["https://www.googleapis.com:8443/x", "https://user:pw@www.googleapis.com/x", "https://user@www.googleapis.com/x"]) {
      const e = await reject(googleRequest(deps(never), "events.list", { method: "GET", url, requiredScope: SCOPE_CALENDAR_READ }));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).toContain("unexpected host");
    }
  });

  it("a token lacking the READ scope is the login sentence, not the upgrade sentence", async () => {
    writeToken(dir, token({ scopes: [SCOPE_CALENDAR_WRITE] }));
    const e = await reject(getList(deps(never), SCOPE_CALENDAR_READ));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(LOGIN);
  });

  it("403 insufficientPermissions on a read request is the login sentence", async () => {
    writeToken(dir, token());
    const e = await reject(getList(use(["events-list-403-insufficient"]), SCOPE_CALENDAR_READ));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(LOGIN);
  });
});

describe("googleRequest redirects (red-team round 18)", () => {
  /** Sends what googleRequest asks for to `target` instead, with the caller's init unchanged (redirect mode included). */
  const via = (target: string): typeof fetch => ((_u: unknown, init?: RequestInit) => fetch(target, init)) as typeof fetch;

  for (const status of [302, 307, 308] as const) {
    it(`an API answer of ${status} is not followed: the bearer token and the body reach no other server`, async () => {
      writeToken(dir, token());
      const pair = await startRedirectPair(status);
      try {
        const e = await reject(
          googleRequest(deps(via(pair.redirectUrl)), "events.insert", {
            method: "POST",
            url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            body: { summary: "x" },
            requiredScope: SCOPE_CALENDAR_READ,
          }),
        );
        expect(e).toBeInstanceOf(ProviderError);
        expect(pair.landed).toHaveLength(0);
      } finally {
        await pair.close();
      }
    });
  }

  it("a token refresh answered with 307 is 'token refresh failed' and token.json is unchanged", async () => {
    writeToken(dir, token(expired()));
    const before = readFileSync(tokenPath(dir), "utf8");
    const pair = await startRedirectPair(307);
    try {
      const d = deps(never, {
        oauth: { fetch, endpoints: { authUrl: GOOGLE_ENDPOINTS.authUrl, tokenUrl: pair.redirectUrl }, now: () => NOW },
      });
      const e = await reject(getList(d));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).toBe("google calendar events.list failed: token refresh failed");
      expect(pair.landed).toHaveLength(0);
      expect(readFileSync(tokenPath(dir), "utf8")).toBe(before);
    } finally {
      await pair.close();
    }
  });
});
