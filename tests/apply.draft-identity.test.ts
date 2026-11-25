import { afterEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { applyAction } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import type { CliIo } from "../src/cli/io.js";
import { getAction } from "../src/ledger/actions.js";
import { LedgerDb } from "../src/ledger/db.js";
import { last4 } from "../src/ledger/ids.js";
import { ProviderError } from "../src/providers/errors.js";
import { createFixtureMailProvider } from "../src/providers/fixture/index.js";
import type { NewDraft } from "../src/providers/types.js";
import { gmailLike } from "./helpers/gmail-like.js";
import { NOW, setupHarness } from "./helpers/harness.js";
import { mailWorld, msg, type Thread } from "./helpers/mail-world.js";

// Draft identity after the M4b live check (owner decision, 2026-11-25): Gmail rewrites a draft's Message-ID, so a draft
// is this action's by the draft id recorded in a `write_landed` row as soon as the POST returns it, and only when no id
// was recorded (a crash or an ambiguous failure before it) by its content: the thread's drafts with the approved
// recipients, subject and body hash, oldest first, never one another action recorded.

const HOLD = 60_000;
const DIFFERS = "a draft with this action's id exists but differs from the approved plan";
const DELETED = "a draft with this action's id was created and later deleted";
const BODY = "Thanks Ben,\n\nThe numbers look right to me.";
const THREAD: Thread = {
  id: "th_budget",
  messages: [
    msg("m1", "2026-11-09T10:00:00.000Z", {
      message_id: "<m1@example.com>",
      to: [{ address: "me@example.com" }, { address: "ben@example.com" }],
    }),
    msg("m2", "2026-11-09T11:00:00.000Z", {
      message_id: "<m2@example.com>",
      from: { address: "ben@example.com", name: "Ben" },
      to: [{ address: "me@example.com" }],
    }),
  ],
};

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
let second: LedgerDb | undefined;
const BASE = Date.parse(NOW);
let now = BASE;
const at = (ms: number): void => {
  now = BASE + ms;
};

afterEach(async () => {
  second?.close();
  second = undefined;
  await h?.close();
  h = undefined;
  now = BASE;
});

const approvalIo = (id: string): CliIo => ({
  out: () => undefined,
  err: () => undefined,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  readLine: async () => last4(id),
});

async function propose(hh: H): Promise<string> {
  const r = await hh.client.callTool({ name: "inbox_draft_reply", arguments: { thread_id: "th_budget", body: BODY } });
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  const id = (r.structuredContent as { action_id: string }).action_id;
  expect(await approveAction(hh.ctx, id, approvalIo(id))).toEqual({ ok: true });
  return id;
}

/** `count` approved draft plans with the same content on a Gmail-like mailbox, with a clock the test moves. */
async function setup(count = 1) {
  const hh = await setupHarness({ env: { DESKHAND_ALLOW_WRITES: "1" } });
  h = hh;
  hh.ctx.mail = createFixtureMailProvider(mailWorld([THREAD]));
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(await propose(hh));
  const fake = gmailLike(hh.ctx.mail);
  hh.ctx.mail = fake.mail;
  hh.ctx.clock = () => new Date(now);
  return { hh, id: ids[0]!, ids, ...fake };
}

/** The approved draft of an action, as the engine would hand it to the provider. */
function approvedDraft(hh: H, id: string): NewDraft {
  const d = (getAction(hh.db, id)!.plan_json as { draft: Omit<NewDraft, "idempotencyKey"> }).draft;
  return {
    threadId: d.threadId,
    idempotencyKey: "0".repeat(64),
    inReplyTo: d.inReplyTo,
    references: d.references,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    body: d.body,
  };
}

/** The first read after the next POST fails, once: the lookup right after a failed write. */
function failNextReadAfterPost(state: ReturnType<typeof gmailLike>["state"]): void {
  state.onPost = () => {
    state.failReads = 1;
    state.onPost = undefined;
  };
}

/** A second ledger connection to the same file: what another server process would hold. */
function otherProcess(hh: H): AppContext {
  const file = hh.db.all<{ file: string }>("PRAGMA database_list")[0]!.file;
  second = LedgerDb.open(file);
  return { ...hh.ctx, db: second };
}

const status = (hh: H, id: string) => getAction(hh.db, id)!.status;
const draftIdOf = (hh: H, id: string) => (getAction(hh.db, id)!.result_json as { draftId: string }).draftId;
const landed = (hh: H, id: string): unknown[] =>
  hh
    .rows()
    .filter((r) => r.action_id === id && r.kind === "write_landed")
    .map((r) => (JSON.parse(r.preview_json) as { output: { writeId: unknown } }).output.writeId);

describe("a normal apply records the provider's draft id", () => {
  it("one POST, a write_landed row (ok, action_apply) with the draft id between the claim and applied", async () => {
    const { hh, id, state } = await setup();
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false, output: { draft_id: "dr_1" } });
    expect(state.posts).toBe(1);
    expect(status(hh, id)).toBe("applied");
    const kinds = hh.rows().filter((r) => r.action_id === id && r.kind !== "tool_call").map((r) => r.kind);
    expect(kinds).toEqual(["plan_created", "approved", "cli_command", "write_claimed", "write_landed", "applied"]);
    const row = hh.rows().find((r) => r.action_id === id && r.kind === "write_landed")!;
    expect(row).toMatchObject({ tool: "action_apply", outcome: "ok", error_code: null });
    expect(landed(hh, id)).toEqual(["dr_1"]);
    expect((getAction(hh.db, id)!.result_json as { messageIdHeader: string }).messageIdHeader).toBe("<gmail-1@mail.gmail.com>");
  });

  it("a replay of the applied action reads and writes nothing", async () => {
    const { hh, id, state } = await setup();
    const first = await applyAction(hh.ctx, id);
    const reads = state.lookups;
    const again = await applyAction(hh.ctx, id);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect((again as { output: unknown }).output).toEqual((first as { output: unknown }).output);
    expect(state.posts).toBe(1);
    expect(state.lookups).toBe(reads);
  });

  it("a read-back failure after the id came back: the retry finds the draft by its recorded id, with one POST", async () => {
    const { hh, id, state } = await setup();
    state.postFails = {
      error: new ProviderError("gmail", "createDraft", { phrase: "the draft was created but could not be read back", retryable: true }),
      lands: true,
      confirmed: true,
    };
    failNextReadAfterPost(state); // the lookup right after the failed write fails too
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(landed(hh, id)).toEqual(["dr_1"]);
    state.hidden = true; // the thread's list has not caught up: only the recorded id finds it
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr_1" } });
    expect(state.posts).toBe(1);
  });
});

