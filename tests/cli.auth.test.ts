import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { AUTH_USAGE, authCommand } from "../src/cli/auth.js";
import { createCliContext } from "../src/cli/context.js";
import { runCli } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/io.js";
import { loadConfig } from "../src/config/env.js";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE } from "../src/config/scopes.js";
import { LedgerDb } from "../src/ledger/db.js";
import { queryEvents } from "../src/ledger/events.js";
import { createIdGenerator } from "../src/ledger/ids.js";
import { OAuthError, type OAuthDeps } from "../src/providers/google/oauth.js";
import { readToken, writeToken } from "../src/providers/google/token-store.js";
import { jsonReply, startFakeOAuth, type FakeOAuth } from "./helpers/fake-oauth.js";
import { makeTempHome } from "./helpers/home.js";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const SECRET = "SECRET-XYZ-do-not-leak";
const ACCESS = "ya29.FAKE-ACCESS";
const REFRESH = "1//FAKE-REFRESH";
const CODE = "AUTHCODE-12345";

let home: ReturnType<typeof makeTempHome>;
let db: LedgerDb;
let fake: FakeOAuth;
let now: Date;

beforeEach(async () => {
  home = makeTempHome();
  db = LedgerDb.open(join(home.home, "ledger.db"));
  fake = await startFakeOAuth();
  now = NOW;
  writeClient();
});
afterEach(async () => {
  db.close();
  await fake.close();
  home.cleanup();
});

function writeClient(): void {
  writeFileSync(
    join(home.home, "client_secret.json"),
    JSON.stringify({ installed: { client_id: "cid.apps.googleusercontent.com", client_secret: SECRET } }),
  );
}

function ctx(env: NodeJS.ProcessEnv = {}): AppContext {
  return {
    config: loadConfig({ ...home.env, ...env }),
    db,
    clock: () => now,
    ids: createIdGenerator(),
    provider: null,
    mail: null,
    actor: "tester",
  };
}

interface Browser {
  mode: "approve" | "deny";
  urls: URL[];
}

/** A scripted CliIo that plays the browser as soon as the consent URL is printed. */
function scriptedIo(browser: Browser = { mode: "approve", urls: [] }) {
  let out = "";
  let err = "";
  const pending: Promise<unknown>[] = [];
  const io: CliIo = {
    out: (s) => {
      out += s;
      const m = /^(http:\/\/\S+)$/m.exec(s);
      if (m?.[1]) {
        const url = new URL(m[1]);
        browser.urls.push(url);
        const redirect = url.searchParams.get("redirect_uri")!;
        const state = url.searchParams.get("state")!;
        const q = browser.mode === "approve" ? `code=${CODE}&state=${state}` : `error=access_denied&state=${state}`;
        pending.push(fetch(`${redirect}?${q}`).then((r) => r.text()));
      }
    },
    err: (s) => (err += s),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    readLine: () => Promise.reject(new Error("no input expected")),
  };
  return { io, outText: () => out, errText: () => err, settle: () => Promise.all(pending), browser };
}

function deps(over: Partial<OAuthDeps> = {}): Partial<OAuthDeps> {
  return { endpoints: { authUrl: "http://127.0.0.1:9/auth", tokenUrl: fake.tokenUrl }, now: () => now, ...over };
}

function replyScopes(scopes: string[]): void {
  fake.respond((_req, res) =>
    jsonReply(res, 200, {
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: 3600,
      scope: scopes.join(" "),
      token_type: "Bearer",
    }),
  );
}

function rows() {
  return queryEvents(db, { tool: "cli:auth", limit: 100 });
}

