import { createHash } from "node:crypto";
import { z } from "zod";
import { omittedMarker } from "../ledger/redact.js";
import { ProviderError } from "../providers/errors.js";
import type { DraftRef } from "../providers/types.js";
import { untrusted } from "../util/untrusted.js";
import { isPlainLine, MAX_BODY_CHARS, normaliseBody, VISIBLE_ASCII } from "../util/sanitize.js";
import type { PlanKind } from "./plan-kinds.js";

/**
 * The `mail.create_draft_reply` plan kind (M4a, ADR 0010; docs/ledger-contract.md, "Plan shape:
 * `mail.create_draft_reply`"). The plan holds the drafted body under `draft.body` until the sweep replaces it with
 * `bodyRemoved: true`; `bodyChars` and `bodySha256` stay, and plan_hash covers the body only through `bodySha256`
 * (hashablePlan in src/ledger/canonical.ts). Display equals write: the schema accepts only what the approve diff can
 * print verbatim.
 */

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Decision 7: lowercase hex SHA-256 of `JSON.stringify` of the unique message ids, sorted by code unit. The plan stores
 * it and the apply re-check recomputes it, so a message added anywhere in the thread, or removed, changes it.
 */
export const threadMessageIdsHash = (ids: readonly string[]): string =>
  sha256Hex(JSON.stringify([...new Set(ids)].sort()));

/** The address rule (decision 4), as the tool states it when it refuses an address. */
export const ADDRESS_RULE =
  "must be an email address of at most 254 printable ASCII characters (internationalised addresses are not supported)";
/** A recipient or sender: an address, at most 254 characters, printable ASCII only (no IDN, no display name). */
export const draftAddressSchema = z
  .email({ message: ADDRESS_RULE })
  .max(254, { message: ADDRESS_RULE })
  .regex(VISIBLE_ASCII, { message: ADDRESS_RULE });
const address = draftAddressSchema;
/** True when `a` passes the address rule; only such addresses count as on a thread (decision 5). */
export const isDraftAddress = (a: string): boolean => draftAddressSchema.safeParse(a).success;
/** An RFC 5322 message id as it appears in In-Reply-To and References: `<...>`, printable ASCII, no inner `<` or `>`. */
const headerValue = z
  .string()
  .max(998)
  .regex(/^<[\x21-\x3b\x3d\x3f-\x7e]+>$/, { message: "must be a <...> message id of printable ASCII" });
/** True when `v` can be stored as an In-Reply-To or References value. */
export const isHeaderValue = (v: string): boolean => headerValue.safeParse(v).success;
/** Most References values a draft carries (the newest ones). */
export const MAX_REFERENCES = 10;
/** The plan's Message-ID field, from the idempotency key: in the plan contract, never sent (M4b live check). */
const OUR_HEADER = /^<deskhand\.[0-9a-f]{64}@deskhand\.invalid>$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_RECIPIENTS = 50;

/** The plan's Message-ID for an idempotency key. The recorded draft id, not this, identifies the draft (ARCHITECTURE). */
export const draftHeaderFor = (key: string): string => `<deskhand.${key}@deskhand.invalid>`;

/** True when `body` is the text `bodyChars` (UTF-16 length) and `bodySha256` (of its UTF-8 bytes) describe. */
function bodyMatches(body: string, bodyChars: unknown, bodySha256: unknown): boolean {
  return body.length === bodyChars && sha256Hex(body) === bodySha256;
}

/** True when both are absent, or `rationale` is the text `rationaleSha256` describes. */
function rationaleMatches(rationale: unknown, sha: unknown): boolean {
  if (rationale === undefined) return sha === undefined;
  return typeof rationale === "string" && sha256Hex(rationale) === sha;
}

