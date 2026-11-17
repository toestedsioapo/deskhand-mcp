import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAction, idempotencyKey } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import { DRAFT_DIFFERS, draftHeaderFor, type MailDraftPlan } from "../src/approval/mail-draft-kind.js";
import type { CliIo } from "../src/cli/io.js";
import { getAction } from "../src/ledger/actions.js";
import { canonicalJson } from "../src/ledger/canonical.js";
import { last4 } from "../src/ledger/ids.js";
import { omittedMarker } from "../src/ledger/redact.js";
import { createFixtureMailProvider } from "../src/providers/fixture/index.js";
import type { FixtureMailProvider } from "../src/providers/fixture/mail.js";
import { setupHarness } from "./helpers/harness.js";
import { mailWorld, msg, useMail, type Thread } from "./helpers/mail-world.js";

// Applying a draft through the fixture provider (M4a Task 6): idempotent, with a thread re-check, never a send.

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
const tmpDirs: string[] = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BODY = "Thanks Ben,\n\nThe numbers look right to me.\n\n-- \nMe";
const SECRET = "numbers look right";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const M1 = msg("m1", "2026-11-09T10:00:00.000Z", {
  message_id: "<m1@example.com>",
  to: [{ address: "me@example.com" }, { address: "ben@example.com" }],
});
const M2 = msg("m2", "2026-11-09T11:00:00.000Z", {
  message_id: "<m2@example.com>",
  from: { address: "ben@example.com", name: "Ben" },
  to: [{ address: "me@example.com" }],
});
const THREAD: Thread = { id: "th_budget", messages: [M1, M2] };
const M3 = msg("m3", "2026-11-09T12:00:00.000Z", { message_id: "<m3@example.com>" });

/** A harness with writes enabled and a mailbox whose write_log is a temp file. */
async function harness(threads: Thread[] = [THREAD]): Promise<{ hh: H; writeLog: string }> {
  h = await setupHarness({ env: { DESKHAND_ALLOW_WRITES: "1" } });
  const dir = mkdtempSync(join(tmpdir(), "deskhand-wl-"));
  tmpDirs.push(dir);
  const writeLog = join(dir, "writes.jsonl");
  h.ctx.mail = createFixtureMailProvider({ ...mailWorld(threads), settings: { latency_ms: 0, write_log: writeLog } });
  return { hh: h, writeLog };
}
const drafts = (hh: H) => (hh.ctx.mail as FixtureMailProvider).drafts;

function approvalIo(id: string): CliIo {
  return { out: () => undefined, err: () => undefined, stdinIsTTY: true, stdoutIsTTY: true, readLine: async () => last4(id) };
}
async function propose(hh: H, args: Record<string, unknown> = {}): Promise<string> {
  const r = await hh.client.callTool({ name: "inbox_draft_reply", arguments: { thread_id: "th_budget", body: BODY, ...args } });
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return (r.structuredContent as { action_id: string }).action_id;
}
async function proposeAndApprove(hh: H, args: Record<string, unknown> = {}): Promise<string> {
  const id = await propose(hh, args);
  expect(await approveAction(hh.ctx, id, approvalIo(id))).toEqual({ ok: true });
  return id;
}
const apply = (hh: H, id: string) => hh.client.callTool({ name: "action_apply", arguments: { action_id: id } });
const text = (r: Awaited<ReturnType<typeof apply>>) => (r.content as { text: string }[])[0]!.text;
const planOf = (hh: H, id: string) => getAction(hh.db, id)!.plan_json as MailDraftPlan;
const rawResult = (hh: H, id: string) => hh.db.get<{ result_json: string | null }>("SELECT result_json FROM actions WHERE id = ?", [id])!.result_json;
const lifecycle = (hh: H, id: string) =>
  hh.rows().filter((r) => r.action_id === id && r.kind !== "tool_call").map((r) => r.kind);

/** No own or prototype key of the mail provider object names a send. */
function expectNoSend(hh: H): void {
  const o = hh.ctx.mail as object;
  const keys = [...Object.keys(o), ...Object.getOwnPropertyNames(Object.getPrototypeOf(o))];
  expect(keys.filter((k) => /send/i.test(k))).toEqual([]);
}

