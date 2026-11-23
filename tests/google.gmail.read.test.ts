import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ } from "../src/config/scopes.js";
import { AuthRequiredError, ProviderError } from "../src/providers/errors.js";
import { createGoogleCalendarProvider } from "../src/providers/google/calendar.js";
import { createGmailProvider } from "../src/providers/google/gmail.js";
import type { GoogleHttpDeps } from "../src/providers/google/http.js";
import { GOOGLE_ENDPOINTS } from "../src/providers/google/oauth.js";
import { writeToken } from "../src/providers/google/token-store.js";
import { setupHarness } from "./helpers/harness.js";
import { makeTempHome } from "./helpers/home.js";
import { replayFetch, type Replay } from "./helpers/replay-fetch.js";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const LOGIN = "Not signed in to Google. Run: deskhand auth login";

let home: ReturnType<typeof makeTempHome>;
let replay: Replay | undefined;

function login(scopes: string[]): void {
  writeToken(home.home, {
    version: 1,
    client_id: "cid.apps.googleusercontent.com",
    scopes,
    refresh_token: "1//REFRESH-SECRET",
    access_token: "ya29.OLD-ACCESS-TOKEN",
    expires_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
    obtained_at: "2026-11-10T10:00:00.000Z",
  });
}

beforeEach(() => {
  home = makeTempHome();
  login([SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ]);
});
afterEach(() => {
  try {
    replay?.verify();
  } finally {
    replay = undefined;
    home.cleanup();
  }
});

const deps = (f: typeof fetch): GoogleHttpDeps => ({
  fetch: f,
  configDir: home.home,
  now: () => NOW,
  oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW },
});
const provider = (names: string[]) => {
  replay = replayFetch(names);
  return createGmailProvider(deps(replay.fetch));
};
/** Answers every call with `body` and records the URLs. */
const stub = (body: unknown, status = 200) => {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { f, urls };
};
const reject = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};
const msg = (id: string, internalDate: string, labelIds?: string[]) => ({
  id,
  internalDate,
  ...(labelIds ? { labelIds } : {}),
  payload: { mimeType: "text/plain", headers: [], body: {} },
});

describe("recordings", () => {
  it("no gmail recording has a name a secret pattern would match", () => {
    const dir = fileURLToPath(new URL("./recorded/google/", import.meta.url));
    const names = readdirSync(dir).filter((n) => n.startsWith("gmail-"));
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const n of names) {
      expect(n).not.toMatch(/^(token|client_secret|credentials)/);
      const addresses = readFileSync(`${dir}${n}`, "utf8").match(/[\w.+-]+@[\w.-]+\.[a-z]+/gi) ?? [];
      // The one other form: a draft's own Message-ID, which is derived from the action id and is not an address.
      expect(addresses.filter((a) => !a.endsWith("@example.com") && !/^deskhand\.[0-9a-f]{64}@deskhand\.invalid$/.test(a))).toEqual([]);
    }
  });
});

describe("profile", () => {
  it("returns the mailbox address", async () => {
    expect(await provider(["gmail-profile"]).profile()).toEqual({ email: "me@example.com" });
  });
  it("an unreadable profile is a fixed ProviderError", async () => {
    const e = await reject(createGmailProvider(deps(stub({ emailAddress: 7 }).f)).profile());
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google gmail profile failed: unreadable response");
  });
});