const draftSchema = z
  .object({
    threadId: z.string().min(1).max(256).regex(VISIBLE_ASCII),
    messageIdHeader: z.string().regex(OUR_HEADER),
    inReplyTo: headerValue.nullable(),
    references: z.array(headerValue).max(MAX_REFERENCES),
    from: address,
    to: z.array(address).min(1).max(MAX_RECIPIENTS),
    cc: z.array(address).max(MAX_RECIPIENTS),
    bcc: z.array(address).max(MAX_RECIPIENTS),
    subject: z.string().min(1).max(250).refine(isPlainLine, { message: "must be one line of visible text" }),
    // Already normalised (LF only) and every line printable verbatim.
    body: z
      .string()
      .min(1)
      .max(MAX_BODY_CHARS)
      .refine((b) => normaliseBody(b) === b, { message: "must be at most 500 lines of visible text, LF line ends" })
      .optional(),
    bodyRemoved: z.literal(true).optional(),
    bodyChars: z.number().int().min(1).max(MAX_BODY_CHARS),
    bodySha256: z.string().regex(SHA256),
  })
  .strict()
  .superRefine((d, ctx) => {
    if ((d.body === undefined) === (d.bodyRemoved === undefined)) {
      ctx.addIssue({ code: "custom", message: "exactly one of body and bodyRemoved must be present", path: ["body"] });
    }
    if (d.body !== undefined && !bodyMatches(d.body, d.bodyChars, d.bodySha256)) {
      ctx.addIssue({ code: "custom", message: "body does not match bodyChars and bodySha256", path: ["body"] });
    }
    const all = [...d.to, ...d.cc, ...d.bcc];
    if (all.length > MAX_RECIPIENTS) {
      ctx.addIssue({ code: "custom", message: `at most ${MAX_RECIPIENTS} recipients in total`, path: ["to"] });
    }
    if (new Set(all.map((a) => a.toLowerCase())).size !== all.length) {
      ctx.addIssue({ code: "custom", message: "an address is repeated across to, cc and bcc", path: ["to"] });
    }
  });

/** Longest agent's reason, in UTF-16 code units. */
export const MAX_RATIONALE = 500;
/** The agent's reason, as the tool states it when it refuses one. */
export const RATIONALE_RULE =
  "rationale must be one line of visible text, 1 to 500 characters: no control, invisible or blank filler characters, no line breaks or tabs, single spaces only between words";
/** The agent's reason follows the subject's rule: the approver reads it exactly as it is stored. */
export const rationaleSchema = z.string().min(1).max(MAX_RATIONALE).refine(isPlainLine, { message: RATIONALE_RULE });

export const mailDraftPlanSchema = z
  .object({
    kind: z.literal("mail.create_draft_reply"),
    // Until the sweep. plan_hash covers it through rationaleSha256, which stays.
    rationale: rationaleSchema.optional(),
    rationaleSha256: z.string().regex(SHA256).optional(),
    draft: draftSchema,
    observed: z
      .object({
        latestMessageId: z.string().min(1).max(256).regex(VISIBLE_ASCII),
        // SHA-256 of the thread's whole message-id set (threadMessageIdsHash). Optional so applied M4a plans stay valid.
        messageIdsSha256: z.string().regex(SHA256).optional(),
        // Computed by the tool from the provider (never from the agent), lowercased.
        onThread: z
          .array(address.refine((a) => a === a.toLowerCase(), { message: "must be lowercase" }))
          .max(5000),
      })
      .strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.draft.bodyRemoved === true) {
      if (p.rationale !== undefined) {
        ctx.addIssue({ code: "custom", message: "a swept plan has no rationale", path: ["rationale"] });
      }
    } else if (!rationaleMatches(p.rationale, p.rationaleSha256)) {
      ctx.addIssue({ code: "custom", message: "rationale does not match rationaleSha256", path: ["rationale"] });
    }
  });

export type MailDraftPlan = z.infer<typeof mailDraftPlanSchema>;
type Draft = MailDraftPlan["draft"];

/** `[omitted <c> chars sha256:<8 hex>]`, from the stored length and hash; equals omittedMarker(body) for a valid plan. */
const bodyMarker = (d: Draft): string => `[omitted ${d.bodyChars} chars sha256:${d.bodySha256.slice(0, 8)}]`;

