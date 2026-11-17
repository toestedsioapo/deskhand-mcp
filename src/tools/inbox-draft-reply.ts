import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import {
  draftAddressSchema,
  draftHeaderFor,
  isDraftAddress,
  isHeaderValue,
  MAX_RECIPIENTS,
  MAX_REFERENCES,
  mailDraftPlanSchema,
  type MailDraftPlan,
} from "../approval/mail-draft-kind.js";
import { renderDiff } from "../approval/plan-kinds.js";
import { createPlan } from "../approval/plans.js";
import { idempotencyKey } from "../ledger/ids.js";
import { omittedMarker } from "../ledger/redact.js";
import type { MailMessage } from "../providers/types.js";
import { isPlainLine, MAX_BODY_CHARS, MAX_BODY_LINES, normaliseBody, VISIBLE_ASCII } from "../util/sanitize.js";
import { providerFailure, requireProvider } from "./provider-guard.js";
import { toolError, toolOk, type ToolErrorResult, type ToolOkResult } from "./result.js";
import { threadIdSchema } from "./thread-id.js";

/** Messages read to plan a reply: the newest 100, as inbox_read_thread shows them. */
const MAX_MESSAGES = 100;
const MAX_SUBJECT = 250;

const SUBJECT_RULE =
  "subject must be one line of visible text, 1 to 250 characters: no control, invisible or blank filler characters, no line breaks or tabs, single spaces only between words";
const BODY_RULE =
  `body must be 1 to ${MAX_BODY_CHARS} characters and at most ${MAX_BODY_LINES} lines of visible text: ` +
  "CR LF line ends become LF, a lone CR, a tab, a hidden character or a trailing space (except on the line `-- `) is refused";

const addressList = z.array(draftAddressSchema).max(MAX_RECIPIENTS);

export const inboxDraftReplyInputSchema = z
  .object({
    thread_id: threadIdSchema,
    body: z.string().min(1).max(MAX_BODY_CHARS),
    subject: z.string().min(1).max(MAX_SUBJECT).refine(isPlainLine, { message: SUBJECT_RULE }).optional(),
    to: addressList.optional(),
    cc: addressList.optional(),
    bcc: addressList.optional(),
    reply_all: z.boolean().default(false),
    rationale: z.string().max(500).optional(),
  })
  .strict();

export const inboxDraftReplyOutputSchema = z.object({
  action_id: z.string(),
  plan_hash: z.string(),
  expires_at: z.string(),
  diff: z.array(z.string()),
  new_recipients: z.array(z.string()),
  body: z.string(),
});

export const INBOX_DRAFT_REPLY_DESCRIPTION =
  "Plan a draft reply to a mail thread. Nothing is written to the mailbox: this stores a plan for a human to review, " +
  "who must approve it with `deskhand approve <action_id>` (a terminal command, not a tool); only then can action_apply " +
  "create the draft. Deskhand cannot send mail: the reply is only ever a draft. " +
  "Without `to`, the reply goes to the Reply-To (else the From) of the latest message not sent by you; `reply_all` adds its To and Cc. " +
  "Recipients who are not on the thread are flagged in the diff and listed in new_recipients. " +
  "Returns the action id, plan hash, expiry and the diff the human will read (the body is shown there only as its length and hash).";

type Input = z.infer<typeof inboxDraftReplyInputSchema>;
type Output = z.infer<typeof inboxDraftReplyOutputSchema>;

const lc = (a: string): string => a.toLowerCase();

/** `xs` without the owner and without repeats (case-insensitive), first spelling and order kept. */
function uniqueWithout(xs: readonly string[], exclude: ReadonlySet<string>): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(lc(x))) continue;
    seen.add(lc(x));
    out.push(x);
  }
  return out;
}

/**
 * Decision 6. The latest message not sent by the owner: its Reply-To, else its From; `reply_all` adds its To (to) and
 * Cc (cc). When every message is the owner's: the latest message's To (and with `reply_all` its Cc). Never the owner.
 */
function defaultRecipients(messages: readonly MailMessage[], owner: string, replyAll: boolean): { to: string[]; cc: string[] } {
  // The same address rule as participants(): an address that only lowercases to the owner's is not the owner.
  const isOwner = (m: MailMessage) => m.from !== null && isDraftAddress(m.from.address) && lc(m.from.address) === lc(owner);
  const target = messages.filter((m) => !isOwner(m)).at(-1);
  const ownerSet = new Set([lc(owner)]);
  if (target) {
    const primary = target.replyTo.length > 0 ? target.replyTo.map((a) => a.address) : target.from ? [target.from.address] : [];
    const to = uniqueWithout([...primary, ...(replyAll ? target.to.map((a) => a.address) : [])], ownerSet);
    const cc = replyAll ? uniqueWithout(target.cc.map((a) => a.address), new Set([...ownerSet, ...to.map(lc)])) : [];
    return { to, cc };
  }
  const latest = messages.at(-1)!;
  const to = uniqueWithout(latest.to.map((a) => a.address), ownerSet);
  const cc = replyAll ? uniqueWithout(latest.cc.map((a) => a.address), new Set([...ownerSet, ...to.map(lc)])) : [];
  return { to, cc };
}

/**
 * Decision 5: every From, Reply-To, To and Cc address of every message, plus the owner, lowercased. Only addresses
 * that pass the address rule count, checked before lowercasing (a non-ASCII address such as one with U+212A KELVIN
 * SIGN would otherwise lowercase to an ASCII one and hide a flag).
 */