describe("no id recorded: the draft is found by its content", () => {
  it("a crash after the POST and before the id was recorded: the retry after the hold adopts the draft, one POST", async () => {
    const { hh, id, state, seed } = await setup();
    const other = otherProcess(hh);
    // The process dies while the POST is in flight: the draft lands, the promise never settles, nothing is recorded.
    let landedDraft!: () => void;
    const inPost = new Promise<void>((r) => (landedDraft = r));
    state.onPost = () => {
      seed(approvedDraft(hh, id));
      landedDraft();
      return new Promise<void>(() => undefined);
    };
    void applyAction(hh.ctx, id);
    await inPost;
    expect(landed(hh, id)).toEqual([]);

    at(HOLD);
    expect(await applyAction(other, id)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr_1" } });
    expect(state.posts).toBe(1);
    expect(state.stored).toHaveLength(1);
    expect(landed(hh, id)).toEqual(["dr_1"]);
  });

  it("a 500 with no id that landed: refused, and after the hold the draft is found by content with no second POST", async () => {
    const { hh, id, state } = await setup();
    state.postFails = { error: new ProviderError("gmail", "createDraft", { status: 500 }), lands: true };
    state.hidden = true;
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(status(hh, id)).toBe("approved");
    expect(landed(hh, id)).toEqual([]);

    state.hidden = false;
    at(HOLD);
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr_1" } });
    expect(state.posts).toBe(1);
    expect(state.stored).toHaveLength(1);
  });

  it("a draft that differs in any approved field is never adopted by content", async () => {
    const { hh, id, state, seed } = await setup();
    seed({ ...approvedDraft(hh, id), body: `${BODY}\n\nP.S.` });
    seed({ ...approvedDraft(hh, id), bcc: ["eve@example.com"] });
    seed({ ...approvedDraft(hh, id), subject: "Re: something else" });
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false, output: { draft_id: "dr_4" } });
    expect(state.posts).toBe(1);
  });
});

