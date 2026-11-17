import { createHash } from "node:crypto";
import { z } from "zod";
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

/** A recipient or sender: an address, at most 254 characters, printable ASCII only (no IDN, no display name). */
const address = z.email().max(254).regex(VISIBLE_ASCII);
/** An RFC 5322 message id as it appears in In-Reply-To and References: `<...>`, printable ASCII, no inner `<` or `>`. */
const headerValue = z
  .string()
  .max(998)
  .regex(/^<[\x21-\x3b\x3d\x3f-\x7e]+>$/, { message: "must be a <...> message id of printable ASCII" });
/** The draft's own Message-ID, derived from the idempotency key. */
const OUR_HEADER = /^<deskhand\.[0-9a-f]{64}@deskhand\.invalid>$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_RECIPIENTS = 50;

/** The draft's Message-ID for an idempotency key (ARCHITECTURE, "Gmail draft idempotency"). */
export const draftHeaderFor = (key: string): string => `<deskhand.${key}@deskhand.invalid>`;

/** True when `body` is the text `bodyChars` (UTF-16 length) and `bodySha256` (of its UTF-8 bytes) describe. */
function bodyMatches(body: string, bodyChars: unknown, bodySha256: unknown): boolean {
  return body.length === bodyChars && sha256Hex(body) === bodySha256;
}

const draftSchema = z
  .object({
    threadId: z.string().min(1).max(256).regex(VISIBLE_ASCII),
    messageIdHeader: z.string().regex(OUR_HEADER),
    inReplyTo: headerValue.nullable(),
    references: z.array(headerValue).max(10),
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

export const mailDraftPlanSchema = z
  .object({
    kind: z.literal("mail.create_draft_reply"),
    rationale: z.string().optional(),
    draft: draftSchema,
    observed: z
      .object({
        latestMessageId: z.string().min(1).max(256).regex(VISIBLE_ASCII),
        // Computed by the tool from the provider (never from the agent), lowercased.
        onThread: z
          .array(address.refine((a) => a === a.toLowerCase(), { message: "must be lowercase" }))
          .max(5000),
      })
      .strict(),
  })
  .strict();

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
/** Never used: a mail provider cannot report a deleted draft (decision 7). Kept so every kind names both phrases. */
export const DRAFT_DELETED = "a draft with this action's id was created and later deleted";

export const mailCreateDraftReply: PlanKind<MailDraftPlan, DraftRef> = {
  kind: "mail.create_draft_reply",
  schema: mailDraftPlanSchema,
  phrases: { differs: DRAFT_DIFFERS, deleted: DRAFT_DELETED },

  // Decision 3. The approver sees every body row, each behind `  > `; the agent gets one omitted row instead.
  renderDiff(plan, _viewerTimeZone, audience) {
    const d = plan.draft;
    const fresh = newRecipients(plan);
    const lines = [
      "create draft reply (not sent; Deskhand cannot send mail)",
      `thread: ${d.threadId}`,
      `in reply to message: ${plan.observed.latestMessageId}`,
      `from: ${d.from}`,
      `subject: ${d.subject}`,
      newRecipientsLine(fresh.size),
    ];
    for (const [label, list] of [
      ["to", d.to],
      ["cc", d.cc],
      ["bcc", d.bcc],
    ] as const) {
      lines.push(`${label}: ${list.length} recipient(s)`);
      for (const a of list) lines.push(`  ${a}${fresh.has(a) ? "  (new: not on this thread)" : ""}`);
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
    return [
      `summary: to ${d.to.length}, cc ${d.cc.length}, bcc ${d.bcc.length}`,
      newRecipientsLine(newRecipients(plan).size),
      `subject: ${d.subject}`,
    ];
  },

  // Ruling R1: a present body that is not the text bodyChars / bodySha256 describe was edited in the ledger (the
  // hash leaves the body out, so only this catches it). Runs on the raw stored plan, before the schema.
  tampered(raw) {
    if (!isObject(raw) || !isObject(raw["draft"])) return false;
    const d = raw["draft"];
    return typeof d["body"] === "string" && !bodyMatches(d["body"], d["bodyChars"], d["bodySha256"]);
  },

  // A plan whose body was swept can never be written (decision 2).
  writable: (plan) => plan.draft.body !== undefined,

  // Decision 8: the thread still exists and its latest non-draft message is the one the plan replies to.
  async recheck(plan, { mail }) {
    const thread = await mail.getThread(plan.draft.threadId, 1);
    const latest = thread?.messages.at(-1);
    if (!thread || !latest) return { ok: false, reason: "the thread no longer exists" };
    if (latest.id !== plan.observed.latestMessageId) {
      return { ok: false, reason: "the thread has a new message since planning" };
    }
    return { ok: true };
  },

  async lookupExisting(_plan, key, { mail }) {
    const l = await mail.lookupDraft(draftHeaderFor(key));
    return l.state === "present" ? { state: "present", value: l.draft } : { state: "absent" };
  },

  // Our Message-ID (and the plan's), the thread, the subject, the address sets and the body hash.
  matches(plan, key, r) {
    const d = plan.draft;
    const header = draftHeaderFor(key);
    return (
      d.messageIdHeader === header &&
      r.messageIdHeader === header &&
      r.threadId === d.threadId &&
      r.subject === d.subject &&
      sameSet(r.to, d.to) &&
      sameSet(r.cc, d.cc) &&
      sameSet(r.bcc, d.bcc) &&
      r.bodySha256 === d.bodySha256
    );
  },

  async execute(plan, key, { mail }) {
    const d = plan.draft;
    // Never reached through the gates (7a refuses a swept plan; the tool derives the header from the key); a plain
    // Error is a definite failure, so the plan fails without a write.
    if (d.body === undefined) throw new Error("the plan's body was removed; it cannot be written");
    if (d.messageIdHeader !== draftHeaderFor(key)) throw new Error("the plan's Message-ID is not this action's");
    return mail.createDraft({
      threadId: d.threadId,
      messageIdHeader: d.messageIdHeader,
      inReplyTo: d.inReplyTo,
      references: d.references,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body: d.body,
    });
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

  // The stored plan with the body replaced by its omitted marker (key order kept); a swept plan has no body.
  explainPlan: (plan) => (plan.draft.body === undefined ? plan : { ...plan, draft: { ...plan.draft, body: bodyMarker(plan.draft) } }),
};