describe("propose -> approve -> apply a draft (end to end on the fixture)", () => {
  it("writes one draft; a second apply is replayed with no second draft; no body text in output or result_json", async () => {
    const { hh, writeLog } = await harness();
    expectNoSend(hh);
    const id = await proposeAndApprove(hh);
    expect(drafts(hh)).toHaveLength(0);
    expectNoSend(hh);

    const first = await apply(hh, id);
    expect(first.isError, text(first)).toBeFalsy();
    const header = draftHeaderFor(idempotencyKey(id));
    const w = (content: string) => ({ untrusted: true, source: "mail:th_budget", content });
    expect(first.structuredContent).toEqual({
      action_id: id,
      status: "applied",
      replayed: false,
      result: {
        draft_id: "dr_1",
        message_id: "msg_dr_1",
        thread_id: "th_budget",
        subject: w("Re: Q4 budget"),
        to: [w("ben@example.com")],
        cc: [],
        bcc: [],
        body: omittedMarker(BODY),
      },
    });
    expect(drafts(hh)).toEqual([
      {
        draftId: "dr_1",
        messageId: "msg_dr_1",
        threadId: "th_budget",
        messageIdHeader: header,
        to: ["ben@example.com"],
        cc: [],
        bcc: [],
        subject: "Re: Q4 budget",
        bodySha256: sha256(BODY),
      },
    ]);
    const a = getAction(hh.db, id)!;
    expect(a.status).toBe("applied");
    expect(rawResult(hh, id)).toBe(
      canonicalJson({
        bcc: [],
        bodySha256: sha256(BODY),
        cc: [],
        draftId: "dr_1",
        messageId: "msg_dr_1",
        messageIdHeader: header,
        subject: "Re: Q4 budget",
        threadId: "th_budget",
        to: ["ben@example.com"],
      }),
    );

    const again = await apply(hh, id);
    expect(again.structuredContent).toEqual({ ...(first.structuredContent as object), replayed: true });
    expect(drafts(hh)).toHaveLength(1);

    await hh.logging.whenIdle();
    for (const r of [first, again]) {
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    expect(rawResult(hh, id)).not.toContain(SECRET);
    for (const row of hh.rows()) expect(row.preview_json).not.toContain(SECRET);
    expect(lifecycle(hh, id)).toEqual(["plan_created", "approved", "cli_command", "applied"]);

    // No-send: the provider object never grew a send member, and the write log holds only the one draft line,
    // with In-Reply-To and References from the thread and the body omitted.
    expectNoSend(hh);
    const lines = readFileSync(writeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l["op"])).toEqual(["mail.createDraft"]);
    expect(lines[0]!["idempotency_key"]).toBe(header);
    expect(lines[0]!["request"]).toMatchObject({
      inReplyTo: "<m2@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>"],
      body: omittedMarker(BODY),
    });
    expect(readFileSync(writeLog, "utf8")).not.toContain(SECRET);
  });

  it("a crash before commit, then a retry: applied, recovered, one draft", async () => {
    const { hh } = await harness();
    const id = await proposeAndApprove(hh);
    hh.ctx.hooks = { beforeCommit: () => { throw new Error("crash"); } };
    await expect(applyAction(hh.ctx, id)).rejects.toThrow("crash");
    expect(drafts(hh)).toHaveLength(1);
    expect(getAction(hh.db, id)!.status).toBe("approved");
    delete hh.ctx.hooks;
    const r = await applyAction(hh.ctx, id);
    expect(r).toMatchObject({ ok: true, replayed: true });
    expect(drafts(hh)).toHaveLength(1);
    expect(getAction(hh.db, id)!.status).toBe("applied");
    const applied = hh.rows().filter((x) => x.action_id === id && x.kind === "applied");
    expect(applied).toHaveLength(1);
    expect((JSON.parse(applied[0]!.preview_json) as { note: unknown }).note).toBe("recovered");
  });
});

