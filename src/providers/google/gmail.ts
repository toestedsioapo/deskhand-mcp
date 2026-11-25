import { createHash } from "node:crypto";
import { SCOPE_GMAIL_COMPOSE, SCOPE_GMAIL_READ } from "../../config/scopes.js";
import { ProviderError } from "../errors.js";
import type { DraftRef, MailAddress, MailMessage, MailProvider, MailThread, NewDraft, ThreadSummary } from "../types.js";
import { googleRequest, type GoogleHttpDeps, type GoogleResponse } from "./http.js";
import { buildDraftMime, decodeEncodedWords, decodeEntities, header, messageBody, parseAddressList, strictRecipients } from "./mime.js";

const PROVIDER = "google gmail";
const BASE = "https://www.googleapis.com/gmail/v1/users/me";
const BODY_CHARS = 20_000;
const HIDDEN_LABELS = ["DRAFT", "TRASH", "SPAM"];
const INTERNAL_DATE = /^-?\d{1,16}$/;
/** One `<id>` of visible ASCII: no space, line break or nested bracket can reach a later References header. */
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/;
const DRAFT_LIST_PAGES = 5;
const READ_BACK_FAILED = "the draft was created but could not be read back";
const NO_DRAFT_ID = "the draft may have been created but the response had no draft id";
const TOO_MANY_DRAFTS = "too many drafts to check them all";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

const unreadable = (op: string): ProviderError => new ProviderError(PROVIDER, op, { phrase: "unreadable response" });

function okBody(op: string, res: GoogleResponse): Obj {
  if (res.status < 200 || res.status >= 300) throw new ProviderError(PROVIDER, op, { status: res.status });
  if (!isObj(res.json)) throw unreadable(op);
  return res.json;
}

/** Gmail omits `labelIds` on a message with no labels. Anything else that is not a list is unreadable. */
function labelsOf(op: string, m: Obj): string[] {
  if (m.labelIds === undefined) return [];
  if (!Array.isArray(m.labelIds)) throw unreadable(op);
  return m.labelIds.filter((l): l is string => typeof l === "string");
}

/**
 * The thread's messages that count, each with its labels. A message that cannot be identified fails the whole read:
 * dropping it would change the id set the apply re-check compares (M4b decision 7).
 */
function visibleMessages(op: string, json: Obj): { m: Obj; id: string; labels: string[] }[] {
  if (!Array.isArray(json.messages)) throw unreadable(op);
  return json.messages.flatMap((m: unknown) => {
    if (!isObj(m) || typeof m.id !== "string" || m.id === "") throw unreadable(op);
    const labels = labelsOf(op, m);
    return labels.some((l) => HIDDEN_LABELS.includes(l)) ? [] : [{ m, id: m.id, labels }];
  });
}

/** Epoch milliseconds of `internalDate`; a value no Date can hold is unreadable. */
function internalMs(op: string, m: Obj): number {
  const raw = m.internalDate;
  const ms = typeof raw === "string" && INTERNAL_DATE.test(raw) ? Number(raw) : NaN;
  if (Number.isNaN(new Date(ms).getTime())) throw unreadable(op);
  return ms;
}

const isoOrEmpty = (ms: number): string => (Number.isNaN(new Date(ms).getTime()) ? "" : new Date(ms).toISOString());

/** Sorted oldest first; `sort` is stable, so equal dates keep Gmail's order. */
function datedMessages(op: string, json: Obj) {
  return visibleMessages(op, json)
    .map((v) => ({ ...v, ms: internalMs(op, v.m) }))
    .sort((a, b) => a.ms - b.ms);
}

const addresses = (payload: unknown, name: string): MailAddress[] => parseAddressList(header(payload, name) ?? "");
const subjectOf = (payload: unknown): string => decodeEncodedWords(header(payload, "Subject") ?? "");
/** Gmail returns snippets HTML-escaped. Decoded once, so `&amp;#39;` stays the text `&#39;`. */
const snippetOf = (m: Obj): string => (typeof m.snippet === "string" ? decodeEntities(m.snippet) : "");

function messageIdOf(payload: unknown): string | null {
  const value = header(payload, "Message-ID")?.trim();
  return value !== undefined && MESSAGE_ID.test(value) ? value : null;
}

