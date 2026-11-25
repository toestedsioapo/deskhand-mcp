import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailCreateDraftReply, type MailDraftPlan } from "../src/approval/mail-draft-kind.js";
import { SCOPE_GMAIL_COMPOSE, SCOPE_GMAIL_READ } from "../src/config/scopes.js";
import { AuthRequiredError, ProviderError } from "../src/providers/errors.js";
import { createGmailProvider } from "../src/providers/google/gmail.js";
import { GOOGLE_ENDPOINTS } from "../src/providers/google/oauth.js";
import { buildDraftMime, decodeEncodedWords } from "../src/providers/google/mime.js";
import { writeToken } from "../src/providers/google/token-store.js";
import type { NewDraft } from "../src/providers/types.js";
import { makeTempHome } from "./helpers/home.js";
import { replayFetch, type Replay } from "./helpers/replay-fetch.js";

const NOW = new Date("2026-11-14T10:00:00.000Z");
const KEY = "088afa7571116bd6a8f7b781318e85bd9a37eed81b5140bfe630e9f752558fa8";
const OURS = `<deskhand.${KEY}@deskhand.invalid>`;
const UPGRADE = "Google write access is not granted. Run: deskhand auth upgrade";
const READ_BACK = "google gmail createDraft failed: the draft was created but could not be read back";
const NO_ID = "google gmail createDraft failed: the draft may have been created but the response had no draft id";
const TOO_MANY = "google gmail threadDrafts failed: too many drafts to check them all";
const GMAIL_HEADER = "<gmail-assigned-1@example.com>";
const BODY = "Thanks Ana,\n\nThe numbers look right.";

const DRAFT: NewDraft = {
  threadId: "t-reply",
  idempotencyKey: KEY,
  inReplyTo: "<r2@example.com>",
  references: ["<r1@example.com>", "<r2@example.com>"],
  to: ["ana@example.com"],
  cc: [],
  bcc: ["boss@example.com"],
  subject: "Re: Q4 budget",
  body: BODY,
};

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
  login([SCOPE_GMAIL_READ, SCOPE_GMAIL_COMPOSE]);
});
afterEach(() => {
  try {
    replay?.verify();
  } finally {
    replay = undefined;
    home.cleanup();
  }
});

const provider = (names: string[]) => {
  replay = replayFetch(names);
  const f = replay.fetch;
  return createGmailProvider({ fetch: f, configDir: home.home, now: () => NOW, oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW } });
};
const reject = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};
const posts = () => replay!.seen.filter((r) => r.method === "POST" && r.url.includes("/gmail/"));
const expectRetryable = (e: Error, message: string) => {
  expect(e).toBeInstanceOf(ProviderError);
  expect(e.message).toBe(message);
  expect((e as ProviderError).retryable).toBe(true);
};

