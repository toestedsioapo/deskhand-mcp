import { afterEach, describe, expect, it } from "vitest";
import { approveAction } from "../src/approval/approve.js";
import { sweepDraftBodies } from "../src/approval/body-sweep.js";
import { renderDiff } from "../src/approval/plan-kinds.js";
import { rejectAction } from "../src/approval/approve.js";
import type { CliIo } from "../src/cli/io.js";
import { canonicalJson, planHash } from "../src/ledger/canonical.js";
import { last4 } from "../src/ledger/ids.js";
import { CONTINUATION, termWidth } from "../src/util/sanitize.js";
import { setupHarness } from "./helpers/harness.js";
import { msg, useMail } from "./helpers/mail-world.js";

// The owner's decisions on PR #7's "Open for owner decision" list (2026-11-23).

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const S = "SENTINELTEXT";
const REASON = "Ana asked for the Q4 numbers";
const THREADS = [
  {
    id: "th_phish",
    messages: [
      msg("m1", "2026-11-08T10:00:00.000Z", {
        from: { address: "ana@example.com" },
        reply_to: [{ address: "attacker@evil.example" }],
        message_id: "<m1@example.com>",
      }),
    ],
  },
  {
    id: "th_self",
    messages: [
      msg("m2", "2026-11-08T10:00:00.000Z", {
        from: { address: "ana@example.com" },
        reply_to: [{ address: "ana@example.com" }],
      }),
    ],
  },
];

async function harness(): Promise<H> {
  h = await setupHarness();
  useMail(h, THREADS);
  return h;
}

interface Stored {
  rationale?: string;
  rationaleSha256?: string;
  draft: Record<string, unknown>;
  observed: Record<string, unknown>;
}
const stored = (hh: H, id: string) => JSON.parse(hh.db.get<{ plan_json: string }>("SELECT plan_json FROM actions WHERE id = ?", [id])!.plan_json) as Stored;
const hashOf = (hh: H, id: string) => hh.db.get<{ plan_hash: string }>("SELECT plan_hash FROM actions WHERE id = ?", [id])!.plan_hash;

async function plan(hh: H, args: Record<string, unknown> = {}) {
  const r = await hh.client.callTool({ name: "inbox_draft_reply", arguments: { thread_id: "th_phish", body: "Thanks", ...args } });
  expect(r.isError).toBeFalsy();
  return r.structuredContent as { action_id: string; new_recipients: string[]; diff: string[] };
}

function scripted(line: string, columns = 80): CliIo & { outText: () => string } {
  let out = "";
  return {
    out: (s) => (out += s),
    err: () => undefined,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    columns,
    readLine: async () => line,
    outText: () => out,
  };
}

/** Every string holding SENTINELTEXT outside an untrusted wrapper's `content`, and every key holding it. */
function bare(value: unknown, parent: unknown = null, out: string[] = []): string[] {
  if (typeof value === "string") {
    const p = parent as Record<string, unknown> | null;
    const wrapped = p !== null && !Array.isArray(p) && p["untrusted"] === true && p["content"] === value;
    if (value.includes(S) && !wrapped) out.push(value);
  } else if (Array.isArray(value)) value.forEach((v) => bare(v, value, out));
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.includes(S)) out.push(`key:${k}`);
      bare(v, value, out);
    }
  }
  return out;
}

describe("decision 1: an address only in a Reply-To is not on the thread", () => {
  it("the phishing repro: the default draft to the Reply-To is flagged new", async () => {
    const hh = await harness();
    const out = await plan(hh);
    expect(out.new_recipients).toEqual(["attacker@evil.example"]);
    const diff = renderDiff(stored(hh, out.action_id), "UTC", "approver");
    expect(diff).toContain("new recipients: 1 not on this thread");
    expect(diff).toContain("  attacker@evil.example  (new: not on this thread)");
    expect(stored(hh, out.action_id).observed["onThread"]).toEqual([]);
  });

  it("a Reply-To that is also the From stays on the thread", async () => {
    const hh = await harness();
    const out = await plan(hh, { thread_id: "th_self" });
    expect(out.new_recipients).toEqual([]);
  });
});