function toMessage(threadId: string, v: { m: Obj; id: string; labels: string[]; ms: number }): MailMessage {
  const payload = v.m.payload;
  const body = messageBody(payload, BODY_CHARS);
  return {
    id: v.id,
    threadId,
    messageIdHeader: messageIdOf(payload),
    date: new Date(v.ms).toISOString(),
    from: addresses(payload, "From")[0] ?? null,
    replyTo: addresses(payload, "Reply-To"),
    to: addresses(payload, "To"),
    cc: addresses(payload, "Cc"),
    subject: subjectOf(payload),
    snippet: snippetOf(v.m),
    bodyText: body.text,
    bodyTruncated: body.truncated,
    unread: v.labels.includes("UNREAD"),
    // A provider fact: the From header is written by the sender and proves nothing (decision 9).
    sentByOwner: v.labels.includes("SENT"),
  };
}

interface StoredDraft {
  ref: DraftRef;
  /** The message carries the `DRAFT` label. */
  isDraft: boolean;
}

/**
 * A `drafts.get` response as a DraftRef, with the Message-ID Gmail stored (its own; M4b live check). Recipients are
 * read strictly: anything unreadable marks the draft as differing. An unreadable `internalDate` is an empty date, which
 * sorts last among identical drafts.
 */
function storedDraft(op: string, json: Obj): StoredDraft {
  const m = json.message;
  if (typeof json.id !== "string" || json.id === "" || !isObj(m)) throw unreadable(op);
  if (typeof m.id !== "string" || m.id === "" || typeof m.threadId !== "string" || m.threadId === "" || !isObj(m.payload)) {
    throw unreadable(op);
  }
  const [to, cc, bcc] = [strictRecipients(m.payload, "To"), strictRecipients(m.payload, "Cc"), strictRecipients(m.payload, "Bcc")];
  const body = messageBody(m.payload, Number.POSITIVE_INFINITY).text.replace(/\r\n/g, "\n");
  return {
    isDraft: labelsOf(op, m).includes("DRAFT"),
    ref: {
      draftId: json.id,
      messageId: m.id,
      threadId: m.threadId,
      messageIdHeader: header(m.payload, "Message-ID") ?? "",
      date: typeof m.internalDate === "string" && INTERNAL_DATE.test(m.internalDate) ? isoOrEmpty(Number(m.internalDate)) : "",
      to: to ?? [],
      cc: cc ?? [],
      bcc: bcc ?? [],
      subject: subjectOf(m.payload),
      bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
      ...(to === null || cc === null || bcc === null ? { recipientsMalformed: true as const } : {}),
    },
  };
}