describe("searchThreads", () => {
  it("lists, reads metadata per thread, newest first, truncated on nextPageToken", async () => {
    const r = await provider(["gmail-threads-list-more", "gmail-thread-meta-one", "gmail-thread-meta-two"]).searchThreads("budget", 2);
    expect(r.truncated).toBe(true);
    expect(r.threads).toEqual([
      {
        id: "t-two",
        subject: "Thread two",
        from: { address: "ana@example.com", name: "Ana Lopez" },
        lastDate: "2026-11-10T12:00:00.000Z",
        snippet: "snippet of w1",
        messageCount: 1,
        unread: false,
      },
      {
        id: "t-one",
        subject: "Thread one",
        from: { address: "ana@example.com", name: "Ana Lopez" },
        lastDate: "2026-11-10T09:00:00.000Z",
        snippet: "snippet of o2",
        messageCount: 2,
        unread: true,
      },
    ]);
  });
  it("is not truncated without nextPageToken", async () => {
    const r = await provider(["gmail-threads-list-last", "gmail-thread-meta-one", "gmail-thread-meta-two"]).searchThreads("budget", 5);
    expect(r.truncated).toBe(false);
    expect(r.threads).toHaveLength(2);
  });
  it("no results: Gmail omits `threads`", async () => {
    const { f, urls } = stub({ resultSizeEstimate: 0 });
    expect(await createGmailProvider(deps(f)).searchThreads("nothing", 5)).toEqual({ threads: [], truncated: false });
    expect(urls).toHaveLength(1);
  });
  it("encodes the query", async () => {
    const { f, urls } = stub({});
    await createGmailProvider(deps(f)).searchThreads("from:a@example.com&x=1 #y", 5);
    const u = new URL(urls[0]!);
    expect(u.searchParams.get("q")).toBe("from:a@example.com&x=1 #y");
    expect(u.searchParams.get("maxResults")).toBe("5");
  });
  it("skips a thread deleted after the list, and one holding only hidden messages", async () => {
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/threads")) return new Response(JSON.stringify({ threads: [{ id: "gone" }, { id: "hidden" }] }));
      if (u.pathname.endsWith("/gone")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ id: "hidden", messages: [msg("d", "1000", ["DRAFT"])] }));
    }) as typeof fetch;
    expect((await createGmailProvider(deps(f)).searchThreads("x", 5)).threads).toEqual([]);
  });
});