describe("decision 2: the agent's reason", () => {
  it("the approver sees one labelled line; the agent sees only its marker", async () => {
    const hh = await harness();
    const out = await plan(hh, { rationale: REASON });
    const approver = renderDiff(stored(hh, out.action_id), "UTC", "approver");
    expect(approver.filter((l) => l === `agent's reason: ${REASON}`)).toHaveLength(1);
    expect(out.diff.some((l) => l.startsWith("agent's reason: [omitted "))).toBe(true);
    expect(out.diff.join("\n")).not.toContain(REASON);
  });

  it("no reason, no line", async () => {
    const hh = await harness();
    const out = await plan(hh);
    expect(renderDiff(stored(hh, out.action_id), "UTC", "approver").join("\n")).not.toContain("agent's reason");
  });

  it("a long reason wraps with the continuation marker", async () => {
    const hh = await harness();
    const long = "because ".repeat(20).trim();
    const out = await plan(hh, { rationale: long });
    const io = scripted(last4(out.action_id), 40);
    expect(await approveAction(hh.ctx, out.action_id, io)).toEqual({ ok: true });
    const rows = io.outText().split("\n");
    const at = rows.findIndex((r) => r.startsWith("    agent's reason: "));
    expect(at).toBeGreaterThan(-1);
    expect(rows[at + 1]!.startsWith(CONTINUATION)).toBe(true);
    for (const r of rows) expect(termWidth(r)).toBeLessThanOrEqual(40);
  });

  it.each([
    ["a line break", "one\ntwo"],
    ["a tab", "one\ttwo"],
    ["a double space", "one  two"],
    ["a leading space", " one"],
    ["a hidden character", "one​two"],
    ["an escape", "one\u001B[2Jtwo"],
    ["empty", ""],
  ])("refuses a reason with %s and stores no plan", async (_n, rationale) => {
    const hh = await harness();
    const r = await hh.client.callTool({ name: "inbox_draft_reply", arguments: { thread_id: "th_phish", body: "Thanks", rationale } });
    expect(r.isError).toBe(true);
    expect(hh.db.all("SELECT id FROM actions")).toHaveLength(0);
  });

  it("action_explain returns the reason only as untrusted text, and no preview holds it", async () => {
    const hh = await harness();
    const out = await plan(hh, { rationale: `${S} reason` });
    const r = await hh.client.callTool({ name: "action_explain", arguments: { action_id: out.action_id } });
    const ex = r.structuredContent as { rationale: unknown; plan: { rationale: unknown } };
    const wrapped = { untrusted: true, source: "mail:th_phish", content: `${S} reason` };
    expect(ex.rationale).toEqual(wrapped);
    expect(ex.plan.rationale).toEqual(wrapped);
    await hh.logging.whenIdle();
    expect(hh.rows().map((x) => x.preview_json).join("\n")).not.toContain(S);
  });

  it("the sweep removes the reason like the body, keeps its hash and never changes plan_hash", async () => {
    const hh = await harness();
    const out = await plan(hh, { rationale: `${S} reason` });
    const before = stored(hh, out.action_id);
    const hash = hashOf(hh, out.action_id);
    expect(before.rationaleSha256).toMatch(/^[0-9a-f]{64}$/);
    rejectAction(hh.ctx, out.action_id, undefined, "cli_no_tty");
    sweepDraftBodies(hh.ctx);
    const after = stored(hh, out.action_id);
    expect(after.rationale).toBeUndefined();
    expect(after.rationaleSha256).toBe(before.rationaleSha256);
    expect(after.draft["bodyRemoved"]).toBe(true);
    expect(hashOf(hh, out.action_id)).toBe(hash);
    expect(JSON.stringify(hh.db.all("SELECT * FROM actions"))).not.toContain(S);
  });

  it.each([
    ["edited", (p: Stored) => ({ ...p, rationale: "A different reason" })],
    ["removed", ({ rationale: _r, ...p }: Stored) => p],
  ])("a reason %s in the ledger is refused at approve", async (_n, edit) => {
    const hh = await harness();
    const out = await plan(hh, { rationale: REASON });
    const p = stored(hh, out.action_id);
    hh.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [canonicalJson(edit(p)), out.action_id]);
    const r = await approveAction(hh.ctx, out.action_id, scripted(last4(out.action_id)));
    expect(JSON.stringify(r)).toContain("PLAN_MODIFIED");
  });

  it("plan_hash covers the reason through its hash", async () => {
    const hh = await harness();
    const out = await plan(hh, { rationale: REASON });
    const p = stored(hh, out.action_id);
    expect(planHash({ ...p, rationaleSha256: "0".repeat(64) })).not.toBe(planHash(p));
  });
});

