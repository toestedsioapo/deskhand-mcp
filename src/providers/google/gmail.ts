import { SCOPE_GMAIL_READ } from "../../config/scopes.js";
import { ProviderError } from "../errors.js";
import type { MailAddress, MailMessage, MailProvider, MailThread, ThreadSummary } from "../types.js";
import { googleRequest, type GoogleHttpDeps, type GoogleResponse } from "./http.js";
import { decodeEncodedWords, header, messageBody, parseAddressList } from "./mime.js";

const PROVIDER = "google gmail";
const BASE = "https://www.googleapis.com/gmail/v1/users/me";
const BODY_CHARS = 20_000;
const HIDDEN_LABELS = ["DRAFT", "TRASH", "SPAM"];
const INTERNAL_DATE = /^-?\d{1,16}$/;
/** One `<id>` of visible ASCII: no space, line break or nested bracket can reach a later References header. */
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/;
const NOT_YET = "mail is not available for this provider yet";

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

/** Sorted oldest first; `sort` is stable, so equal dates keep Gmail's order. */
function datedMessages(op: string, json: Obj) {
  return visibleMessages(op, json)
    .map((v) => ({ ...v, ms: internalMs(op, v.m) }))
    .sort((a, b) => a.ms - b.ms);
}

const addresses = (payload: unknown, name: string): MailAddress[] => parseAddressList(header(payload, name) ?? "");
const subjectOf = (payload: unknown): string => decodeEncodedWords(header(payload, "Subject") ?? "");
const snippetOf = (m: Obj): string => (typeof m.snippet === "string" ? m.snippet : "");

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

/** The read half of the Gmail adapter. No send method, by design (ADR 0001, ADR 0007). */
export function createGmailProvider(deps: GoogleHttpDeps): MailProvider {
  const get = (op: string, url: string) => googleRequest(deps, op, { service: "gmail", method: "GET", url, requiredScope: SCOPE_GMAIL_READ });
  // Encoded, so an id holding `?` or `/` reaches the allowlist as one bad segment and can never address another thread.
  const threadUrl = (id: string, query: string): string => `${BASE}/threads/${encodeURIComponent(id)}?${query}`;
  const refuse = (op: string): Promise<never> => Promise.reject(new ProviderError(PROVIDER, op, { phrase: NOT_YET }));

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

    // Task 3 builds these two; until then they refuse and make no call.
    lookupDraft: () => refuse("lookupDraft"),
    createDraft: () => refuse("createDraft"),
  };
}