describe("getThread", () => {
  const full = async (max = 100) => (await provider(["gmail-thread-full"]).getThread("t-full", max))!;
  const byId = async (id: string) => (await full()).messages.find((m) => m.id === id)!;

  it("sorts by internalDate and drops DRAFT and TRASH", async () => {
    const t = await full();
    expect(t.id).toBe("t-full");
    expect(t.truncated).toBe(false);
    expect(t.messages.map((m) => m.id)).toEqual(["m-encoded", "m-plain", "m-alt", "m-html", "m-latin", "m-nested", "m-owner-from"]);
    expect(t.messages[0]!.date).toBe("2026-11-10T09:00:00.000Z");
  });
  it("drops SPAM", async () => {
    const { f } = stub({ id: "t", messages: [msg("a", "1000"), msg("s", "2000", ["SPAM"])] });
    const t = await createGmailProvider(deps(f)).getThread("t", 10);
    expect(t!.messages.map((m) => m.id)).toEqual(["a"]);
  });
  it("the sort is stable for equal dates", async () => {
    const { f } = stub({ id: "t", messages: [msg("b", "1000"), msg("a", "1000"), msg("c", "500")] });
    const t = await createGmailProvider(deps(f)).getThread("t", 10);
    expect(t!.messages.map((m) => m.id)).toEqual(["c", "b", "a"]);
  });
  it("keeps the newest maxMessages and says older ones were cut", async () => {
    const t = await full(2);
    expect(t.messages.map((m) => m.id)).toEqual(["m-nested", "m-owner-from"]);
    expect(t.truncated).toBe(true);
  });
  it("hidden messages do not count towards the cut", async () => {
    const { f } = stub({ id: "t", messages: [msg("a", "1000"), msg("d", "2000", ["DRAFT"])] });
    const t = await createGmailProvider(deps(f)).getThread("t", 1);
    expect(t!.messages.map((m) => m.id)).toEqual(["a"]);
    expect(t!.truncated).toBe(false);
  });
  it("404 is null", async () => {
    expect(await provider(["gmail-thread-404"]).getThread("t-missing", 10)).toBeNull();
  });
  it("sentByOwner: true with the SENT label", async () => {
    expect((await byId("m-alt")).sentByOwner).toBe(true);
  });
  it("sentByOwner: false for From: <owner> without the SENT label", async () => {
    const m = await byId("m-owner-from");
    expect(m.from?.address).toBe("me@example.com");
    expect(m.sentByOwner).toBe(false);
    expect(m.unread).toBe(true);
  });
  it("text/plain, with Reply-To and Message-ID", async () => {
    const m = await byId("m-plain");
    expect(m.bodyText).toBe("BODY-SENTINEL-plain");
    expect(m.bodyTruncated).toBe(false);
    expect(m.replyTo).toEqual([{ address: "ana.reply@example.com", name: "" }]);
    expect(m.messageIdHeader).toBe("<m-plain@example.com>");
    expect(m.threadId).toBe("t-full");
    expect(m.snippet).toBe("snippet of m-plain");
  });
  it("multipart/alternative prefers the plain part", async () => {
    expect((await byId("m-alt")).bodyText).toBe("BODY-SENTINEL-alt plain");
  });
  it("HTML only: readable, with no script, style or title", async () => {
    const b = (await byId("m-html")).bodyText;
    expect(b.split(/\n+/)).toEqual(["BODY-SENTINEL-html & more", "second line"]);
  });
  it("ISO-8859-1 body", async () => {
    expect((await byId("m-latin")).bodyText).toBe("Café crème");
  });
  it("nested multipart/mixed with an attachment", async () => {
    expect((await byId("m-nested")).bodyText).toBe("BODY-SENTINEL-nested plain");
  });
  it("encoded subject and name, a group address, and an unparseable address dropped", async () => {
    const m = await byId("m-encoded");
    expect(m.subject).toBe("Présupuesto café");
    expect(m.from).toEqual({ address: "jose@example.com", name: "José García" });
    expect(m.to.map((a) => a.address)).toEqual(["a@example.com", "b@example.com"]);
    expect(m.cc.map((a) => a.address)).toEqual(["c@example.com"]);
  });
  it("a malformed Message-ID is null, never a header value with a line break", async () => {
    for (const value of ["no-brackets@example.com", "<a b@example.com>", "<a@example.com>\r\nBcc: x@example.com", "<<a@example.com>>"]) {
      const { f } = stub({ id: "t", messages: [{ ...msg("a", "1000"), payload: { headers: [{ name: "Message-ID", value }] } }] });
      const t = await createGmailProvider(deps(f)).getThread("t", 10);
      expect(t!.messages[0]!.messageIdHeader, value).toBeNull();
    }
  });
  it("a hostile payload never throws", async () => {
    for (const payload of [undefined, null, 1, "x", [], { parts: "x" }, { headers: [1, null], parts: [null] }]) {
      const { f } = stub({ id: "t", messages: [{ ...msg("a", "1000"), payload }] });
      const t = await createGmailProvider(deps(f)).getThread("t", 10);
      expect(t!.messages[0]!.bodyText).toBe("");
      expect(t!.messages[0]!.from).toBeNull();
    }
  });
  it.each([
    ["not an object", 7],
    ["no messages", { id: "t" }],
    ["a message id that is no string", { messages: [{ id: 1, internalDate: "1" }] }],
    ["a bad internalDate", { messages: [{ id: "a", internalDate: "soon" }] }],
    ["an out-of-range internalDate", { messages: [{ id: "a", internalDate: "99999999999999999" }] }],
    ["labels that are no list", { messages: [{ id: "a", internalDate: "1", labelIds: "DRAFT" }] }],
  ])("%s is a fixed ProviderError", async (_name, body) => {
    const e = await reject(createGmailProvider(deps(stub(body).f)).getThread("t", 10));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe("google gmail threads.get failed: unreadable response");
  });
  it("no thrown message holds recorded body text", async () => {
    const secret = "BODY-SENTINEL-in-error";
    const bodies: [unknown, number][] = [
      [{ error: { message: secret, errors: [{ reason: secret, message: secret }] } }, 500],
      [{ error: { message: secret } }, 400],
      [{ messages: [{ id: secret, internalDate: secret }] }, 200],
      [{ messages: secret }, 200],
    ];
    for (const [body, status] of bodies) {
      const e = await reject(createGmailProvider(deps(stub(body, status).f)).getThread("t", 10));
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).not.toContain("SENTINEL");
    }
  });
});