/** Recipients (to, cc, bcc) that are not on the thread, compared case-insensitively. */
function newRecipients(plan: MailDraftPlan): Set<string> {
  const on = new Set(plan.observed.onThread.map((a) => a.toLowerCase()));
  return new Set([...plan.draft.to, ...plan.draft.cc, ...plan.draft.bcc].filter((a) => !on.has(a.toLowerCase())));
}

const newRecipientsLine = (n: number): string =>
  n === 0 ? "new recipients: none" : `new recipients: ${n} not on this thread`;

/** Address sets compared case-insensitively, order and repeats ignored. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const norm = (xs: readonly string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].sort();
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const DRAFT_DIFFERS = "a draft with this action's id exists but differs from the approved plan";
/** Re-check phrases (decision 8 and the account check); apply prefixes each with `The world changed since planning: `. */
export const THREAD_CHANGED = "the thread's messages changed since planning";
export const THREAD_UNVERIFIED = "the plan has no record of the thread's messages";
export const THREAD_GONE = "the thread no longer exists";
export const THREAD_NEW_MESSAGE = "the thread has a new message since planning";
export const ACCOUNT_CHANGED = "the mailbox account changed since planning";
/** The draft id this action recorded no longer resolves: the user deleted (or sent) the draft. It is never recreated. */
export const DRAFT_DELETED = "a draft with this action's id was created and later deleted";

/** The thread, the subject, exactly readable address sets and the body hash all equal the approved plan. */
function sameContent(plan: MailDraftPlan, r: DraftRef): boolean {
  const d = plan.draft;
  return (
    r.threadId === d.threadId &&
    r.subject === d.subject &&
    r.recipientsMalformed !== true &&
    sameSet(r.to, d.to) &&
    sameSet(r.cc, d.cc) &&
    sameSet(r.bcc, d.bcc) &&
    r.bodySha256 === d.bodySha256
  );
}

/** Oldest stored first; an unreadable date sorts last; equal dates by draft id, so the order is total. */
function oldestFirst(a: DraftRef, b: DraftRef): number {
  const t = (d: DraftRef): number => {
    const ms = Date.parse(d.date);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  };
  return t(a) - t(b) || (a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0);
}

const ID_NOT_RECORDED = "the draft was created but its id could not be recorded";
const ID_TAKEN = "the draft's id is already recorded by another action";

