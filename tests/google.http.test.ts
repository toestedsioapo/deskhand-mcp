import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE, SCOPE_GMAIL_COMPOSE, SCOPE_GMAIL_READ } from "../src/config/scopes.js";
import { scrubSecrets } from "../src/ledger/redact.js";
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
  googleRequest(d, "events.list", { service: "calendar", method: "GET", url: LIST_URL, requiredScope: scope });
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
      const e = await reject(googleRequest(deps(never), "events.list", { service: "calendar", method: "GET", url, requiredScope: SCOPE_CALENDAR_READ }));
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
      const e = await reject(googleRequest(deps(never), "events.list", { service: "calendar", method: "GET", url, requiredScope: SCOPE_CALENDAR_READ }));
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

describe("googleRequest singleSend (a write with no unique key, M4b decision 8)", () => {
  const TOKEN_HOST = "https://oauth2.googleapis.com/";
  const getOnce = (d: GoogleHttpDeps, singleSend?: boolean) =>
    googleRequest(d, "drafts.create", {
      service: "calendar",
      method: "GET",
      url: LIST_URL,
      requiredScope: SCOPE_CALENDAR_READ,
      ...(singleSend === undefined ? {} : { singleSend }),
    });
  const apiSends = () => replay!.seen.filter((s) => !s.url.startsWith(TOKEN_HOST));
  const refreshes = () => replay!.seen.filter((s) => s.url.startsWith(TOKEN_HOST));

  it("a 401 makes one API send and one refresh, saves the token and throws the retryable fixed error", async () => {
    writeToken(dir, token());
    const e = await reject(getOnce(use(["events-list-401", "oauth-refresh"]), true));
    expect(apiSends()).toHaveLength(1);
    expect(refreshes()).toHaveLength(1);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).retryable).toBe(true);
    expect(e.message).toBe("google calendar drafts.create failed: access token refreshed; retry");
    // apply stores this text through scrubSecrets, so the fixed phrase must survive it.
    expect(scrubSecrets(e.message)).toBe(e.message);
    for (const secret of ["ya29.", "1//", "Bearer", "CLIENT-SECRET"]) expect(e.message).not.toContain(secret);
    expect(readToken(dir)!.access_token).toBe("ya29.NEW-ACCESS-TOKEN");
  });

  it("a refresh that needs a new sign-in propagates unchanged, after one API send", async () => {
    writeToken(dir, token());
    const e = await reject(getOnce(use(["events-list-401", "oauth-invalid-grant"]), true));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(EXPIRED);
    expect(apiSends()).toHaveLength(1);
  });

  it("a refresh that fails on the network propagates unchanged, after one API send", async () => {
    writeToken(dir, token());
    let sends = 0;
    const f = ((input: string | URL | Request) => {
      if (String(input).startsWith(TOKEN_HOST)) return Promise.reject(new Error("socket hang up"));
      sends += 1;
      return Promise.resolve(new Response("{}", { status: 401 }));
    }) as typeof fetch;
    const e = await reject(getOnce(deps(f), true));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar drafts.create failed: token refresh failed");
    expect(sends).toBe(1);
  });

  it.each([[undefined], [false]])("with singleSend %s the 401 retry still sends twice", async (singleSend) => {
    writeToken(dir, token());
    const r = await getOnce(use(["events-list-401", "oauth-refresh", "events-list-page"]), singleSend);
    expect(r.status).toBe(200);
    expect(apiSends()).toHaveLength(2);
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
            service: "calendar",
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

const GM = "https://www.googleapis.com/gmail/v1/users/me";
const gmailToken = (scopes: string[] = [SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ]) => token({ scopes });
function countingFetch(): { f: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}
const gmail = (d: GoogleHttpDeps, method: "GET" | "POST", url: string, requiredScope = SCOPE_GMAIL_READ) =>
  googleRequest(d, "gmail.test", { service: "gmail", method, url, requiredScope, ...(method === "POST" ? { body: {} } : {}) });
const ALL_FOUR = [SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ, SCOPE_CALENDAR_WRITE, SCOPE_GMAIL_COMPOSE];

describe("Gmail endpoint allowlist (M4b decision 2)", () => {
  const ALLOWED: [string, "GET" | "POST", string][] = [
    ["profile", "GET", `${GM}/profile`],
    ["thread list", "GET", `${GM}/threads?q=in%3Ainbox&maxResults=5`],
    ["thread", "GET", `${GM}/threads/18c2a_B-9?format=full`],
    ["draft list", "GET", `${GM}/drafts`],
    ["draft", "GET", `${GM}/drafts/r-123_ABC`],
    ["draft create", "POST", `${GM}/drafts`],
  ];
  it.each(ALLOWED)("accepts %s", async (_n, method, url) => {
    writeToken(dir, gmailToken(ALL_FOUR));
    const { f, calls } = countingFetch();
    const r = await gmail(deps(f), method, url, method === "POST" ? SCOPE_GMAIL_COMPOSE : SCOPE_GMAIL_READ);
    expect(r.status).toBe(200);
    expect(calls).toEqual([url]);
  });

  const REFUSED: [string, "GET" | "POST", string][] = [
    ["POST /drafts/send", "POST", `${GM}/drafts/send`],
    ["POST /messages/send", "POST", `${GM}/messages/send`],
    ["POST /threads/{id}/modify", "POST", `${GM}/threads/abc/modify`],
    ["POST /messages/{id}/trash", "POST", `${GM}/messages/abc/trash`],
    ["GET /messages", "GET", `${GM}/messages`],
    ["GET /messages/{id}", "GET", `${GM}/messages/abc`],
    ["POST /threads/{id}", "POST", `${GM}/threads/abc`],
    ["POST /drafts/{id}", "POST", `${GM}/drafts/abc`],
    ["GET /profile/extra", "GET", `${GM}/profile/extra`],
    ["GET /drafts/{id}/send", "GET", `${GM}/drafts/abc/send`],
    ["another user", "GET", "https://www.googleapis.com/gmail/v1/users/someone/threads"],
    ["a calendar path", "GET", "https://www.googleapis.com/calendar/v3/calendars/primary/events"],
    ["the API root", "GET", "https://www.googleapis.com/"],
    ["a trailing slash", "GET", `${GM}/threads/abc/`],
    ["an empty id", "GET", `${GM}/threads/`],
    ["an id with %2F", "GET", `${GM}/threads/abc%2Fmodify`],
    ["an id with %2f", "GET", `${GM}/threads/abc%2fdef`],
    ["an id that is ..", "GET", `${GM}/threads/..`],
    ["an id that is %2e%2e", "GET", `${GM}/threads/%2e%2e`],
    ["an id with an encoded ?", "GET", `${GM}/threads/abc%3Fx`],
    ["a double-encoded id", "GET", `${GM}/threads/abc%252Fmodify`],
    ["an id with a backslash", "GET", `${GM}/threads/abc%5Cdef`],
    ["an id with a space", "GET", `${GM}/drafts/a%20b`],
    ["an over-long id", "GET", `${GM}/threads/${"a".repeat(65)}`],
  ];
  it.each(REFUSED)("refuses %s with no fetch", async (_n, method, url) => {
    writeToken(dir, gmailToken(ALL_FOUR));
    const { f, calls } = countingFetch();
    const e = await reject(gmail(deps(f), method, url, method === "POST" ? SCOPE_GMAIL_COMPOSE : SCOPE_GMAIL_READ));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google gmail gmail.test failed: refused request to an endpoint outside the allowlist");
    expect((e as ProviderError).retryable).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses before the token is loaded or refreshed (no token.json, then an expired token)", async () => {
    const { f, calls } = countingFetch();
    const e = await reject(gmail(deps(f), "POST", `${GM}/messages/send`, SCOPE_GMAIL_COMPOSE));
    expect(e).toBeInstanceOf(ProviderError);
    writeToken(dir, token({ ...expired(), scopes: [SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ] }));
    const e2 = await reject(gmail(deps(f), "GET", `${GM}/messages`));
    expect(e2).toBeInstanceOf(ProviderError);
    expect(calls).toEqual([]);
    expect(readToken(dir)!.access_token).toBe("ya29.OLD-ACCESS-TOKEN");
  });

  const CAL_REFUSED: [string, string][] = [
    ["Gmail drafts/send", `${GM}/drafts/send`],
    ["Gmail messages/send", `${GM}/messages/send`],
    ["/batch/gmail/v1", "https://www.googleapis.com/batch/gmail/v1"],
    ["/upload/gmail/v1/...", "https://www.googleapis.com/upload/gmail/v1/users/me/messages/send"],
    ["a dot segment out of /calendar/v3/", "https://www.googleapis.com/calendar/v3/../../gmail/v1/users/me/drafts/send"],
    ["an encoded dot segment", "https://www.googleapis.com/calendar/v3/%2e%2e/%2e%2e/gmail/v1/users/me/drafts/send"],
    ["a mixed-case encoded dot segment", "https://www.googleapis.com/calendar/v3/.%2E/.%2e/gmail/v1/users/me/drafts/send"],
    ["a path that only starts like it", "https://www.googleapis.com/calendar/v30/x"],
    ["the bare /calendar/v3", "https://www.googleapis.com/calendar/v3"],
    ["the API root", "https://www.googleapis.com/"],
  ];
  it.each(CAL_REFUSED)("a calendar-labelled request to %s is refused with no fetch", async (_n, url) => {
    writeToken(dir, gmailToken(ALL_FOUR));
    const { f, calls } = countingFetch();
    const e = await reject(
      googleRequest(deps(f), "events.list", { service: "calendar", method: "POST", url, body: {}, requiredScope: SCOPE_CALENDAR_READ }),
    );
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google calendar events.list failed: refused request to an endpoint outside the allowlist");
    expect(calls).toEqual([]);
  });

  it("a calendar-labelled refusal happens before the token is loaded", async () => {
    const e = await reject(
      googleRequest(deps(never), "events.list", { service: "calendar", method: "GET", url: `${GM}/drafts`, requiredScope: SCOPE_CALENDAR_READ }),
    );
    expect(e).toBeInstanceOf(ProviderError);
  });

  it("the calendar service is not subject to the Gmail allowlist", async () => {
    writeToken(dir, token());
    const { f, calls } = countingFetch();
    await googleRequest(deps(f), "events.list", { service: "calendar", method: "GET", url: LIST_URL, requiredScope: SCOPE_CALENDAR_READ });
    expect(calls).toEqual([LIST_URL]);
  });

  it("the provider label follows the service", async () => {
    const e = await reject(gmail(deps(never), "GET", `${GM}/messages`));
    expect(e.message).toContain("google gmail ");
  });
});

describe("Gmail scopes in googleRequest", () => {
  it("Review Focus 3: a calendar-only token cannot read Gmail, sends nothing, and still reads the calendar", async () => {
    writeToken(dir, token());
    const e = await reject(gmail(deps(never), "GET", `${GM}/threads`));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(LOGIN);
    const { f, calls } = countingFetch();
    await expect(gmail(deps(f), "GET", `${GM}/threads`)).rejects.toThrow(LOGIN);
    expect(calls).toEqual([]);
    const r = await getList(use(["events-list-page"]));
    expect(r.status).toBe(200);
  });

  it("a missing gmail.compose is the upgrade sentence, before any request", async () => {
    writeToken(dir, gmailToken());
    const e = await reject(gmail(deps(never), "POST", `${GM}/drafts`, SCOPE_GMAIL_COMPOSE));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(UPGRADE);
  });

  it("a 403 insufficientPermissions is the upgrade sentence for a draft write and the login sentence for a read", async () => {
    writeToken(dir, gmailToken([SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ, SCOPE_GMAIL_COMPOSE]));
    const denied = (async () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 })) as unknown as typeof fetch;
    expect((await reject(gmail(deps(denied), "POST", `${GM}/drafts`, SCOPE_GMAIL_COMPOSE))).message).toBe(UPGRADE);
    expect((await reject(gmail(deps(denied), "GET", `${GM}/threads`))).message).toBe(LOGIN);
  });
});