describe("decision 3: action_explain wraps every mailbox-derived field", () => {
  it("a valid plan: thread id, message ids, addresses and subject are untrusted, and the diff shows no id", async () => {
    const hh = await harness();
    const out = await plan(hh);
    const r = await hh.client.callTool({ name: "action_explain", arguments: { action_id: out.action_id } });
    const ex = r.structuredContent as { plan: { draft: Record<string, unknown>; observed: Record<string, unknown> }; diff: string[] };
    const w = (content: string) => ({ untrusted: true, source: "mail:th_phish", content });
    expect(ex.plan.draft["threadId"]).toEqual(w("th_phish"));
    expect(ex.plan.draft["inReplyTo"]).toEqual(w("<m1@example.com>"));
    expect(ex.plan.observed["latestMessageId"]).toEqual(w("m1"));
    expect(ex.diff.join("\n")).not.toContain("th_phish");
    expect(ex.diff.find((l) => l.startsWith("in reply to message: "))).toMatch(/\[omitted /);
  });

  const invalidPlans: [string, (p: Stored) => unknown][] = [
    [
      "every field edited",
      (p) => ({
        ...p,
        rationale: `${S} reason`,
        [`${S}_top`]: `${S} extra`,
        draft: {
          ...p.draft,
          threadId: `${S}_thread`,
          messageIdHeader: `<${S}@evil.example>`,
          inReplyTo: `<${S}_irt@evil.example>`,
          references: [`<${S}_ref@evil.example>`],
          from: `${S}@evil.example`,
          to: [`${S}@evil.example`],
          cc: [`${S}2@evil.example`],
          bcc: [`${S}3@evil.example`],
          subject: `${S} subject`,
          bodySha256: `${S} hash`,
          replyTo: `${S} unknown key`,
          [`${S}_key`]: 1,
        },
        observed: { latestMessageId: `${S}_latest`, onThread: [`${S}@evil.example`], [`${S}_obs`]: `${S} extra` },
      }),
    ],
    ["draft is a string", (p) => ({ ...p, draft: `${S} draft` })],
    ["draft is an array", (p) => ({ ...p, draft: [`${S} draft`, { nested: `${S} nested` }] })],
    ["observed is a string", (p) => ({ ...p, draft: { ...p.draft, subject: 5 }, observed: `${S} observed` })],
  ];

  it.each(invalidPlans)("an invalid plan (%s) has no mailbox text outside a wrapper, in output or preview", async (_n, edit) => {
    const hh = await harness();
    const out = await plan(hh);
    hh.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [JSON.stringify(edit(stored(hh, out.action_id))), out.action_id]);
    const r = await hh.client.callTool({ name: "action_explain", arguments: { action_id: out.action_id } });
    expect(r.isError).toBeFalsy();
    const ex = r.structuredContent as { plan: unknown; rationale: unknown; diff: string[] };
    expect(ex.diff).toEqual(["(invalid plan)"]);
    expect(bare(ex.plan)).toEqual([]);
    expect(bare(ex.rationale)).toEqual([]);
    await hh.logging.whenIdle();
    expect(hh.rows().map((x) => x.preview_json).join("\n")).not.toContain(S);
  });

  it("an invalid plan's body stays an omitted marker, never wrapped text", async () => {
    const hh = await harness();
    const out = await plan(hh);
    const p = stored(hh, out.action_id);
    const edited = { ...p, draft: { ...p.draft, body: [`${S} body`], bodyRemoved: `${S} removed` } };
    hh.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [JSON.stringify(edited), out.action_id]);
    const r = await hh.client.callTool({ name: "action_explain", arguments: { action_id: out.action_id } });
    expect(JSON.stringify(r.structuredContent)).not.toContain(S);
  });

  it("a calendar plan's rationale is unchanged", async () => {
    const hh = await harness();
    const { insertAction } = await import("./helpers/harness.js");
    insertAction(hh.db, "act_CAL", { kind: "calendar.create_event", rationale: "Sync with Ana" });
    const r = await hh.client.callTool({ name: "action_explain", arguments: { action_id: "act_CAL" } });
    expect((r.structuredContent as { rationale: unknown }).rationale).toBe("Sync with Ana");
  });
});