/** The Gmail adapter. Its only write is `createDraft`. No send method, by design (ADR 0001, ADR 0007). */
export function createGmailProvider(deps: GoogleHttpDeps): MailProvider {
  const get = (op: string, url: string) => googleRequest(deps, op, { service: "gmail", method: "GET", url, requiredScope: SCOPE_GMAIL_READ });
  // Encoded, so an id holding `?` or `/` reaches the allowlist as one bad segment and can never address another thread.
  const threadUrl = (id: string, query: string): string => `${BASE}/threads/${encodeURIComponent(id)}?${query}`;

  /** The draft as Gmail holds it; null when it is gone. */
  const readDraft = async (op: string, id: string): Promise<StoredDraft | null> => {
    const res = await get(op, `${BASE}/drafts/${encodeURIComponent(id)}?format=full`);
    return res.status === 404 ? null : storedDraft(op, okBody(op, res));
  };

  const summary = async (id: string): Promise<ThreadSummary | null> => {
    const op = "threads.get";
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "Subject", "Date"]) params.append("metadataHeaders", name);
    const res = await get(op, threadUrl(id, params.toString()));
    if (res.status === 404) return null; // deleted since the list
    const messages = datedMessages(op, okBody(op, res));
    const latest = messages.at(-1);
    if (latest === undefined) return null;
    return {
      id,
      subject: subjectOf(latest.m.payload),
      from: addresses(latest.m.payload, "From")[0] ?? null,
      lastDate: new Date(latest.ms).toISOString(),
      snippet: snippetOf(latest.m),
      messageCount: messages.length,
      unread: messages.some((v) => v.labels.includes("UNREAD")),
    };
  };

  return {
    async profile() {
      const op = "profile";
      const { emailAddress } = okBody(op, await get(op, `${BASE}/profile`));
      if (typeof emailAddress !== "string" || emailAddress === "") throw unreadable(op);
      return { email: emailAddress };
    },

    async searchThreads(query: string, limit: number) {
      const op = "threads.list";
      const params = new URLSearchParams({ q: query, maxResults: String(limit) });
      const json = okBody(op, await get(op, `${BASE}/threads?${params.toString()}`));
      if (json.threads !== undefined && !Array.isArray(json.threads)) throw unreadable(op);
      const threads: ThreadSummary[] = [];
      // One at a time: at most 25 small reads, and Gmail limits concurrent calls per user.
      for (const t of (json.threads ?? []) as unknown[]) {
        if (!isObj(t) || typeof t.id !== "string") throw unreadable(op);
        const s = await summary(t.id);
        if (s !== null) threads.push(s);
      }
      threads.sort((a, b) => Date.parse(b.lastDate) - Date.parse(a.lastDate) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { threads, truncated: typeof json.nextPageToken === "string" && json.nextPageToken !== "" };
    },

    async getThread(threadId: string, maxMessages: number): Promise<MailThread | null> {
      const op = "threads.get";
      const res = await get(op, threadUrl(threadId, "format=full"));
      if (res.status === 404) return null;
      const messages = datedMessages(op, okBody(op, res));
      const kept = messages.slice(Math.max(0, messages.length - maxMessages));
      return {
        id: threadId,
        messages: kept.map((v) => toMessage(threadId, v)),
        truncated: kept.length < messages.length,
      };
    },

    async threadMessageIds(threadId: string) {
      const op = "threads.get";
      const res = await get(op, threadUrl(threadId, "format=minimal"));
      if (res.status === 404) return null;
      return visibleMessages(op, okBody(op, res)).map((v) => v.id);
    },

    /** M4b live check: the draft by the id Gmail returned. Gone, or no longer a draft (sent), is null. */
    async getDraft(draftId: string): Promise<DraftRef | null> {
      const found = await readDraft("getDraft", draftId);
      return found?.isDraft ? found.ref : null;
    },

    /**
     * Every draft of the thread, from the full draft list (not search: its index can lag). A listed draft with no
     * thread id is read to learn it. Fails rather than return a partial list, so a POST never follows a missed draft.
     */
    async threadDrafts(threadId: string): Promise<DraftRef[]> {
      const op = "threadDrafts";
      const ids: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; ; page++) {
        if (page === DRAFT_LIST_PAGES) throw new ProviderError(PROVIDER, op, { phrase: TOO_MANY_DRAFTS, retryable: true });
        const params = new URLSearchParams({ maxResults: "100" });
        if (pageToken !== undefined) params.set("pageToken", pageToken);
        const listed = okBody(op, await get(op, `${BASE}/drafts?${params.toString()}`));
        if (listed.drafts !== undefined && !Array.isArray(listed.drafts)) throw unreadable(op);
        for (const d of (listed.drafts ?? []) as unknown[]) {
          if (!isObj(d) || typeof d.id !== "string" || d.id === "") throw unreadable(op);
          const t = isObj(d.message) ? d.message.threadId : undefined;
          if (t === undefined || t === threadId) ids.push(d.id);
          else if (typeof t !== "string") throw unreadable(op);
        }
        const next = listed.nextPageToken;
        if (typeof next !== "string" || next === "") break;
        pageToken = next;
      }
      const drafts: DraftRef[] = [];
      // One at a time: Gmail limits concurrent calls per user.
      for (const id of ids) {
        const found = await readDraft(op, id);
        if (found?.isDraft && found.ref.threadId === threadId) drafts.push(found.ref);
      }
      return drafts;
    },

    /**
     * One POST and no lookup of its own: the engine looks under the write claim, so nothing unbounded sits between that
     * check and this request. `singleSend` keeps the request inside the claim's hold. The draft id goes to `onCreated`
     * as soon as the 2xx names it, before the read-back, so the engine records it (M4b live check). After a 2xx the
     * draft exists, so every later failure is retryable: an auth error here must not release the claim.
     */
    async createDraft(d: NewDraft, onCreated: (draftId: string) => void): Promise<DraftRef> {
      const op = "createDraft";
      const raw = Buffer.from(buildDraftMime(d), "utf8").toString("base64url");
      const res = await googleRequest(deps, op, {
        service: "gmail",
        method: "POST",
        url: `${BASE}/drafts`,
        body: { message: { raw, threadId: d.threadId } },
        requiredScope: SCOPE_GMAIL_COMPOSE,
        singleSend: true,
      });
      if (res.status < 200 || res.status >= 300) throw new ProviderError(PROVIDER, op, { status: res.status });
      const id = isObj(res.json) ? res.json.id : undefined;
      if (typeof id !== "string" || id === "") throw new ProviderError(PROVIDER, op, { phrase: NO_DRAFT_ID, retryable: true });
      onCreated(id);
      let stored: StoredDraft | null;
      try {
        stored = await readDraft(op, id);
      } catch {
        throw new ProviderError(PROVIDER, op, { phrase: READ_BACK_FAILED, retryable: true });
      }
      if (stored === null || !stored.isDraft || stored.ref.draftId !== id) {
        throw new ProviderError(PROVIDER, op, { phrase: READ_BACK_FAILED, retryable: true });
      }
      return stored.ref;
    },
  };
}