describe("auth login", () => {
  it("writes token.json, prints the link and scope, exit 0, one ok row", async () => {
    replyScopes([SCOPE_CALENDAR_READ]);
    const s = scriptedIo();
    const code = await authCommand(ctx(), s.io, ["login"], deps());
    await s.settle();
    expect(code).toBe(0);
    expect(s.outText()).toContain("Open this link in your browser to sign in:");
    expect(s.outText()).toContain(SCOPE_CALENDAR_READ);
    expect(s.outText()).toContain("Sign-in saved. In Testing mode Google expires it after about 7 days.");
    expect(readToken(home.home)?.scopes).toEqual([SCOPE_CALENDAR_READ]);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "cli_command", outcome: "ok", error_code: null });
    expect(r[0]?.preview).toEqual({
      v: 1,
      input: { subcommand: "login" },
      output: { scopes: [SCOPE_CALENDAR_READ] },
      note: null,
    });
  });

  it("with DESKHAND_ALLOW_WRITES=1 still asks for the read scope only", async () => {
    replyScopes([SCOPE_CALENDAR_READ]);
    const s = scriptedIo();
    expect(await authCommand(ctx({ DESKHAND_ALLOW_WRITES: "1" }), s.io, ["login"], deps())).toBe(0);
    await s.settle();
    expect(s.browser.urls[0]?.searchParams.get("scope")).toBe(SCOPE_CALENDAR_READ);
  });

  it("the consent URL has no include_granted_scopes, so earlier grants are not folded in", async () => {
    replyScopes([SCOPE_CALENDAR_READ]);
    const s = scriptedIo();
    expect(await authCommand(ctx(), s.io, ["login"], deps())).toBe(0);
    await s.settle();
    expect(s.browser.urls[0]?.searchParams.has("include_granted_scopes")).toBe(false);
  });

  it("a login whose token response also lists the write scope (an earlier upgrade) stores the read scope only", async () => {
    replyScopes([SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE]);
    const s = scriptedIo();
    expect(await authCommand(ctx({ DESKHAND_ALLOW_WRITES: "1" }), s.io, ["login"], deps())).toBe(0);
    await s.settle();
    expect(readToken(home.home)?.scopes).toEqual([SCOPE_CALENDAR_READ]);
    expect(s.outText()).not.toContain(SCOPE_CALENDAR_WRITE);
    expect(rows()[0]?.preview).toMatchObject({ output: { scopes: [SCOPE_CALENDAR_READ] } });
  });

  it("denied: exit 1, one stderr line, AUTH_REQUIRED row, no token.json", async () => {
    const s = scriptedIo({ mode: "deny", urls: [] });
    const code = await authCommand(ctx(), s.io, ["login"], deps());
    await s.settle();
    expect(code).toBe(1);
    expect(s.errText().trimEnd().split("\n")).toHaveLength(1);
    expect(s.errText()).toContain("cancelled or denied");
    expect(existsSync(join(home.home, "token.json"))).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ outcome: "error", error_code: "AUTH_REQUIRED" });
  });

  it("token endpoint failure maps to PROVIDER_ERROR", async () => {
    fake.respond((_req, res) => jsonReply(res, 500, { error: "boom", detail: ACCESS }));
    const s = scriptedIo();
    expect(await authCommand(ctx(), s.io, ["login"], deps())).toBe(1);
    await s.settle();
    expect(rows()[0]).toMatchObject({ outcome: "error", error_code: "PROVIDER_ERROR" });
    expect(s.errText()).not.toContain(ACCESS);
  });

  it("a missing client file exits 1 naming the path, INVALID_INPUT", async () => {
    const empty = makeTempHome();
    try {
      const s = scriptedIo();
      const c = { ...ctx(), config: loadConfig(empty.env) };
      expect(await authCommand(c, s.io, ["login"], deps())).toBe(1);
      expect(s.errText()).toContain(join(empty.home, "client_secret.json"));
      expect(s.errText().trimEnd().split("\n")).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ outcome: "error", error_code: "INVALID_INPUT" });
    } finally {
      empty.cleanup();
    }
  });
});

describe("auth upgrade", () => {
  it("without DESKHAND_ALLOW_WRITES=1 exits 1 and requests nothing", async () => {
    const s = scriptedIo();
    expect(await authCommand(ctx(), s.io, ["upgrade"], deps())).toBe(1);
    expect(s.errText()).toBe("deskhand: auth upgrade needs DESKHAND_ALLOW_WRITES=1\n");
    expect(s.browser.urls).toHaveLength(0);
    expect(fake.requests).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ outcome: "error", error_code: "INVALID_INPUT" });
  });

  it("without a token says to log in first, AUTH_REQUIRED", async () => {
    const s = scriptedIo();
    expect(await authCommand(ctx({ DESKHAND_ALLOW_WRITES: "1" }), s.io, ["upgrade"], deps())).toBe(1);
    expect(s.errText()).toContain("run deskhand auth login first");
    expect(s.browser.urls).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ outcome: "error", error_code: "AUTH_REQUIRED" });
  });

  it("with the flag and a token requests both scopes and stores both", async () => {
    writeToken(home.home, {
      version: 1,
      client_id: "cid.apps.googleusercontent.com",
      scopes: [SCOPE_CALENDAR_READ],
      refresh_token: "old-refresh",
      access_token: "old-access",
      expires_at: NOW.toISOString(),
      obtained_at: NOW.toISOString(),
    });
    replyScopes([SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE]);
    const s = scriptedIo();
    expect(await authCommand(ctx({ DESKHAND_ALLOW_WRITES: "1" }), s.io, ["upgrade"], deps())).toBe(0);
    await s.settle();
    expect(s.browser.urls[0]?.searchParams.get("scope")).toBe(`${SCOPE_CALENDAR_READ} ${SCOPE_CALENDAR_WRITE}`);
    expect(s.browser.urls[0]?.searchParams.get("include_granted_scopes")).toBe("true");
    expect(readToken(home.home)?.scopes).toEqual([SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE]);
    expect(rows()[0]).toMatchObject({ outcome: "ok" });
  });
});

