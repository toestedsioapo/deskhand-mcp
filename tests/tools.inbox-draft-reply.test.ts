import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { idempotencyKey } from "../src/approval/apply.js";
import { draftHeaderFor, threadMessageIdsHash } from "../src/approval/mail-draft-kind.js";
import { getAction } from "../src/ledger/actions.js";
import { omittedMarker } from "../src/ledger/redact.js";
import { createFixtureMailProvider } from "../src/providers/fixture/index.js";
import type { FixtureMailProvider } from "../src/providers/fixture/mail.js";
import { inboxDraftReplyInputSchema, inboxDraftReplyOutputSchema } from "../src/tools/inbox-draft-reply.js";
import { setupHarness } from "./helpers/harness.js";
import { mailWorld, msg, useMail, type Thread } from "./helpers/mail-world.js";

// inbox_draft_reply (M4a Task 6): plans a draft reply, never writes to the mailbox.
// Plain ASCII file: special characters are built from code points.
const cp = (...n: number[]): string => String.fromCodePoint(...n);

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H;
beforeEach(async () => {
  h = await setupHarness();
});
afterEach(async () => {
  await h.close();
});

const BODY = "Thanks Ben,\n\nThe numbers look right to me.\n\n-- \nMe";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** m1 from Ana (to me and Ben, cc Cara), m2 from Ben with a Reply-To (to me and Ana, cc Cara). */
const BUDGET: Thread = {
  id: "th_budget",
  messages: [
    msg("m1", "2026-11-09T10:00:00.000Z", {
      message_id: "<m1@example.com>",
      to: [{ address: "me@example.com" }, { address: "ben@example.com" }],
      cc: [{ address: "cara@example.com" }],
    }),
    msg("m2", "2026-11-09T11:00:00.000Z", {
      message_id: "<m2@example.com>",
      from: { address: "ben@example.com", name: "Ben" },
      reply_to: [{ address: "ben-reply@example.com" }],
      to: [{ address: "ME@example.com" }, { address: "ana@example.com" }],
      cc: [{ address: "cara@example.com" }],
    }),
  ],
};
/** One message from Ana, no Reply-To. */
const FROM_ONLY: Thread = { id: "th_from", messages: [msg("f1", "2026-11-09T10:00:00.000Z", { message_id: "<f1@example.com>" })] };
/** Review Focus 1: every message is from the owner (a follow-up to your own unanswered mail). */
const MINE: Thread = {
  id: "th_mine",
  messages: [
    msg("o1", "2026-11-08T10:00:00.000Z", { from: { address: "me@example.com" }, to: [{ address: "ana@example.com" }] }),
    msg("o2", "2026-11-09T10:00:00.000Z", {
      from: { address: "Me@Example.com" },
      to: [{ address: "ana@example.com" }, { address: "ben@example.com" }, { address: "me@example.com" }],
      cc: [{ address: "cara@example.com" }],
    }),
  ],
};
const withSubject = (id: string, subject: string): Thread => ({
  id,
  messages: [msg(`${id}_m1`, "2026-11-09T10:00:00.000Z", { subject })],
});

function world(...extra: Thread[]): void {
  useMail(h, [BUDGET, FROM_ONLY, MINE, ...extra]);
}

const call = (args: Record<string, unknown>) => h.client.callTool({ name: "inbox_draft_reply", arguments: args });
type Out = z.infer<typeof inboxDraftReplyOutputSchema>;
async function ok(args: Record<string, unknown>): Promise<Out> {
  const r = await call(args);
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as Out;
}
async function refused(args: Record<string, unknown>, code = "INVALID_INPUT"): Promise<string> {
  const r = await call(args);
  expect(r.isError).toBe(true);
  const text = (r.content as { text: string }[])[0]!.text;
  if (code === "INVALID_INPUT") expect(text).toMatch(/INVALID_INPUT|-32602|Input validation error/);
  else expect(text.startsWith(`${code}: `), text).toBe(true);
  await h.logging.whenIdle();
  expect(h.db.all("SELECT id FROM actions")).toEqual([]);
  const rows = h.rows().filter((r2) => r2.tool === "inbox_draft_reply");
  expect(rows.map((r2) => [r2.kind, r2.error_code])).toEqual([["tool_call", code]]);
  return text;
}
interface StoredDraftPlan {
  draft: Record<string, unknown> & { to: string[]; cc: string[]; bcc: string[]; subject: string; from: string };
  observed: { latestMessageId: string; messageIdsSha256?: string; onThread: string[] };
}
const storedPlan = (id: string) => getAction(h.db, id)!.plan_json as StoredDraftPlan;
/** The stored JSON columns as text. */
const rawRow = (id: string) => h.db.get<{ input_json: string; plan_json: string }>("SELECT input_json, plan_json FROM actions WHERE id = ?", [id])!;
const drafts = () => (h.ctx.mail as FixtureMailProvider).drafts;

