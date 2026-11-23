import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { redactPreview } from "../../ledger/redact.js";
import { ProviderError } from "../errors.js";
import type {
  DraftLookup,
  DraftRef,
  MailAddress,
  MailMessage,
  MailProvider,
  MailThread,
  NewDraft,
  ThreadSummary,
} from "../types.js";
import type { FixtureProviderOptions } from "./provider.js";
import type { FixtureMessage, FixtureWorld } from "./world.js";

export interface FixtureMailProvider extends MailProvider {
  readonly drafts: readonly DraftRef[];
}

const SNIPPET_CHARS = 100;
const BODY_CHARS = 20_000;
export const UNSUPPORTED_OPERATOR = "query operator not supported by the fixture provider";

const addr = (a: { address: string; name?: string | undefined }): MailAddress => ({
  address: a.address,
  name: a.name ?? "",
});

const byDate = (a: FixtureMessage, b: FixtureMessage): number => Date.parse(a.date) - Date.parse(b.date);

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const copyDraft = (d: DraftRef): DraftRef => ({ ...d, to: [...d.to], cc: [...d.cc], bcc: [...d.bcc] });

function toMessage(threadId: string, m: FixtureMessage): MailMessage {
  return {
    id: m.id,
    threadId,
    messageIdHeader: m.message_id ?? null,
    date: m.date,
    from: addr(m.from),
    replyTo: (m.reply_to ?? []).map(addr),
    to: m.to.map(addr),
    cc: (m.cc ?? []).map(addr),
    subject: m.subject,
    snippet: m.body_text.slice(0, SNIPPET_CHARS),
    bodyText: m.body_text.slice(0, BODY_CHARS),
    bodyTruncated: m.body_text.length > BODY_CHARS,
    unread: m.unread === true,
  };
}

/** Text a plain search term is matched against: subject, body and every address and name. */
function haystack(m: FixtureMessage): string {
  const people = [m.from, ...(m.reply_to ?? []), ...m.to, ...(m.cc ?? [])];
  return [m.subject, m.body_text, ...people.flatMap((p) => [p.address, p.name ?? ""])].join("\n").toLowerCase();
}

type Matcher = (messages: FixtureMessage[]) => boolean;

function compileTerm(term: string): Matcher {
  const lower = term.toLowerCase();
  if (lower === "is:unread") return (ms) => ms.some((m) => m.unread === true);
  if (lower.startsWith("from:")) {
    const needle = lower.slice("from:".length);
    return (ms) =>
      ms.some((m) => m.from.address.toLowerCase().includes(needle) || (m.from.name ?? "").toLowerCase().includes(needle));
  }
  if (term.includes(":")) throw new ProviderError("fixture mail", "searchThreads", { phrase: UNSUPPORTED_OPERATOR });
  return (ms) => ms.some((m) => haystack(m).includes(lower));
}

/**
 * The fixture world's mailbox (fixture format v2). A world without `mail` refuses every call with a fixed,
 * non-retryable ProviderError. No send method, by design.
 */
export function createFixtureMailProvider(
  world?: FixtureWorld,
  opts: FixtureProviderOptions = {},
): FixtureMailProvider {
  const mailbox = world?.mail;
  const drafts: DraftRef[] = [];
  if (!world || !mailbox) {
    const refuse = (op: string): Promise<never> =>
      Promise.reject(new ProviderError("fixture mail", op, { phrase: "no mailbox in this world" }));
    return {
      get drafts() {
        return drafts;
      },
      profile: () => refuse("profile"),
      searchThreads: () => refuse("searchThreads"),
      getThread: () => refuse("getThread"),
      threadMessageIds: () => refuse("threadMessageIds"),
      lookupDraft: () => refuse("lookupDraft"),
      createDraft: () => refuse("createDraft"),
    };
  }

  const threads = new Map(
    mailbox.threads.map((t) => [t.id, t.messages.filter((m) => m.draft !== true).sort(byDate)] as const),
  );
  const latency = world.settings.latency_ms;
  const writeLog = world.settings.write_log;
  let seq = 0;
  let draftSeq = 0;
  const delay = async (): Promise<void> => {
    if (latency > 0) await new Promise<void>((r) => setTimeout(r, latency));
  };

  return {
    get drafts() {
      return drafts;
    },

    async profile() {
      await delay();
      return { email: mailbox.owner };
    },

    async searchThreads(query, limit) {
      await delay();
      const matchers = query
        .split(/\s+/)
        .filter((t) => t !== "")
        .map(compileTerm);
      const hits: ThreadSummary[] = [];
      for (const [id, messages] of threads) {
        const latest = messages[messages.length - 1];
        if (!latest || !matchers.every((match) => match(messages))) continue;
        hits.push({
          id,
          subject: latest.subject,
          from: addr(latest.from),
          lastDate: latest.date,
          snippet: latest.body_text.slice(0, SNIPPET_CHARS),
          messageCount: messages.length,
          unread: messages.some((m) => m.unread === true),
        });
      }
      hits.sort((a, b) => Date.parse(b.lastDate) - Date.parse(a.lastDate) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { threads: hits.slice(0, limit), truncated: hits.length > limit };
    },

    async getThread(threadId, maxMessages): Promise<MailThread | null> {
      await delay();
      const messages = threads.get(threadId);
      if (!messages) return null;
      const kept = messages.length > maxMessages ? messages.slice(messages.length - maxMessages) : messages;
      return {
        id: threadId,
        messages: kept.map((m) => toMessage(threadId, m)),
        truncated: kept.length < messages.length,
      };
    },

    async threadMessageIds(threadId) {
      await delay();
      const messages = threads.get(threadId);
      return messages ? messages.map((m) => m.id) : null;
    },

    async lookupDraft(messageIdHeader): Promise<DraftLookup> {
      await delay();
      const found = drafts.find((d) => d.messageIdHeader === messageIdHeader);
      return found ? { state: "present", draft: copyDraft(found) } : { state: "absent" };
    },

    async createDraft(draft: NewDraft) {
      await delay();
      const existing = drafts.find((d) => d.messageIdHeader === draft.messageIdHeader);
      if (existing) return copyDraft(existing);
      draftSeq += 1;
      const created: DraftRef = {
        draftId: `dr_${draftSeq}`,
        messageId: `msg_dr_${draftSeq}`,
        threadId: draft.threadId,
        messageIdHeader: draft.messageIdHeader,
        to: [...draft.to],
        cc: [...draft.cc],
        bcc: [...draft.bcc],
        subject: draft.subject,
        bodySha256: sha256(draft.body),
      };
      drafts.push(created);
      if (writeLog !== undefined) {
        seq += 1;
        const line = JSON.stringify({
          seq,
          ts: world.now,
          op: "mail.createDraft",
          idempotency_key: draft.messageIdHeader,
          request: redactPreview(draft),
        });
        appendFileSync(writeLog, `${line}\n`);
      }
      opts.afterWrite?.();
      return copyDraft(created);
    },
  };
}