function participants(messages: readonly MailMessage[], owner: string): Set<string> {
  const all = [owner];
  for (const m of messages) {
    if (m.from) all.push(m.from.address);
    for (const a of [...m.replyTo, ...m.to, ...m.cc]) all.push(a.address);
  }
  return new Set(all.filter(isDraftAddress).map(lc));
}

const invalid = (message: string): ToolErrorResult => toolError("INVALID_INPUT", message);

export async function inboxDraftReplyHandler(ctx: AppContext, input: Input): Promise<ToolOkResult<Output> | ToolErrorResult> {
  const providers = requireProvider(ctx);
  if ("isError" in providers) return providers;
  const mail = providers.mail;

  let thread;
  let owner: string;
  try {
    thread = await mail.getThread(input.thread_id, MAX_MESSAGES);
    if (thread === null) return toolError("NOT_FOUND", `No thread with id ${input.thread_id}.`);
    owner = (await mail.profile()).email;
  } catch (e) {
    return providerFailure(e);
  }
  const latest = thread.messages.at(-1);
  if (!latest) return invalid(`Thread ${input.thread_id} has no message to reply to.`);
  // Provider values the plan stores (never echoed: they are mailbox data).
  if (!isDraftAddress(owner)) {
    return toolError("PROVIDER_ERROR", "The mailbox address cannot be used as a draft sender (it must be printable ASCII).");
  }
  if (latest.id.length === 0 || latest.id.length > 256 || !VISIBLE_ASCII.test(latest.id)) {
    return toolError("PROVIDER_ERROR", "The latest message id of this thread cannot be stored in a plan.");
  }

  // Body (decision 4): CR LF to LF first, then the rules.
  const body = normaliseBody(input.body);
  if (body === null) return invalid(BODY_RULE);

  // Subject: the given one was checked by the input schema; the default comes from the latest message.
  let subject = input.subject;
  if (subject === undefined) {
    const base = latest.subject;
    const candidate = /^re:/i.test(base) ? base : `Re: ${base}`;
    if (candidate.length > MAX_SUBJECT || !isPlainLine(candidate)) {
      return invalid(
        "The thread's subject cannot be used as the draft subject (it is not one plain line of at most 250 characters); pass `subject` explicitly.",
      );
    }
    subject = candidate;
  }

  // Recipients (decision 6), then the rules (decision 4) over the final lists.
  let to: string[];
  let cc: string[];
  const bcc = input.bcc ?? [];
  if (input.to !== undefined) {
    to = input.to;
    cc = input.cc ?? [];
  } else {
    const d = defaultRecipients(thread.messages, owner, input.reply_all);
    to = d.to;
    cc = uniqueWithout([...(input.cc ?? []), ...d.cc], new Set());
    if (to.length === 0) return invalid("This thread has no recipient to reply to other than you; pass `to` explicitly.");
    if (![...to, ...cc].every(isDraftAddress)) {
      return invalid("A default recipient on this thread is not a usable address (every address must be printable ASCII); pass `to` explicitly.");
    }
  }
  if (to.length === 0) return invalid("to must name at least one recipient.");
  const all = [...to, ...cc, ...bcc];
  if (all.length > MAX_RECIPIENTS) return invalid(`At most ${MAX_RECIPIENTS} recipients in total (to, cc and bcc together).`);
  if (new Set(all.map(lc)).size !== all.length) {
    return invalid("An address is repeated across to, cc and bcc (compared case-insensitively); name each recipient once.");
  }

  // On the thread (decision 5): only the recipients that are, so the plan holds no other address.
  const onThreadSet = participants(thread.messages, owner);
  const onThread = [...new Set(all.map(lc).filter((a) => onThreadSet.has(a)))].sort();
  const newRecipients = all.map(lc).filter((a) => !onThreadSet.has(a));

  // In-Reply-To and References: the thread's usable Message-IDs, the newest MAX_REFERENCES.
  const references = thread.messages
    .map((m) => m.messageIdHeader)
    .filter((v): v is string => v !== null && isHeaderValue(v))
    .slice(-MAX_REFERENCES);
  const inReplyTo = latest.messageIdHeader !== null && isHeaderValue(latest.messageIdHeader) ? latest.messageIdHeader : null;

  const build = (actionId: string): MailDraftPlan => ({
    kind: "mail.create_draft_reply",
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    draft: {
      threadId: input.thread_id,
      messageIdHeader: draftHeaderFor(idempotencyKey(actionId)),
      inReplyTo,
      references,
      from: owner,
      to,
      cc,
      bcc,
      subject,
      body,
      bodyChars: body.length,
      bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    },
    observed: { latestMessageId: latest.id, onThread },
  });
  // Every rule is checked above; this catches anything left (for example an address the agent did not choose), so a
  // plan the schema would refuse is an INVALID_INPUT answer and never a thrown INTERNAL.
  const check = mailDraftPlanSchema.safeParse(build("act_00000000000000000000000000"));
  if (!check.success) return invalid(`The draft breaks a plan rule: ${check.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}.`);

  const created = createPlan(ctx, { tool: "inbox_draft_reply", input, buildPlan: build });
  return toolOk(
    {
      action_id: created.actionId,
      plan_hash: created.planHash,
      expires_at: created.expiresAt,
      diff: renderDiff(created.plan, ctx.config.timeZone, "agent"),
      new_recipients: newRecipients,
      body: omittedMarker(body),
    },
    { action_id: created.actionId },
  );
}