describe("inbox_draft_reply schemas", () => {
  it("input schema is stable", () => expect(z.toJSONSchema(inboxDraftReplyInputSchema)).toMatchSnapshot());
  it("output schema is stable", () => expect(z.toJSONSchema(inboxDraftReplyOutputSchema)).toMatchSnapshot());
});

describe("inbox_draft_reply: planning", () => {
  it("is listed as a plan tool (not read-only, not destructive, not idempotent) and says it cannot send", async () => {
    const t = (await h.client.listTools()).tools.find((x) => x.name === "inbox_draft_reply");
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(t?.description).toContain("deskhand approve");
    expect(t?.description).toMatch(/cannot send/i);
  });

  it("writes plan_created then tool_call, no provider write; input_json holds the omitted marker, not the body", async () => {
    world();
    const out = await ok({ thread_id: "th_budget", body: BODY });
    await h.logging.whenIdle();
    const rows = h.rows();
    expect(rows.map((r) => [r.kind, r.tool, r.action_id, r.outcome])).toEqual([
      ["plan_created", "inbox_draft_reply", out.action_id, "ok"],
      ["tool_call", "inbox_draft_reply", out.action_id, "ok"],
    ]);
    expect(drafts()).toHaveLength(0);
    const a = getAction(h.db, out.action_id)!;
    expect(a.status).toBe("planned");
    const raw = rawRow(out.action_id);
    expect(raw.input_json).toContain(omittedMarker(BODY));
    expect(raw.input_json).not.toContain("numbers look right");
    for (const r of rows) expect(r.preview_json).not.toContain("numbers look right");
    // The body exception (ADR 0010): only plan_json holds it.
    expect(raw.plan_json).toContain("The numbers look right to me.");
    expect(out.body).toBe(omittedMarker(BODY));
    expect(out.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.plan_hash).toBe(a.plan_hash);
    expect(out.expires_at).toBe(a.expires_at);
    expect(JSON.stringify(out)).not.toContain("numbers look right");
  });

  it("stores the thread's message-id set hash (decision 7), and action_explain on an invalid plan keeps it under observed", async () => {
    world();
    const out = await ok({ thread_id: "th_budget", body: BODY });
    const hash = storedPlan(out.action_id).observed.messageIdsSha256;
    expect(hash).toBe(threadMessageIdsHash((await h.ctx.mail!.threadMessageIds("th_budget"))!));
    expect(hash).toBe(sha256(JSON.stringify(["m1", "m2"])));
    const p = getAction(h.db, out.action_id)!.plan_json as Record<string, unknown>;
    h.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [JSON.stringify({ ...p, bogus: 1 }), out.action_id]);
    const r = await h.client.callTool({ name: "action_explain", arguments: { action_id: out.action_id } });
    const ex = r.structuredContent as { plan: { observed: Record<string, unknown>; unrecognised?: unknown } };
    expect(ex.plan.observed["messageIdsSha256"]).toEqual({ untrusted: true, source: expect.any(String), content: hash });
    expect(ex.plan.observed["unrecognised"]).toBeUndefined();
    expect(JSON.stringify(ex.plan.unrecognised)).not.toContain("messageIdsSha256");
  });

  it("stores the decision-3 plan: from is profile().email, our Message-ID, In-Reply-To and References", async () => {
    world();
    const out = await ok({ thread_id: "th_budget", body: BODY, rationale: "answer Ben" });
    const p = storedPlan(out.action_id);
    expect(p.draft).toEqual({
      threadId: "th_budget",
      messageIdHeader: draftHeaderFor(idempotencyKey(out.action_id)),
      inReplyTo: "<m2@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>"],
      from: "me@example.com",
      to: ["ben-reply@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: Q4 budget",
      body: BODY,
      bodyChars: BODY.length,
      bodySha256: sha256(BODY),
    });
    expect(p.observed.latestMessageId).toBe("m2");
    expect((p as unknown as { rationale: string }).rationale).toBe("answer Ben");
    expect(out.diff).toEqual([
      "create draft reply (not sent; Deskhand cannot send mail)",
      `thread: ${omittedMarker("th_budget")}`,
      `in reply to message: ${omittedMarker("m2")}`,
      `from: ${omittedMarker("me@example.com")}`,
      `subject: ${omittedMarker("Re: Q4 budget")}`,
      `agent's reason: ${omittedMarker("answer Ben")}`,
      "new recipients: 1 not on this thread",
      "to: 1 recipient(s)",
      `  ${omittedMarker("ben-reply@example.com")}  (new: not on this thread)`,
      "cc: 0 recipient(s)",
      "bcc: 0 recipient(s)",
      `body: 6 lines, ${BODY.length} chars, sha256:${sha256(BODY).slice(0, 8)}`,
      `  ${omittedMarker(BODY)}`,
      "end of body",
    ]);
    expect(out.new_recipients.map((r) => r.content)).toEqual(["ben-reply@example.com"]);
  });

  it("from follows the mailbox profile, whatever its case in the thread", async () => {
    h.ctx.mail = createFixtureMailProvider({ ...mailWorld([]), mail: { owner: "owner@example.com", threads: [FROM_ONLY] } });
    const out = await ok({ thread_id: "th_from", body: BODY });
    expect(storedPlan(out.action_id).draft.from).toBe("owner@example.com");
    expect(out.diff).toContain(`from: ${omittedMarker("owner@example.com")}`);
  });

  it("default to: the Reply-To of the latest message not from the owner", async () => {
    world();
    const out = await ok({ thread_id: "th_budget", body: BODY });
    expect(storedPlan(out.action_id).draft.to).toEqual(["ben-reply@example.com"]);
  });

  it("default to: the From when there is no Reply-To", async () => {
    world();
    const out = await ok({ thread_id: "th_from", body: BODY });
    const d = storedPlan(out.action_id).draft;
    expect([d.to, d.cc, d.bcc]).toEqual([["ana@example.com"], [], []]);
    expect(d.inReplyTo).toBe("<f1@example.com>");
  });

  it("reply_all adds that message's To and Cc, minus the owner and minus duplicates", async () => {
    world();
    const out = await ok({ thread_id: "th_budget", body: BODY, reply_all: true });
    const d = storedPlan(out.action_id).draft;
    expect(d.to).toEqual(["ben-reply@example.com", "ana@example.com"]);
    expect(d.cc).toEqual(["cara@example.com"]);
    expect(d.bcc).toEqual([]);
    expect(JSON.stringify(d.to.concat(d.cc)).toLowerCase()).not.toContain("me@example.com");
    expect(out.new_recipients.map((r) => r.content)).toEqual(["ben-reply@example.com"]); // seen only in a Reply-To
  });

  it("an explicit to: cc and bcc default to [] and nothing is added, even with reply_all", async () => {
    world();
    const out = await ok({ thread_id: "th_budget", body: BODY, to: ["ana@example.com"], reply_all: true });
    const d = storedPlan(out.action_id).draft;
    expect([d.to, d.cc, d.bcc]).toEqual([["ana@example.com"], [], []]);
  });

  it("Review Focus 1: every message from the owner -> the latest message's To, nothing new, never the owner", async () => {
    world();
    const out = await ok({ thread_id: "th_mine", body: BODY });
    const d = storedPlan(out.action_id).draft;
    expect(d.to).toEqual(["ana@example.com", "ben@example.com"]);
    expect(d.cc).toEqual([]);
    expect(out.new_recipients).toEqual([]);
    expect(out.diff).toContain("new recipients: none");
    for (const a of [...d.to, ...d.cc, ...d.bcc]) expect(a.toLowerCase()).not.toBe("me@example.com");
  });

  it("a new bcc is listed in new_recipients (lowercased) and flagged in the diff", async () => {
    world();
    const out = await ok({ thread_id: "th_budget", body: BODY, to: ["ben@example.com"], bcc: ["Dan@Example.com"] });
    expect(out.new_recipients.map((r) => r.content)).toEqual(["dan@example.com"]);
    expect(out.diff).toContain("new recipients: 1 not on this thread");
    expect(out.diff).toContain(`  ${omittedMarker("Dan@Example.com")}  (new: not on this thread)`);
    expect(out.diff).toContain(`  ${omittedMarker("ben@example.com")}`);
    const p = storedPlan(out.action_id);
    expect(p.observed.onThread).toEqual(["ben@example.com"]);
  });

  it("onThread is computed from the thread (From, To, Cc and the owner, not Reply-To), case-insensitively", async () => {
    world();
    const to = ["ANA@example.com", "ben-reply@example.com"];
    const cc = ["cara@example.com", "me@example.com"];
    const out = await ok({ thread_id: "th_budget", body: BODY, to, cc, bcc: ["zed@example.com"] });
    expect(out.new_recipients.map((r) => r.content)).toEqual(["ben-reply@example.com", "zed@example.com"]);
    expect(storedPlan(out.action_id).observed.onThread).toEqual([
      "ana@example.com",
      "cara@example.com",
      "me@example.com",
    ]);
  });

  it("the default subject is Re: <latest subject>, not doubled when it already starts with Re: (any case)", async () => {
    world(withSubject("th_re", "RE: Offsite"), withSubject("th_re2", "re:Offsite"));
    expect(storedPlan((await ok({ thread_id: "th_re", body: BODY })).action_id).draft.subject).toBe("RE: Offsite");
    expect(storedPlan((await ok({ thread_id: "th_re2", body: BODY })).action_id).draft.subject).toBe("re:Offsite");
    const given = await ok({ thread_id: "th_re", body: BODY, subject: "Offsite agenda" });
    expect(storedPlan(given.action_id).draft.subject).toBe("Offsite agenda");
  });

  it("CRLF in the body becomes LF before it is stored and hashed", async () => {
    world();
    const out = await ok({ thread_id: "th_budget", body: "a\r\nb\r\n" });
    const d = storedPlan(out.action_id).draft;
    expect(d["body"]).toBe("a\nb\n");
    expect(d["bodySha256"]).toBe(sha256("a\nb\n"));
    expect(out.body).toBe(omittedMarker("a\nb\n"));
  });

  it("References keep only <...> shaped printable ASCII Message-IDs, the last 10", async () => {
    const messages = Array.from({ length: 13 }, (_, k) =>
      msg(`r${k}`, new Date(Date.UTC(2026, 10, 1, k)).toISOString(), {
        ...(k === 5 ? { message_id: "no-brackets@example.com" } : k === 6 ? {} : { message_id: `<r${k}@example.com>` }),
        ...(k === 7 ? { message_id: `<r7${cp(0xe9)}@example.com>` } : {}),
      }),
    );
    world({ id: "th_refs", messages });
    const out = await ok({ thread_id: "th_refs", body: BODY });
    const d = storedPlan(out.action_id).draft;
    expect(d["references"]).toEqual([0, 1, 2, 3, 4, 8, 9, 10, 11, 12].map((k) => `<r${k}@example.com>`));
    expect(d["inReplyTo"]).toBe("<r12@example.com>");
  });

  it("a latest message without a usable Message-ID gives inReplyTo null", async () => {
    world({ id: "th_noid", messages: [msg("n1", "2026-11-09T10:00:00.000Z")] });
    const out = await ok({ thread_id: "th_noid", body: BODY });
    expect(storedPlan(out.action_id).draft["inReplyTo"]).toBeNull();
    expect(storedPlan(out.action_id).draft["references"]).toEqual([]);
  });
});