describe("auth status", () => {
  const seed = () =>
    writeToken(home.home, {
      version: 1,
      client_id: "cid.apps.googleusercontent.com",
      scopes: [SCOPE_CALENDAR_READ],
      refresh_token: REFRESH,
      access_token: ACCESS,
      expires_at: NOW.toISOString(),
      obtained_at: NOW.toISOString(),
    });

  it("with no token exits 1 and says how to log in", async () => {
    const s = scriptedIo();
    expect(await authCommand(ctx(), s.io, ["status"], deps())).toBe(1);
    expect(s.outText()).toContain("client_secret.json: found");
    expect(s.outText()).toContain("deskhand auth login");
    expect(rows()[0]).toMatchObject({ outcome: "error", error_code: "AUTH_REQUIRED" });
  });

  it("3 days after obtained_at says about 4 days left", async () => {
    seed();
    now = new Date(NOW.getTime() + 3 * 86_400_000);
    const s = scriptedIo();
    expect(await authCommand(ctx(), s.io, ["status"], deps())).toBe(0);
    expect(s.outText()).toContain("about 4 days left");
    expect(s.outText()).toContain("Write access: no");
    expect(s.outText()).toContain(SCOPE_CALENDAR_READ);
    expect(s.outText()).toContain(NOW.toISOString());
    expect(rows()[0]).toMatchObject({ outcome: "ok" });
  });

  it("8 days after says probably expired", async () => {
    seed();
    now = new Date(NOW.getTime() + 8 * 86_400_000);
    const s = scriptedIo();
    expect(await authCommand(ctx(), s.io, ["status"], deps())).toBe(0);
    expect(s.outText()).toContain("probably expired");
  });

  it("makes no network request", async () => {
    seed();
    const s = scriptedIo();
    await authCommand(ctx(), s.io, ["status"], deps({ fetch: () => Promise.reject(new Error("no network")) }));
    expect(fake.requests).toHaveLength(0);
  });
});

describe("usage and mapping", () => {
  it("anything else is usage, exit 2, with a row", async () => {
    const s = scriptedIo();
    expect(await authCommand(ctx(), s.io, ["bogus"], deps())).toBe(2);
    expect(s.errText()).toContain("usage: deskhand auth login | status | upgrade");
    expect(rows()[0]).toMatchObject({ outcome: "error", error_code: "INVALID_INPUT" });
  });

  it.each([[["auth"]], [["auth", "bogus"]], [["auth", "login", "extra"]]])(
    "%j through runCli with a real context: exit 2, usage on stderr, one cli:auth row with subcommand null",
    async (argv) => {
      const s = scriptedIo();
      expect(await runCli(argv, s.io, () => createCliContext(home.env))).toBe(2);
      expect(s.errText()).toBe(AUTH_USAGE);
      const r = rows();
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ kind: "cli_command", tool: "cli:auth", outcome: "error", error_code: "INVALID_INPUT" });
      expect(r[0]?.preview).toEqual({
        v: 1,
        input: { subcommand: null },
        output: null,
        note: "usage: deskhand auth login | status | upgrade",
      });
    },
  );

  it("OAuthError carries an explicit code", () => {
    expect(new OAuthError("x").code).toBe("AUTH_REQUIRED");
    expect(new OAuthError("x", "PROVIDER_ERROR").code).toBe("PROVIDER_ERROR");
  });
});

describe("leaks", () => {
  it("no secret, token or code appears in output, ledger rows or sibling files", async () => {
    replyScopes([SCOPE_CALENDAR_READ]);
    const ok = scriptedIo();
    await authCommand(ctx(), ok.io, ["login"], deps());
    await ok.settle();
    const bad = scriptedIo({ mode: "deny", urls: [] });
    await authCommand(ctx(), bad.io, ["login"], deps());
    await bad.settle();
    fake.respond((_req, res) =>
      jsonReply(res, 400, { error: "invalid_request", error_description: `${CODE} ${SECRET}` }),
    );
    const failed = scriptedIo();
    await authCommand(ctx(), failed.io, ["login"], deps());
    await failed.settle();
    const stat = scriptedIo();
    await authCommand(ctx(), stat.io, ["status"], deps());

    const secrets = [SECRET, ACCESS, REFRESH, CODE];
    const state = ok.browser.urls[0]!.searchParams.get("state")!;
    const outLines = [ok, bad, failed, stat].flatMap((s) => (s.outText() + s.errText()).split("\n"));
    // The consent URL itself carries state (the browser needs it); every other line must not.
    const nonUrl = outLines.filter((l) => !l.startsWith("http://")).join("\n");
    for (const v of [...secrets, state]) expect(nonUrl).not.toContain(v);
    for (const v of secrets) expect(outLines.join("\n")).not.toContain(v);

    const allRows = JSON.stringify(db.all("SELECT * FROM events"));
    for (const v of [...secrets, state]) expect(allRows).not.toContain(v);

    for (const f of readdirSync(home.home)) {
      if (f === "token.json" || f === "client_secret.json" || f.startsWith("ledger.db")) continue;
      const body = readFileSync(join(home.home, f), "utf8");
      for (const v of secrets) expect(body).not.toContain(v);
    }
  });
});