export const mailCreateDraftReply: PlanKind<MailDraftPlan, DraftRef> = {
  kind: "mail.create_draft_reply",
  schema: mailDraftPlanSchema,
  phrases: { differs: DRAFT_DIFFERS, deleted: DRAFT_DELETED },
  // Gmail has no unique key on a draft (M4b decision 8), and it rewrites the Message-ID we send (M4b live check).
  needsWriteClaim: true,

  // Decision 3. The approver sees every body row, each behind `  > `; the agent gets one omitted row instead.
  // Ruling R3: the agent audience also gets the subject and every address value as its omitted marker (mailbox
  // text, never in clear outside an untrusted wrapper); each line keeps its shape.
  renderDiff(plan, _viewerTimeZone, audience) {
    const d = plan.draft;
    const fresh = newRecipients(plan);
    const show = (v: string): string => (audience === "approver" ? v : omittedMarker(v));
    const lines = [
      "create draft reply (not sent; Deskhand cannot send mail)",
      `thread: ${show(d.threadId)}`,
      `in reply to message: ${show(plan.observed.latestMessageId)}`,
      `from: ${show(d.from)}`,
      `subject: ${show(d.subject)}`,
      ...(plan.rationale === undefined ? [] : [`agent's reason: ${show(plan.rationale)}`]),
      newRecipientsLine(fresh.size),
    ];
    for (const [label, list] of [
      ["to", d.to],
      ["cc", d.cc],
      ["bcc", d.bcc],
    ] as const) {
      lines.push(`${label}: ${list.length} recipient(s)`);
      for (const a of list) lines.push(`  ${show(a)}${fresh.has(a) ? "  (new: not on this thread)" : ""}`);
    }
    const tag = `${d.bodyChars} chars sha256:${d.bodySha256.slice(0, 8)}`;
    if (d.body === undefined) {
      lines.push(`body removed after the action ended (${tag})`);
      return lines;
    }
    const bodyLines = d.body.split("\n");
    lines.push(`body: ${bodyLines.length} lines, ${d.bodyChars} chars, sha256:${d.bodySha256.slice(0, 8)}`);
    if (audience === "approver") for (const l of bodyLines) lines.push(l === "" ? "  >" : `  > ${l}`);
    else lines.push(`  ${bodyMarker(d)}`);
    lines.push("end of body");
    return lines;
  },

  approveSummary(plan) {
    const d = plan.draft;
    // The subject is sender-controlled and may wrap, so it comes first: the last rows above the prompt are fixed text.
    return [
      `subject: ${d.subject}`,
      d.body === undefined ? "body: removed" : `body: ${d.body.split("\n").length} lines, ${d.bodyChars} chars`,
      `summary: to ${d.to.length}, cc ${d.cc.length}, bcc ${d.bcc.length}`,
      newRecipientsLine(newRecipients(plan).size),
    ];
  },

  // Ruling R1: a present body that is not the text bodyChars / bodySha256 describe was edited in the ledger (the
  // hash leaves the body out, so only this catches it). Runs on the raw stored plan, before the schema.
  tampered(raw) {
    if (!isObject(raw) || !isObject(raw["draft"])) return false;
    const d = raw["draft"];
    if (typeof d["body"] !== "string") return false;
    // The hash leaves the reason out too: while the body is present, the reason must be the one the hash describes.
    return !bodyMatches(d["body"], d["bodyChars"], d["bodySha256"]) || !rationaleMatches(raw["rationale"], raw["rationaleSha256"]);
  },

  // A plan whose body was swept can never be written (decision 2).
  writable: (plan) => plan.draft.body !== undefined,

  // First, the mailbox is still the account the plan was made in: the draft says it is `from` that address, and the
  // thread id and onThread belong to that mailbox. Then decision 8: the thread still exists and its latest non-draft
  // message (getThread leaves drafts out) is the one the plan replies to.
  async recheck(plan, { mail }) {
    const { email } = await mail.profile();
    if (email.toLowerCase() !== plan.draft.from.toLowerCase()) return { ok: false, reason: ACCOUNT_CHANGED };
    const ids = await mail.threadMessageIds(plan.draft.threadId);
    const thread = ids === null ? null : await mail.getThread(plan.draft.threadId, 1);
    const latest = thread?.messages.at(-1);
    if (ids === null || !thread || !latest) return { ok: false, reason: THREAD_GONE };
    if (latest.id !== plan.observed.latestMessageId) return { ok: false, reason: THREAD_NEW_MESSAGE };
    // Any other difference in the whole set (a backdated message, a removed one) is stale too (decision 7).
    if (plan.observed.messageIdsSha256 === undefined) return { ok: false, reason: THREAD_UNVERIFIED };
    if (threadMessageIdsHash(ids) !== plan.observed.messageIdsSha256) return { ok: false, reason: THREAD_CHANGED };
    return { ok: true };
  },

  /**
   * M4b live check (owner decision 2026-11-25). The draft id this action recorded decides: gone is `cancelled`, never
   * recreated, and an edited draft fails `matches`. With no id recorded, only an action that took a write claim (so it
   * may have POSTed: a crash or an ambiguous failure before the id came back) looks at the thread's drafts with the
   * approved content, oldest first; the first one no other action recorded is adopted, and recorded as this action's
   * before it is returned. An action that never claimed has written nothing to recover, so it never adopts a draft that
   * another action's in-flight POST just created (M4b re-review).
   */
  async lookupExisting(plan, _key, { mail }, writes) {
    const recorded = writes.landed()[0];
    if (recorded !== undefined) {
      const draft = await mail.getDraft(recorded);
      return draft === null ? { state: "cancelled" } : { state: "present", value: draft };
    }
    if (!writes.mayHaveWritten()) return { state: "absent" };
    const candidates = (await mail.threadDrafts(plan.draft.threadId)).filter((d) => sameContent(plan, d)).sort(oldestFirst);
    for (const draft of candidates) {
      if (writes.record(draft.draftId)) return { state: "present", value: draft };
    }
    return { state: "absent" };
  },

  // The plan's own Message-ID (an integrity check on the stored plan), then the approved content. The stored draft's
  // Message-ID is the provider's own and is not compared (M4b live check).
  matches(plan, key, r) {
    return plan.draft.messageIdHeader === draftHeaderFor(key) && sameContent(plan, r);
  },

  async execute(plan, key, { mail }, writes) {
    const d = plan.draft;
    // Never reached through the gates (7a refuses a swept plan; the tool derives the header from the key); a plain
    // Error is a definite failure, so the plan fails without a write.
    if (d.body === undefined) throw new Error("the plan's body was removed; it cannot be written");
    if (d.messageIdHeader !== draftHeaderFor(key)) throw new Error("the plan's Message-ID is not this action's");
    return mail.createDraft(
      {
        threadId: d.threadId,
        idempotencyKey: key,
        inReplyTo: d.inReplyTo,
        references: d.references,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        body: d.body,
      },
      // The draft exists now: any failure to record its id is retryable, so the claim is kept and the plan stays
      // approved (never `failed` with a draft left behind). Another action may have adopted it in the window before
      // the record; it is then not this action's draft, and a retry after the hold writes this action's own.
      (draftId) => {
        let recorded: boolean;
        try {
          recorded = writes.record(draftId);
        } catch {
          throw new ProviderError("mail draft", "record", { phrase: ID_NOT_RECORDED, retryable: true });
        }
        if (!recorded) throw new ProviderError("mail draft", "record", { phrase: ID_TAKEN, retryable: true });
      },
    );
  },

  // Ids, header, addresses, subject and the body hash; never the body.
  store: (r) => ({
    draftId: r.draftId,
    messageId: r.messageId,
    threadId: r.threadId,
    messageIdHeader: r.messageIdHeader,
    to: r.to,
    cc: r.cc,
    bcc: r.bcc,
    subject: r.subject,
    bodySha256: r.bodySha256,
  }),

  // Mailbox text is untrusted data from the plan's thread; the body is the omitted marker.
  output(plan, stored) {
    const r = stored as DraftRef;
    const source = `mail:${plan.draft.threadId}`;
    const wrap = (s: string) => untrusted(source, s);
    return {
      draft_id: r.draftId,
      message_id: r.messageId,
      thread_id: r.threadId,
      subject: wrap(r.subject),
      to: r.to.map(wrap),
      cc: r.cc.map(wrap),
      bcc: r.bcc.map(wrap),
      body: bodyMarker(plan.draft),
    };
  },

  // The stored plan with every mailbox-derived field (thread and message ids, Message-IDs, subject, addresses) and the
  // agent's reason wrapped as untrusted, and the body as its omitted marker (a swept plan has neither body nor reason).
  // Spreads keep the stored key order.
  explainPlan(plan) {
    const d = plan.draft;
    const wrap = (s: string) => untrusted(`mail:${d.threadId}`, s);
    return {
      ...plan,
      ...(plan.rationale === undefined ? {} : { rationale: wrap(plan.rationale) }),
      draft: {
        ...d,
        threadId: wrap(d.threadId),
        // Message-IDs come from mail headers, so the sender controls them.
        inReplyTo: d.inReplyTo === null ? null : wrap(d.inReplyTo),
        references: d.references.map(wrap),
        from: wrap(d.from),
        to: d.to.map(wrap),
        cc: d.cc.map(wrap),
        bcc: d.bcc.map(wrap),
        subject: wrap(d.subject),
        ...(d.body === undefined ? {} : { body: bodyMarker(d) }),
      },
      observed: {
        ...plan.observed,
        latestMessageId: wrap(plan.observed.latestMessageId),
        onThread: plan.observed.onThread.map(wrap),
      },
    };
  },
};