describe("ruling R3: the thread subject never reaches the agent or a preview in clear", () => {
  const SUBJ = "SENTINELSUBJECT budget";
  /** Every string containing `needle` that is not an untrusted wrapper's content. */
  function clearHits(value: unknown, needle: string, parent: unknown = null, out: string[] = []): string[] {
    if (typeof value === "string") {
      const p = parent as Record<string, unknown> | null;
      const wrapped = p !== null && typeof p === "object" && p["untrusted"] === true && p["content"] === value;
      if (value.includes(needle) && !wrapped) out.push(value);
    } else if (Array.isArray(value)) value.forEach((v) => clearHits(v, needle, value, out));
    else if (value !== null && typeof value === "object") for (const v of Object.values(value)) clearHits(v, needle, value, out);
    return out;
  }

  it("inbox_draft_reply, action_explain, ledger_query and every events.preview_json", async () => {
    world({ id: "th_s", messages: [msg("s1", "2026-11-09T10:00:00.000Z", { subject: SUBJ, from: { address: "sentinel-addr@example.com" } })] });
    const out = await ok({ thread_id: "th_s", body: BODY });
    const explain = await h.client.callTool({ name: "action_explain", arguments: { action_id: out.action_id } });
    expect(explain.isError).toBeFalsy();
    const ledger = await h.client.callTool({ name: "ledger_query", arguments: { limit: 200 } });
    await h.logging.whenIdle();
    for (const r of [out, explain.structuredContent, ledger.structuredContent]) {
      expect(clearHits(r, "SENTINELSUBJECT")).toEqual([]);
      expect(clearHits(r, "sentinel-addr")).toEqual([]);
    }
    const ex = explain.structuredContent as { plan: { draft: Record<string, unknown>; observed: { onThread: unknown[] } }; diff: string[] };
    expect(ex.plan.draft["subject"]).toEqual({ untrusted: true, source: "mail:th_s", content: `Re: ${SUBJ}` });
    expect(ex.plan.draft["to"]).toEqual([{ untrusted: true, source: "mail:th_s", content: "sentinel-addr@example.com" }]);
    expect(ex.plan.draft["from"]).toEqual({ untrusted: true, source: "mail:th_s", content: "me@example.com" });
    expect(ex.plan.observed.onThread).toEqual([{ untrusted: true, source: "mail:th_s", content: "sentinel-addr@example.com" }]);
    expect(ex.plan.draft["body"]).toBe(omittedMarker(BODY));
    expect(ex.diff).toEqual(out.diff);
    for (const row of h.rows()) {
      expect(row.preview_json).not.toContain("SENTINELSUBJECT");
      expect(row.preview_json).not.toContain("sentinel-addr");
    }
  });
});