describe("the re-check (decision 8) and the differs phrase", () => {
  const STALE = (phrase: string) => `The world changed since planning: ${phrase}.`;

  it("a new message in the thread after planning: STALE_PLAN, exact message, failed, no draft", async () => {
    const { hh } = await harness();
    const id = await proposeAndApprove(hh);
    useMail(hh, [{ ...THREAD, messages: [M1, M2, M3] }]);
    const r = await apply(hh, id);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`STALE_PLAN: ${STALE("the thread has a new message since planning")}`);
    expect(getAction(hh.db, id)!.status).toBe("failed");
    expect(getAction(hh.db, id)!.error).toBe(`STALE_PLAN: ${STALE("the thread has a new message since planning")}`);
    expect(drafts(hh)).toHaveLength(0);
  });

  it("the thread is gone: STALE_PLAN with the exact phrase, failed, no draft", async () => {
    const { hh } = await harness();
    const id = await proposeAndApprove(hh);
    useMail(hh, []);
    expect(await applyAction(hh.ctx, id)).toEqual({
      ok: false,
      errorCode: "STALE_PLAN",
      message: STALE("the thread no longer exists"),
    });
    expect(getAction(hh.db, id)!.status).toBe("failed");
    expect(drafts(hh)).toHaveLength(0);
  });

  it("the mailbox account changed since planning (profile().email differs from the plan's from): STALE_PLAN, no draft", async () => {
    const { hh } = await harness();
    const id = await proposeAndApprove(hh);
    hh.ctx.mail = createFixtureMailProvider({ ...mailWorld([]), mail: { owner: "someone-else@example.com", threads: [THREAD] } });
    expect(await applyAction(hh.ctx, id)).toEqual({
      ok: false,
      errorCode: "STALE_PLAN",
      message: STALE("the mailbox account changed since planning"),
    });
    expect(getAction(hh.db, id)!.status).toBe("failed");
    expect(drafts(hh)).toHaveLength(0);
  });

  it("the same account in another case is not a change", async () => {
    const { hh } = await harness();
    const id = await proposeAndApprove(hh);
    hh.ctx.mail = createFixtureMailProvider({ ...mailWorld([]), mail: { owner: "Me@Example.com", threads: [THREAD] } });
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false });
  });

  it("a draft under our Message-ID with a different bcc: STALE_PLAN with the fixed differs phrase, no second draft", async () => {
    const { hh } = await harness();
    const id = await proposeAndApprove(hh);
    const d = planOf(hh, id).draft;
    await hh.ctx.mail!.createDraft({ ...d, body: BODY, bcc: ["mallory@example.com"] });
    const r = await apply(hh, id);
    expect(text(r)).toBe(`STALE_PLAN: ${DRAFT_DIFFERS}`);
    expect(DRAFT_DIFFERS).toBe("a draft with this action's id exists but differs from the approved plan");
    expect(getAction(hh.db, id)!.status).toBe("failed");
    expect(drafts(hh)).toHaveLength(1);
  });
});

describe("gate 7a: a swept plan whose draft already exists is recovered (carried item 4)", () => {
  it("an approved bodyRemoved plan whose draft exists is recorded applied (recovered) with no second write", async () => {
    const { hh } = await harness();
    const id = await proposeAndApprove(hh);
    const plan = planOf(hh, id);
    // A crashed apply left the draft behind ...
    await hh.ctx.mail!.createDraft({ ...plan.draft, body: BODY });
    // ... and the sweep then removed the body (plan_hash unchanged by construction).
    const { body: _b, ...rest } = plan.draft;
    hh.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [canonicalJson({ ...plan, draft: { ...rest, bodyRemoved: true } }), id]);
    const r = await applyAction(hh.ctx, id);
    expect(r).toMatchObject({ ok: true, replayed: true });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(getAction(hh.db, id)!.status).toBe("applied");
    expect(drafts(hh)).toHaveLength(1);
    const applied = hh.rows().filter((x) => x.action_id === id && x.kind === "applied");
    expect((JSON.parse(applied[0]!.preview_json) as { note: unknown }).note).toBe("recovered");
  });
});