describe("the user changed the draft after the id was recorded", () => {
  /** An apply whose POST landed and recorded its id, then could not settle: the plan stays approved. */
  async function landedButUnsettled() {
    const s = await setup();
    s.state.postFails = {
      error: new ProviderError("gmail", "createDraft", { phrase: "the draft was created but could not be read back", retryable: true }),
      lands: true,
      confirmed: true,
    };
    failNextReadAfterPost(s.state);
    expect(await applyAction(s.hh.ctx, s.id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(landed(s.hh, s.id)).toEqual(["dr_1"]);
    return s;
  }

  it("deleted: the plan fails STALE_PLAN with the deleted phrase and the draft is never created again", async () => {
    const { hh, id, state, seed } = await landedButUnsettled();
    state.stored.length = 0;
    seed(approvedDraft(hh, id)); // an identical draft elsewhere in the thread is not taken in its place
    at(HOLD);
    expect(await applyAction(hh.ctx, id)).toEqual({ ok: false, errorCode: "STALE_PLAN", message: DELETED });
    expect(status(hh, id)).toBe("failed");
    expect(state.posts).toBe(1);
  });

  it("edited: the plan fails STALE_PLAN with the differs phrase and no second POST", async () => {
    const { hh, id, state } = await landedButUnsettled();
    state.stored[0] = { ...state.stored[0]!, bodySha256: "f".repeat(64) };
    at(HOLD);
    expect(await applyAction(hh.ctx, id)).toEqual({ ok: false, errorCode: "STALE_PLAN", message: DIFFERS });
    expect(status(hh, id)).toBe("failed");
    expect(state.posts).toBe(1);
  });
});

describe("two identical drafts in the thread", () => {
  it("the oldest unclaimed one is adopted and the other never is", async () => {
    const { hh, ids, state, seed } = await setup(3);
    const [a, b, c] = ids as [string, string, string];
    seed(approvedDraft(hh, a)); // dr_1, oldest
    seed(approvedDraft(hh, a)); // dr_2

    expect(await applyAction(hh.ctx, a)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr_1" } });
    expect(landed(hh, a)).toEqual(["dr_1"]);
    // Another action with the same content takes the one that is left, never the one action a recorded.
    expect(await applyAction(hh.ctx, b)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr_2" } });
    // Nothing unclaimed is left, so the third writes its own.
    expect(await applyAction(hh.ctx, c)).toMatchObject({ ok: true, replayed: false, output: { draft_id: "dr_3" } });
    expect(state.posts).toBe(1);
    expect([draftIdOf(hh, a), draftIdOf(hh, b), draftIdOf(hh, c)]).toEqual(["dr_1", "dr_2", "dr_3"]);
  });

  it("a draft id recorded by another action that has not settled yet is never adopted", async () => {
    const { hh, ids, state } = await setup(2);
    const [a, b] = ids as [string, string];
    state.postFails = {
      error: new ProviderError("gmail", "createDraft", { phrase: "the draft was created but could not be read back", retryable: true }),
      lands: true,
      confirmed: true,
    };
    failNextReadAfterPost(state);
    expect(await applyAction(hh.ctx, a)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(landed(hh, a)).toEqual(["dr_1"]);

    expect(await applyAction(hh.ctx, b)).toMatchObject({ ok: true, replayed: false, output: { draft_id: "dr_2" } });
    expect(await applyAction(hh.ctx, a)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr_1" } });
    expect(state.posts).toBe(2);
  });
});