describe("Minor 1: owner detection uses the address rule", () => {
  it("a sender that only lowercases to the owner (Kelvin sign) is not the owner", async () => {
    // Owner kate@example.com; the latest message is from U+212A + "ate@example.com", which is not a usable address.
    h.ctx.mail = createFixtureMailProvider({
      ...mailWorld([]),
      mail: {
        owner: "kate@example.com",
        threads: [
          {
            id: "th_k",
            messages: [
              msg("k1", "2026-11-09T10:00:00.000Z", { from: { address: "ana@example.com" }, to: [{ address: "kate@example.com" }] }),
              msg("k2", "2026-11-09T11:00:00.000Z", { from: { address: `${cp(0x212a)}ate@example.com` }, to: [{ address: "ana@example.com" }] }),
            ],
          },
        ],
      },
    });
    // k2 is not the owner's, so it is the reply target; its From breaks the address rule -> pass `to` explicitly.
    const text = await refused({ thread_id: "th_k", body: BODY });
    expect(text).toContain("pass `to` explicitly");
  });
});

describe("inbox_draft_reply: refusals (INVALID_INPUT or NOT_FOUND, no plan row)", () => {
  it("an unknown thread is NOT_FOUND", async () => {
    world();
    const text = await refused({ thread_id: "nope", body: BODY }, "NOT_FOUND");
    expect(text).toBe("NOT_FOUND: No thread with id nope.");
  });

  for (const [name, subject] of [
    ["an emoji with a ZWJ", `Team ${cp(0x1f468, 0x200d, 0x1f4bb)} sync`],
    ["a bidi mark", `Invoice ${cp(0x202e)}fdp.exe`],
    ["a tab", "Q4\tbudget"],
  ] as const) {
    it(`Review Focus 3: a thread subject with ${name} and no subject -> pass subject explicitly`, async () => {
      world(withSubject("th_bad", subject));
      const text = await refused({ thread_id: "th_bad", body: BODY });
      expect(text).toContain("pass `subject` explicitly");
      expect(text).not.toContain(subject);
    });
  }

  it("Review Focus 3: a given subject is checked on its own (bad thread subject, good given subject)", async () => {
    world(withSubject("th_bad", `Invoice ${cp(0x202e)}fdp.exe`));
    const out = await ok({ thread_id: "th_bad", body: BODY, subject: "Re: Invoice" });
    expect(storedPlan(out.action_id).draft.subject).toBe("Re: Invoice");
  });

  it("a given subject that is not a plain line is refused", async () => {
    world();
    await refused({ thread_id: "th_budget", body: BODY, subject: "Re: a​b" });
  });

  it("Review Focus 4: josé@example.com is refused, naming the rule", async () => {
    world();
    const text = await refused({ thread_id: "th_budget", body: BODY, to: [`jos${cp(0xe9)}@example.com`] });
    expect(text).toContain("printable ASCII");
  });

  it("Review Focus 4: a non-ASCII participant never counts as on the thread (Kelvin sign lowercases to k)", async () => {
    // U+212A KELVIN SIGN lowercases to ASCII "k": compared after lowercasing, it would hide kate's flag.
    world({
      id: "th_kelvin",
      messages: [
        msg("k1", "2026-11-09T10:00:00.000Z", {
          from: { address: `${cp(0x212a)}ate@example.com` },
          cc: [{ address: `jos${cp(0xe9)}@example.com` }],
        }),
      ],
    });
    const out = await ok({ thread_id: "th_kelvin", body: BODY, to: ["kate@example.com"] });
    expect(out.new_recipients.map((r) => r.content)).toEqual(["kate@example.com"]);
    expect(out.diff).toContain(`  ${omittedMarker("kate@example.com")}  (new: not on this thread)`);
    expect(storedPlan(out.action_id).observed.onThread).toEqual([]);
  });

  it("a default recipient that breaks the address rule is refused (pass to explicitly)", async () => {
    world({ id: "th_idn", messages: [msg("i1", "2026-11-09T10:00:00.000Z", { from: { address: `jos${cp(0xe9)}@example.com` } })] });
    const text = await refused({ thread_id: "th_idn", body: BODY });
    expect(text).toContain("pass `to` explicitly");
  });

  it("the same address in to and bcc is refused (case-insensitive)", async () => {
    world();
    const text = await refused({ thread_id: "th_budget", body: BODY, to: ["ana@example.com"], bcc: ["ANA@example.com"] });
    expect(text).toContain("repeated");
  });

  it("a bcc that repeats a default recipient is refused", async () => {
    world();
    await refused({ thread_id: "th_budget", body: BODY, bcc: ["ben-reply@example.com"] });
  });

  it("51 recipients are refused; 50 are accepted", async () => {
    world();
    const many = (n: number) => Array.from({ length: n }, (_, k) => `p${k}@example.com`);
    const text = await refused({ thread_id: "th_budget", body: BODY, to: many(26), cc: many(51).slice(26) });
    expect(text).toContain("50 recipients");
    const out = await ok({ thread_id: "th_budget", body: BODY, to: many(25), cc: many(50).slice(25) });
    expect(out.new_recipients).toHaveLength(50);
  });

  it("an explicit empty to is refused", async () => {
    world();
    await refused({ thread_id: "th_budget", body: BODY, to: [] });
  });

  for (const [name, body] of [
    ["a lone CR", "a\rb"],
    ["a tab", "a\tb"],
    ["a trailing space", "a \nb"],
    ["an escape", `a${cp(0x1b)}[31mb`],
    ["501 lines", Array.from({ length: 501 }, () => "x").join("\n")],
  ] as const) {
    it(`a body with ${name} is refused`, async () => {
      world();
      const text = await refused({ thread_id: "th_budget", body });
      expect(text).toContain("body");
    });
  }

  it("an over-long body is refused by the input schema", async () => {
    world();
    await refused({ thread_id: "th_budget", body: "x".repeat(20_001) });
  });

  it("an empty body is refused by the input schema", async () => {
    world();
    await refused({ thread_id: "th_budget", body: "" });
  });
});