describe("threadMessageIds", () => {
  it("asks for format=minimal and leaves out DRAFT, TRASH and SPAM", async () => {
    const ids = await provider(["gmail-thread-minimal"]).threadMessageIds("t-full");
    expect(ids).toEqual(["k1", "k2", "k3"]);
    expect(new URL(replay!.seen[0]!.url).searchParams.get("format")).toBe("minimal");
  });
  it.each(["DRAFT", "TRASH", "SPAM"])("excludes a %s message", async (label) => {
    const { f } = stub({ id: "t", messages: [{ id: "keep", labelIds: ["INBOX"] }, { id: "out", labelIds: ["INBOX", label] }] });
    expect(await createGmailProvider(deps(f)).threadMessageIds("t")).toEqual(["keep"]);
  });
  it("has no cap", async () => {
    const messages = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, labelIds: ["INBOX"] }));
    expect(await createGmailProvider(deps(stub({ id: "t", messages }).f)).threadMessageIds("t")).toHaveLength(500);
  });
  it("404 is null", async () => {
    expect(await provider(["gmail-thread-minimal-404"]).threadMessageIds("t-missing")).toBeNull();
  });
  it("fails closed on an unreadable list rather than hashing a partial set", async () => {
    for (const body of [{ id: "t" }, { messages: [{ labelIds: [] }] }, { messages: [{ id: "a", labelIds: "DRAFT" }] }]) {
      const e = await reject(createGmailProvider(deps(stub(body).f)).threadMessageIds("t"));
      expect(e).toBeInstanceOf(ProviderError);
    }
  });
});

describe("path ids", () => {
  it.each(["abc?x", "abc#x", "abc/../x", "..", ".", "", "abc%3Fx", "a b", "abc/send"])("refuses %j with no network call", async (id) => {
    const { f, urls } = stub({ id: "abc", messages: [] });
    const p = createGmailProvider(deps(f));
    for (const call of [() => p.getThread(id, 10), () => p.threadMessageIds(id)]) {
      const e = await reject(call());
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).toContain("refused request to an endpoint outside the allowlist");
    }
    expect(urls).toEqual([]);
  });
});

describe("the write surface", () => {
  it("the provider has no send method", () => {
    const p = createGmailProvider(deps(stub({}).f));
    expect(Object.keys(p).filter((k) => /send/i.test(k))).toEqual([]);
  });
});