describe("buildDraftMime", () => {
  it("exact output for an ASCII subject, headers in the fixed order and no From", () => {
    const mime = buildDraftMime({ ...DRAFT, cc: ["cc@example.com"], body: "Hi\nthere" });
    expect(mime).toBe(
      [
        "In-Reply-To: <r2@example.com>",
        "References: <r1@example.com> <r2@example.com>",
        "To: ana@example.com",
        "Cc: cc@example.com",
        "Bcc: boss@example.com",
        "Subject: Re: Q4 budget",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        "SGkNCnRoZXJl",
      ].join("\r\n"),
    );
  });

  it("leaves out In-Reply-To, References, Cc and Bcc when they are empty", () => {
    const mime = buildDraftMime({ ...DRAFT, inReplyTo: null, references: [], bcc: [] });
    expect(mime.split("\r\n\r\n")[0]!.split("\r\n").map((l) => l.split(":")[0])).toEqual([
      "To",
      "Subject",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
  });

  it("exact output for a non-ASCII subject", () => {
    const mime = buildDraftMime({ ...DRAFT, subject: "Re: Presupuesto café" });
    const word = Buffer.from("Re: Presupuesto café", "utf8").toString("base64");
    expect(mime).toContain(`\r\nSubject: =?UTF-8?B?${word}?=\r\nMIME-Version: 1.0\r\n`);
  });

  it("a long non-ASCII subject: words of at most 75 characters, folded, whole characters, decoding to the subject", () => {
    const subject = "Prévision é€😀 ".repeat(16).trim();
    const mime = buildDraftMime({ ...DRAFT, subject });
    const line = /\r\nSubject: ([\s\S]*?)\r\nMIME-Version/.exec(mime)![1]!;
    const words = line.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(75);
      const b64 = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w)![1]!;
      expect(Buffer.from(b64, "base64").toString("utf8")).not.toContain("�");
    }
    expect(decodeEncodedWords(line.replace(/\r\n /g, " "))).toBe(subject);
  });

  it("an ASCII subject that reads as an encoded word is encoded, so a mail client shows the approved text", () => {
    const subject = "Re: =?UTF-8?B?V2lyZSB0aGUgbW9uZXk=?=";
    const line = /\r\nSubject: (.*?)\r\nMIME-Version/.exec(buildDraftMime({ ...DRAFT, subject }))![1]!;
    expect(line).not.toBe(subject);
    expect(decodeEncodedWords(line)).toBe(subject);
  });

  it("the body is CRLF, base64, in lines of 76, and round-trips", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} of the reply, café`).join("\n");
    const encoded = buildDraftMime({ ...DRAFT, body }).split("\r\n\r\n")[1]!;
    const lines = encoded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.slice(0, -1).every((l) => l.length === 76)).toBe(true);
    expect(lines.at(-1)!.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(lines.join(""), "base64").toString("utf8")).toBe(body.replace(/\n/g, "\r\n"));
  });

  it("a long recipient list is folded under the 998 line limit", () => {
    const to = Array.from({ length: 50 }, (_, i) => `recipient-with-a-long-name-${i}@example.com`);
    const head = buildDraftMime({ ...DRAFT, to }).split("\r\n\r\n")[0]!;
    const value = /(?:^|\r\n)To: ([\s\S]*?)\r\nBcc:/.exec(head)![1]!;
    expect(value.split("\r\n").length).toBeGreaterThan(1);
    expect(`To: ${value}`.split("\r\n").every((l) => l.length <= 76)).toBe(true);
    expect(value.replace(/\r\n /g, " ").split(", ")).toEqual(to);
  });

  it("never carries a Message-ID or the idempotency key: Gmail assigns its own (M4b live check)", () => {
    const mime = buildDraftMime(DRAFT);
    expect(mime).not.toMatch(/^message-id:/im);
    expect(mime).not.toContain(KEY);
  });

  for (const [name, over] of [
    ["subject with CR", { subject: "a\rBcc: x@example.com" }],
    ["subject with LF", { subject: "a\nBcc: x@example.com" }],
    ["subject with NUL", { subject: "a\0b" }],
    ["address with LF", { to: ["a@example.com\nBcc: x@example.com"] }],
    ["bcc with CR", { bcc: ["a@example.com\r"] }],
    ["In-Reply-To with LF", { inReplyTo: "<a@example.com>\nBcc: x@example.com" }],
    ["References with CR", { references: ["<a@example.com>\r"] }],
  ] as [string, Partial<NewDraft>][]) {
    it(`a header value with a line break or NUL throws: ${name}`, () => {
      let e: unknown;
      try {
        buildDraftMime({ ...DRAFT, ...over });
      } catch (err) {
        e = err;
      }
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as Error).message).toBe("google gmail createDraft failed: invalid header value");
    });
  }
});

describe("createDraft", () => {
  const created: string[] = [];
  const onCreated = (id: string): void => void created.push(id);
  beforeEach(() => {
    created.length = 0;
  });

  it("sends one POST whose raw decodes to the MIME, reports the id, then returns what Gmail stored", async () => {
    const p = provider(["gmail-drafts-create-200", "gmail-draft-get-gmail-header"]);
    const r = await p.createDraft(DRAFT, onCreated);
    expect(replay!.seen.map((q) => q.method)).toEqual(["POST", "GET"]);
    const sent = JSON.parse(posts()[0]!.body!) as { message: { raw: string; threadId: string } };
    expect(sent.message.threadId).toBe("t-reply");
    expect(sent.message.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(sent.message.raw, "base64url").toString("utf8")).toBe(buildDraftMime(DRAFT));
    expect(created).toEqual(["dr-1"]);
    expect(r).toEqual({
      draftId: "dr-1",
      messageId: "dm-1",
      threadId: "t-reply",
      messageIdHeader: GMAIL_HEADER,
      date: new Date(1794308400000).toISOString(),
      to: ["ana@example.com"],
      cc: [],
      bcc: ["boss@example.com"],
      subject: "Re: Q4 budget",
      bodySha256: createHash("sha256").update(BODY, "utf8").digest("hex"),
    });
  });

  it("a callback that fails after the 2xx is a retryable error, never a definite one: the draft exists", async () => {
    const e = await reject(
      provider(["gmail-drafts-create-200"]).createDraft(DRAFT, () => {
        throw new Error("database is locked");
      }),
    );
    expectRetryable(e, "google gmail createDraft failed: the draft was created but its id could not be recorded");
    expect(posts()).toHaveLength(1);
  });

  it("a read-only token makes no POST and throws the upgrade sentence", async () => {
    login([SCOPE_GMAIL_READ]);
    const p = provider([]);
    const e = await reject(p.createDraft(DRAFT, onCreated));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(UPGRADE);
    expect(replay!.seen).toEqual([]);
    expect(created).toEqual([]);
  });

  it("403 insufficientPermissions is the upgrade sentence", async () => {
    const e = await reject(provider(["gmail-drafts-create-403"]).createDraft(DRAFT, onCreated));
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect(e.message).toBe(UPGRADE);
    expect(e.message).not.toContain("FAKE-TOKEN");
    expect(created).toEqual([]);
  });

  it("a 401 refreshes the token and gives exactly one POST (singleSend), as a retryable error", async () => {
    writeFileSync(
      join(home.home, "client_secret.json"),
      JSON.stringify({ installed: { client_id: "cid.apps.googleusercontent.com", client_secret: "CLIENT-SECRET-XYZ" } }),
    );
    const p = provider(["gmail-drafts-create-401", "oauth-refresh"]);
    const e = await reject(p.createDraft(DRAFT, onCreated));
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).retryable).toBe(true);
    expect(posts()).toHaveLength(1);
  });

  it("a 500 is retryable, reports no id, and its body never reaches the message", async () => {
    const e = await reject(provider(["gmail-drafts-create-500"]).createDraft(DRAFT, onCreated));
    expect((e as ProviderError).retryable).toBe(true);
    expect(e.message).not.toContain("FAKE-TOKEN");
    expect(created).toEqual([]);
  });

  it("a 2xx with no usable draft id is retryable and reports no id: the draft probably landed", async () => {
    expectRetryable(await reject(provider(["gmail-drafts-create-200-no-id"]).createDraft(DRAFT, onCreated)), NO_ID);
    expect(created).toEqual([]);
  });

  for (const name of ["gmail-draft-get-404", "gmail-draft-get-unusable", "gmail-draft-get-not-draft"]) {
    it(`a failed read-back after a 2xx is retryable, and the id was already reported: ${name}`, async () => {
      expectRetryable(await reject(provider(["gmail-drafts-create-200", name]).createDraft(DRAFT, onCreated)), READ_BACK);
      expect(posts()).toHaveLength(1);
      expect(created).toEqual(["dr-1"]);
    });
  }

  it("an auth error on the read-back is also the retryable error, so the claim is not released", async () => {
    login([SCOPE_GMAIL_COMPOSE]); // the POST is allowed; the read-back's scope is missing
    const e = await reject(provider(["gmail-drafts-create-200"]).createDraft(DRAFT, onCreated));
    expect(e).not.toBeInstanceOf(AuthRequiredError);
    expectRetryable(e, READ_BACK);
    expect(created).toEqual(["dr-1"]);
  });
});

describe("getDraft", () => {
  it("reads the draft by id: decoded subject, and the body hash after CRLF becomes LF", async () => {
    const r = await provider(["gmail-draft-get-encoded"]).getDraft("dr-1");
    expect(r).toMatchObject({
      draftId: "dr-1",
      subject: "Re: Presupuesto café",
      bodySha256: createHash("sha256").update(BODY, "utf8").digest("hex"),
    });
  });

  it("keeps the Message-ID Gmail stored", async () => {
    expect(await provider(["gmail-draft-get-gmail-header"]).getDraft("dr-1")).toMatchObject({ messageIdHeader: GMAIL_HEADER });
  });

  it("a 404 is null: the draft was deleted or sent", async () => {
    expect(await provider(["gmail-draft-get-404"]).getDraft("dr-1")).toBeNull();
  });

  it("a message that is no longer a draft is null", async () => {
    expect(await provider(["gmail-draft-get-not-draft"]).getDraft("dr-1")).toBeNull();
  });

  it("an unusable read is an error, never null", async () => {
    expect(await reject(provider(["gmail-draft-get-unusable"]).getDraft("dr-1"))).toBeInstanceOf(ProviderError);
  });

  it("an id holding / or ? is one encoded segment, refused by the allowlist before any request", async () => {
    const p = provider([]);
    expect(await reject(p.getDraft("a/b?c"))).toBeInstanceOf(ProviderError);
    expect(replay!.seen).toEqual([]);
  });
});

describe("threadDrafts", () => {
  it("lists every draft page by page (no search, so no index lag) and reads only the thread's drafts", async () => {
    const r = await provider(["gmail-drafts-page-1", "gmail-drafts-page-2", "gmail-draft-get-gmail-header"]).threadDrafts("t-reply");
    expect(r.map((d) => d.draftId)).toEqual(["dr-1"]);
    expect(r[0]).toMatchObject({ messageIdHeader: GMAIL_HEADER, bcc: ["boss@example.com"] });
    for (const q of replay!.seen) expect(new URL(q.url).searchParams.has("q")).toBe(false);
  });

  it("no drafts at all is an empty list", async () => {
    expect(await provider(["gmail-drafts-list-none"]).threadDrafts("t-reply")).toEqual([]);
  });

  it("returns every draft of the thread with its date", async () => {
    const r = await provider(["gmail-drafts-list-two", "gmail-draft-get-2-gmail-header", "gmail-draft-get-gmail-header"]).threadDrafts(
      "t-reply",
    );
    expect(r.map((d) => [d.draftId, d.date])).toEqual([
      ["dr-2", new Date(1794308460000).toISOString()],
      ["dr-1", new Date(1794308400000).toISOString()],
    ]);
  });

  it("a listed draft with no thread id is read to learn its thread", async () => {
    const r = await provider(["gmail-drafts-list-no-thread", "gmail-draft-get-gmail-header"]).threadDrafts("t-reply");
    expect(r.map((d) => d.draftId)).toEqual(["dr-1"]);
  });

  it("a draft deleted between the list and its read is left out", async () => {
    expect(await provider(["gmail-drafts-list-reply", "gmail-draft-get-404"]).threadDrafts("t-reply")).toEqual([]);
  });

  it("an unusable read of a listed draft is an error, so no POST follows", async () => {
    const e = await reject(provider(["gmail-drafts-list-reply", "gmail-draft-get-unusable"]).threadDrafts("t-reply"));
    expect(e).toBeInstanceOf(ProviderError);
  });

  it.each([{ drafts: "nope" }, { drafts: [{ id: "dr-1", message: { threadId: 7 } }] }, { drafts: [{ message: {} }] }])(
    "an unreadable list is an error, never an empty list: %j",
    async (body) => {
      const f = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
      const p = createGmailProvider({ fetch: f, configDir: home.home, now: () => NOW, oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW } });
      expect(await reject(p.threadDrafts("t-reply"))).toBeInstanceOf(ProviderError);
    },
  );

  it("more than five pages is a retryable error, never a partial list", async () => {
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ drafts: [{ id: "x", message: { id: "y", threadId: "t-other" } }], nextPageToken: "more" }), {
        status: 200,
      });
    }) as typeof fetch;
    const p = createGmailProvider({ fetch: f, configDir: home.home, now: () => NOW, oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW } });
    expectRetryable(await reject(p.threadDrafts("t-reply")), TOO_MANY);
    expect(urls).toHaveLength(5);
  });
});

describe("a stored draft's recipients are read strictly (M4b fix wave D)", () => {
  type Hdr = { name: string; value: string };
  const stored = (headers: Hdr[]) => {
    const body = {
      id: "dr-1",
      message: {
        id: "dm-1",
        threadId: "t-reply",
        labelIds: ["DRAFT"],
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Message-ID", value: GMAIL_HEADER }, { name: "Subject", value: "Re: Q4 budget" }, ...headers],
          body: { data: Buffer.from(BODY, "utf8").toString("base64url") },
        },
      },
    };
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes("/drafts/dr-1") ? body : { drafts: [] }), { status: 200 });
    }) as typeof fetch;
    return createGmailProvider({ fetch: f, configDir: home.home, now: () => NOW, oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: () => NOW } });
  };
  const planFor = (to: string[], cc: string[], bcc: string[]) =>
    ({
      draft: { ...DRAFT, messageIdHeader: OURS, to, cc, bcc, bodySha256: createHash("sha256").update(BODY, "utf8").digest("hex") },
    }) as unknown as MailDraftPlan;
  const found = async (headers: Hdr[]) => {
    const r = await stored(headers).getDraft("dr-1");
    if (r === null) throw new Error("not found");
    return r;
  };
  /** The header's value as buildDraftMime folds it: Gmail may return it with the line breaks in place. */
  const folded = (name: string, list: string[]): string => {
    const head = buildDraftMime({
      ...DRAFT,
      to: name === "To" ? list : ["x@example.com"],
      cc: name === "Cc" ? list : [],
      bcc: name === "Bcc" ? list : [],
    }).split("\r\n\r\n")[0]!;
    return new RegExp(`(?:^|\\r\\n)${name}: (.*(?:\\r\\n .*)*)`).exec(head)![1]!;
  };
  const APPROVED = () => planFor(["ana@example.com"], [], ["boss@example.com"]);

  it("a folded 24-recipient draft matches", async () => {
    const addr = (k: string) => Array.from({ length: 8 }, (_, i) => `someone.with.a.long.name+${k}${i}@example.com`);
    const [to, cc, bcc] = [addr("to"), addr("cc"), addr("bcc")];
    expect(folded("To", to)).toContain("\r\n ");
    const d = await found([
      { name: "To", value: folded("To", to) },
      { name: "Cc", value: folded("Cc", cc) },
      { name: "Bcc", value: folded("Bcc", bcc) },
    ]);
    expect(mailCreateDraftReply.matches(planFor(to, cc, bcc), KEY, d)).toBe(true);
  });

  it("a display name and a trailing comma still match", async () => {
    const d = await found([
      { name: "To", value: '"Ana A" <ana@example.com>,' },
      { name: "Bcc", value: "boss@example.com" },
    ]);
    expect(mailCreateDraftReply.matches(APPROVED(), KEY, d)).toBe(true);
  });

  it.each([
    ["To", 'ana@example.com, "evil"@evil.test'],
    ["To", "ana@example.com, not an address"],
    ["To", "ana@example.com, <unterminated@evil.test"],
    ["To", 'ana@example.com, "unterminated'],
    ["To", "ana@example.com, (unterminated"],
    ["To", "ana@example.com, team: evil@evil.test"],
    ["To", "ana@example.com, team: ana@example.com;"],
    ["To", "ana@example.com <ana@example.com> extra@evil.test"],
    ["Cc", '"evil"@evil.test'],
    ["Bcc", 'boss@example.com, "evil"@evil.test'],
  ])("%s: %s differs", async (name, value) => {
    const others: Hdr[] = [
      ...(name === "To" ? [] : [{ name: "To", value: "ana@example.com" }]),
      ...(name === "Bcc" ? [] : [{ name: "Bcc", value: "boss@example.com" }]),
    ];
    const d = await found([{ name, value }, ...others]);
    expect(mailCreateDraftReply.matches(APPROVED(), KEY, d)).toBe(false);
  });

  it.each([
    ["To", "ana@example.com"],
    ["to", "evil@evil.test"],
    ["BCC", "boss@example.com"],
  ])("a repeated header (%s: %s) differs", async (name, value) => {
    const d = await found([{ name: "To", value: "ana@example.com" }, { name: "Bcc", value: "boss@example.com" }, { name, value }]);
    expect(mailCreateDraftReply.matches(APPROVED(), KEY, d)).toBe(false);
  });

  it("a repeated Cc header differs", async () => {
    const d = await found([
      { name: "To", value: "ana@example.com" },
      { name: "Bcc", value: "boss@example.com" },
      { name: "Cc", value: "" },
      { name: "cc", value: "" },
    ]);
    expect(mailCreateDraftReply.matches(APPROVED(), KEY, d)).toBe(false);
  });
});