describe("through the inbox tools on the Google provider", () => {
  type H = Awaited<ReturnType<typeof setupHarness>>;
  let h: H;
  beforeEach(async () => {
    h = await setupHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("inbox_read_thread wraps every text field and the ledger preview holds no body", async () => {
    replay = replayFetch(["gmail-thread-full"]);
    h.ctx.mail = createGmailProvider(deps(replay.fetch));
    const r = await h.client.callTool({ name: "inbox_read_thread", arguments: { thread_id: "t-full" } });
    expect(r.isError).toBeFalsy();
    const s = "mail:t-full";
    const wrapped = (v: unknown) => expect(v).toMatchObject({ untrusted: true, source: s, content: expect.any(String) });
    const out = r.structuredContent as { messages: Record<string, unknown>[] };
    expect(out.messages).toHaveLength(7);
    for (const m of out.messages) {
      wrapped(m.subject);
      wrapped(m.body_text);
      const people = [...(m.reply_to as object[]), ...(m.to as object[]), ...(m.cc as object[]), ...(m.from ? [m.from as object] : [])];
      expect(people.length).toBeGreaterThan(0);
      for (const a of people as { address: unknown; name: unknown }[]) {
        wrapped(a.address);
        wrapped(a.name);
      }
    }
    await h.logging.whenIdle();
    const row = h.rows().find((x) => x.kind === "tool_call" && x.tool === "inbox_read_thread")!;
    expect(row.outcome).toBe("ok");
    expect(row.preview_json).not.toContain("BODY-SENTINEL");
    expect(row.preview_json).not.toContain("second line");
  });

  it("Review Focus 1: malformed HTML through the tool: no script text, wrapped", async () => {
    const html = '<p>hello<script>var a=">";evil()</script> world <b oops';
    const payload = { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html" }], body: { data: Buffer.from(html).toString("base64url") } };
    h.ctx.mail = createGmailProvider(deps(stub({ id: "t", messages: [{ ...msg("a", "1000"), payload }] }).f));
    const r = await h.client.callTool({ name: "inbox_read_thread", arguments: { thread_id: "t" } });
    const body = (r.structuredContent as { messages: { body_text: { untrusted: boolean; content: string } }[] }).messages[0]!.body_text;
    expect(body.untrusted).toBe(true);
    expect(body.content).toContain("hello");
    expect(body.content).not.toContain("evil");
  });

  it("Review Focus 3: a calendar-only token: inbox tools answer AUTH_REQUIRED, no Gmail call, calendar still works", async () => {
    login([SCOPE_CALENDAR_READ]);
    const { f, urls } = stub({ items: [] });
    h.ctx.mail = createGmailProvider(deps(f));
    h.ctx.provider = createGoogleCalendarProvider(deps(f));
    const calls: [string, Record<string, unknown>][] = [
      ["inbox_search", { query: "budget" }],
      ["inbox_read_thread", { thread_id: "t1" }],
      ["inbox_triage", { proposals: [{ thread_id: "t1", priority: "high", next_action: "reply" }] }],
      ["inbox_draft_reply", { thread_id: "t1", body: "Thanks" }],
    ];
    for (const [name, args] of calls) {
      const r = await h.client.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect((r._meta as { deskhand: { error_code: string } }).deskhand.error_code, name).toBe("AUTH_REQUIRED");
      expect((r.content as { text: string }[])[0]!.text, name).toBe(`AUTH_REQUIRED: ${LOGIN}`);
    }
    expect(urls).toEqual([]);
    const cal = await h.client.callTool({
      name: "calendar_list_events",
      arguments: { time_min: "2026-11-12T00:00:00.000Z", time_max: "2026-11-14T00:00:00.000Z" },
    });
    expect(cal.isError).toBeFalsy();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/calendar/v3/");
    expect(urls.filter((u) => u.includes("/gmail/"))).toEqual([]);
  });

  it("an auth error from the adapter is the AuthRequiredError class", async () => {
    login([SCOPE_CALENDAR_READ]);
    const e = await reject(createGmailProvider(deps(stub({}).f)).profile());
    expect(e).toBeInstanceOf(AuthRequiredError);
  });
});

describe("snippets (M4b fix wave F)", () => {
  const thread = (snippet: unknown) => ({
    id: "t1",
    messages: [{ id: "m1", threadId: "t1", internalDate: "1794308400000", labelIds: ["INBOX"], snippet, payload: { mimeType: "text/plain", headers: [] } }],
  });
  it.each([
    ["it&#39;s A &amp; B", "it's A & B"],
    ["&lt;b&gt; &quot;q&quot; &#x41;", '<b> "q" A'],
    ["&amp;#39;", "&#39;"],
    ["&amp;amp;", "&amp;"],
    ["no entities", "no entities"],
  ])("%s is decoded exactly once", async (raw, shown) => {
    const t = await createGmailProvider(deps(stub(thread(raw)).f)).getThread("t1", 5);
    expect(t!.messages[0]!.snippet).toBe(shown);
  });
  it("the search summary decodes it too", async () => {
    const s = stub(thread("&amp;#39;"));
    const f = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/threads?")
        ? new Response(JSON.stringify({ threads: [{ id: "t1" }] }), { status: 200 })
        : s.f(input, init)) as typeof fetch;
    const r = await createGmailProvider(deps(f)).searchThreads("x", 5);
    expect(r.threads[0]!.snippet).toBe("&#39;");
  });
  it("a snippet that is not a string is empty", async () => {
    const t = await createGmailProvider(deps(stub(thread(7)).f)).getThread("t1", 5);
    expect(t!.messages[0]!.snippet).toBe("");
  });
});
