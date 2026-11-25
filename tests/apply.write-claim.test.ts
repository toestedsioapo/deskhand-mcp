import { afterEach, describe, expect, it } from "vitest";
import type { AppContext } from "../src/app-context.js";
import { applyAction } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import { sweepDraftBodies } from "../src/approval/body-sweep.js";
import { takeWriteClaim } from "../src/approval/write-claim.js";
import { writeRecords } from "../src/approval/write-landed.js";
import type { CliIo } from "../src/cli/io.js";
import { getAction } from "../src/ledger/actions.js";
import { LedgerDb } from "../src/ledger/db.js";
import { last4 } from "../src/ledger/ids.js";
import { AuthRequiredError, ProviderError } from "../src/providers/errors.js";
import { createFixtureMailProvider } from "../src/providers/fixture/index.js";
import type { NewDraft } from "../src/providers/types.js";
import { gmailLike } from "./helpers/gmail-like.js";
import { NOW, setupHarness } from "./helpers/harness.js";
import { mailWorld, msg, type Thread } from "./helpers/mail-world.js";
import { seedAction } from "./helpers/seed.js";

// The draft write claim (M4b decision 8). The values are spelled out here, not imported, so these tests pin the
// contract and fail on behaviour (two POSTs) rather than on a missing symbol.
const HOLD = 60_000;
const START_LIMIT = 30_000;
const HELD = "another apply of this action is in progress or may still be landing; retry in a minute";
const LANDING = "an earlier write attempt may still be landing; retry later";
const HELD_REFUSAL = { ok: false, errorCode: "PROVIDER_ERROR", message: HELD };

const BODY = "Thanks Ben,\n\nThe numbers look right to me.\n\n-- \nMe";
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
/** Sets the clock to `ms` after the start of the test. */
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

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const approvalIo = (id: string): CliIo => ({
  out: () => undefined,
  err: () => undefined,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  readLine: async () => last4(id),
});

/** An approved draft plan on a Gmail-like mailbox, with a clock the test moves. */
async function setup() {
  const hh = await setupHarness({ env: { DESKHAND_ALLOW_WRITES: "1" } });
  h = hh;
  const base = createFixtureMailProvider(mailWorld([THREAD]));
  hh.ctx.mail = base;
  const r = await hh.client.callTool({ name: "inbox_draft_reply", arguments: { thread_id: "th_budget", body: BODY } });
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  const id = (r.structuredContent as { action_id: string }).action_id;
  expect(await approveAction(hh.ctx, id, approvalIo(id))).toEqual({ ok: true });
  const { mail, state, seed } = gmailLike(base);
  hh.ctx.mail = mail;
  hh.ctx.clock = () => new Date(now);
  return { hh, id, state, seed };
}

/** The approved draft of an action, as the engine would hand it to the provider. */
function approvedDraft(hh: H, id: string): NewDraft {
  const d = (getAction(hh.db, id)!.plan_json as { draft: Omit<NewDraft, "idempotencyKey"> }).draft;
  return { ...d, idempotencyKey: "0".repeat(64), body: BODY };
}

/** A second ledger connection to the same file: what another server process would hold. */
function otherProcess(hh: H): AppContext {
  const file = hh.db.all<{ file: string }>("PRAGMA database_list")[0]!.file;
  second = LedgerDb.open(file);
  return { ...hh.ctx, db: second };
}

const status = (hh: H, id: string) => getAction(hh.db, id)!.status;
const rowsOf = (hh: H, id: string, kind: string) => hh.rows().filter((r) => r.action_id === id && r.kind === kind);
const claims = (hh: H, id: string) => rowsOf(hh, id, "write_claimed");
const released = (hh: H, id: string): unknown[] =>
  rowsOf(hh, id, "apply_refused")
    .map((r) => (JSON.parse(r.preview_json) as { output?: { releasedClaim?: unknown } | null }).output?.releasedClaim)
    .filter((v) => v !== undefined);

describe("one POST per action", () => {
  it("two concurrent applies give one POST: the second is refused with the fixed note", async () => {
    const { hh, id, state } = await setup();
    const other = otherProcess(hh);
    const inPost = deferred();
    const finishPost = deferred();
    state.onPost = () => {
      inPost.resolve();
      return finishPost.promise;
    };
    const first = applyAction(hh.ctx, id);
    await inPost.promise;

    expect(await applyAction(other, id)).toEqual(HELD_REFUSAL);
    expect(state.posts).toBe(1);
    expect(status(hh, id)).toBe("approved");

    finishPost.resolve();
    expect(await first).toMatchObject({ ok: true, replayed: false });
    expect(state.posts).toBe(1);
    expect(state.stored).toHaveLength(1);
    expect(status(hh, id)).toBe("applied");
    expect(claims(hh, id)).toHaveLength(1);
  });

  it("a successful draft apply records write_claimed (ok, action_apply), then write_landed, before applied", async () => {
    const { hh, id } = await setup();
    await applyAction(hh.ctx, id);
    const kinds = hh.rows().filter((r) => r.action_id === id && r.kind !== "tool_call").map((r) => r.kind);
    expect(kinds).toEqual(["plan_created", "approved", "cli_command", "write_claimed", "write_landed", "applied"]);
    expect(claims(hh, id)[0]).toMatchObject({ tool: "action_apply", outcome: "ok", error_code: null });
  });

  it("a crash after the claim and before the POST, then a retry: refused before 60 s, one draft after", async () => {
    const { hh, id, state } = await setup();
    const other = otherProcess(hh);
    // The process dies during its lookup under the claim: this promise never settles.
    const reached = deferred();
    state.onLookup = (n) => {
      if (n !== 2) return undefined;
      reached.resolve();
      return new Promise<void>(() => undefined);
    };
    const crashed = applyAction(hh.ctx, id);
    await Promise.race([reached.promise, crashed]);
    expect(state.posts).toBe(0);
    state.onLookup = undefined;

    at(HOLD - 1);
    expect(await applyAction(other, id)).toEqual(HELD_REFUSAL);
    expect(state.posts).toBe(0);

    at(HOLD);
    expect(await applyAction(other, id)).toMatchObject({ ok: true, replayed: false });
    expect(state.posts).toBe(1);
    expect(state.stored).toHaveLength(1);
    expect(status(hh, id)).toBe("applied");
  });

  it("a 500 that landed, then a retry with search not indexed gives one draft", async () => {
    const { hh, id, state } = await setup();
    state.postFails = { error: new ProviderError("gmail", "createDraft", { status: 500 }), lands: true };
    state.hidden = true;
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(state.stored).toHaveLength(1);

    at(HOLD - 1);
    expect(await applyAction(hh.ctx, id)).toEqual(HELD_REFUSAL);

    // Search still misses it; only the route through the plan's thread finds it.
    state.hidden = false;
    at(HOLD);
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true });
    expect(state.posts).toBe(1);
    expect(state.stored).toHaveLength(1);
    const applied = rowsOf(hh, id, "applied");
    expect((JSON.parse(applied[0]!.preview_json) as { note: unknown }).note).toBe("recovered");
    expect(claims(hh, id)).toHaveLength(1);
  });

  it("a 500 that did not land: refused at 59 999 ms, and at 60 000 ms the retry POSTs and ends applied", async () => {
    const { hh, id, state } = await setup();
    state.postFails = { error: new ProviderError("gmail", "createDraft", { status: 500 }), lands: false };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(released(hh, id)).toEqual([]);

    expect(await applyAction(hh.ctx, id)).toEqual(HELD_REFUSAL);
    at(HOLD - 1);
    expect(await applyAction(hh.ctx, id)).toEqual(HELD_REFUSAL);
    expect(state.posts).toBe(1);

    at(HOLD);
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false });
    expect(state.posts).toBe(2);
    expect(state.stored).toHaveLength(1);
    expect(status(hh, id)).toBe("applied");
  });

  it.each([
    ["a timeout", () => new ProviderError("gmail", "createDraft", { phrase: "timed out", retryable: true })],
    ["a 429", () => new ProviderError("gmail", "createDraft", { status: 429 })],
    ["an unreadable 2xx", () => new ProviderError("gmail", "createDraft", { phrase: "unreadable response", retryable: true })],
    ["a single-send 401", () => new ProviderError("gmail", "createDraft", { phrase: "access token refreshed; retry", retryable: true })],
  ])("%s never releases the claim", async (_name, error) => {
    const { hh, id, state } = await setup();
    state.postFails = { error: error(), lands: false };
    await applyAction(hh.ctx, id);
    expect(released(hh, id)).toEqual([]);
    expect(await applyAction(hh.ctx, id)).toEqual(HELD_REFUSAL);
    expect(state.posts).toBe(1);
  });

  it("a definite write failure ends the plan failed with no release row", async () => {
    const { hh, id, state } = await setup();
    state.postFails = { error: new ProviderError("gmail", "createDraft", { status: 400 }), lands: false };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(status(hh, id)).toBe("failed");
    expect(released(hh, id)).toEqual([]);
  });
});

describe("exits known to have sent no POST release the claim", () => {
  it("an auth failure before the request releases the claim: an immediate retry may POST", async () => {
    const { hh, id, state } = await setup();
    state.postFails = { error: new AuthRequiredError(), lands: false };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "AUTH_REQUIRED" });
    expect(released(hh, id)).toEqual([claims(hh, id)[0]!.id]);
    expect(status(hh, id)).toBe("approved");

    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false });
    expect(state.posts).toBe(2);
    expect(state.stored).toHaveLength(1);
  });

  it("an auth failure whose follow-up lookup also fails releases the claim", async () => {
    const { hh, id, state } = await setup();
    state.postFails = { error: new AuthRequiredError(), lands: false };
    state.onLookup = (n) => {
      if (n === 3) throw new ProviderError("gmail", "threadDrafts", { status: 503 });
    };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(released(hh, id)).toEqual([claims(hh, id)[0]!.id]);
  });

  it("an auth failure whose follow-up lookup finds the draft is recovered, with no release", async () => {
    const { hh, id, state } = await setup();
    state.postFails = { error: new AuthRequiredError(), lands: true };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true });
    expect(released(hh, id)).toEqual([]);
    expect(status(hh, id)).toBe("applied");
  });

  it("a lookup failure after the claim releases it, with no POST", async () => {
    const { hh, id, state } = await setup();
    state.onLookup = (n) => {
      if (n === 2) throw new ProviderError("gmail", "threadDrafts", { status: 503 });
    };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(state.posts).toBe(0);
    expect(released(hh, id)).toEqual([claims(hh, id)[0]!.id]);

    state.onLookup = undefined;
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false });
    expect(state.posts).toBe(1);
  });

  it("the start limit: a post-claim lookup that outlasts 30 s refuses with no POST and releases", async () => {
    const { hh, id, state } = await setup();
    state.onLookup = (n) => {
      if (n === 2) at(START_LIMIT);
    };
    expect(await applyAction(hh.ctx, id)).toEqual(HELD_REFUSAL);
    expect(state.posts).toBe(0);
    expect(released(hh, id)).toEqual([claims(hh, id)[0]!.id]);
    expect(status(hh, id)).toBe("approved");
  });

  it("a post-claim lookup that takes 29 999 ms still POSTs", async () => {
    const { hh, id, state } = await setup();
    state.onLookup = (n) => {
      if (n === 2) at(START_LIMIT - 1);
    };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false });
    expect(state.posts).toBe(1);
  });

  it("a refusal from a process whose claim was superseded never releases the newer claim", async () => {
    const { hh, id, state } = await setup();
    const other = otherProcess(hh);
    // A stalls in its lookup under the claim.
    const aStalled = deferred();
    const aResume = deferred();
    state.onLookup = (n) => {
      if (n !== 2) return undefined;
      aStalled.resolve();
      return aResume.promise;
    };
    const a = applyAction(hh.ctx, id);
    await Promise.race([aStalled.promise, a]);
    state.onLookup = undefined;

    // After the hold, B takes a new claim and is inside its POST.
    at(HOLD);
    const inPost = deferred();
    const finishPost = deferred();
    state.onPost = () => {
      inPost.resolve();
      return finishPost.promise;
    };
    const b = applyAction(other, id);
    await inPost.promise;
    const [claimA, claimB] = claims(hh, id);

    // A wakes up to a failed lookup: it releases only its own claim.
    aResume.reject(new ProviderError("gmail", "threadDrafts", { status: 503 }));
    expect(await a).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(released(hh, id)).toEqual([claimA!.id]);

    // B's claim still holds.
    expect(await applyAction(hh.ctx, id)).toEqual(HELD_REFUSAL);
    expect(released(hh, id)).not.toContain(claimB!.id);
    expect(state.posts).toBe(1);

    finishPost.resolve();
    expect(await b).toMatchObject({ ok: true });
    expect(state.stored).toHaveLength(1);
  });

  it("a process that lost its claim during the lookup does not POST", async () => {
    const { hh, id, state } = await setup();
    const other = otherProcess(hh);
    const aStalled = deferred();
    const aResume = deferred();
    state.onLookup = (n) => {
      if (n !== 2) return undefined;
      aStalled.resolve();
      return aResume.promise;
    };
    const a = applyAction(hh.ctx, id);
    await Promise.race([aStalled.promise, a]);
    state.onLookup = undefined;

    at(HOLD);
    const inPost = deferred();
    const finishPost = deferred();
    state.onPost = () => {
      inPost.resolve();
      return finishPost.promise;
    };
    const b = applyAction(other, id);
    await inPost.promise;

    aResume.resolve();
    expect(await a).toEqual(HELD_REFUSAL);
    expect(state.posts).toBe(1);
    finishPost.resolve();
    expect(await b).toMatchObject({ ok: true });
    expect(state.stored).toHaveLength(1);
  });
});

describe("the claim and the other gates", () => {
  it("a failed re-check under a live claim stays approved, with the retryable note", async () => {
    const { hh, id, state } = await setup();
    const other = otherProcess(hh);
    const inPost = deferred();
    const finishPost = deferred();
    state.onPost = () => {
      inPost.resolve();
      return finishPost.promise;
    };
    const first = applyAction(hh.ctx, id);
    await inPost.promise;

    state.threadChanged = true;
    at(HOLD - 1);
    expect(await applyAction(other, id)).toEqual({ ok: false, errorCode: "PROVIDER_ERROR", message: LANDING });
    expect(status(hh, id)).toBe("approved");

    finishPost.resolve();
    expect(await first).toMatchObject({ ok: true });
  });

  it("a failed re-check with a released claim is terminal as usual", async () => {
    const { hh, id, state } = await setup();
    state.postFails = { error: new AuthRequiredError(), lands: false };
    await applyAction(hh.ctx, id);
    state.threadChanged = true;
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "STALE_PLAN" });
    expect(status(hh, id)).toBe("failed");
  });

  it("recovery at gate 6 writes no claim", async () => {
    const { hh, id, state, seed } = await setup();
    seed(approvedDraft(hh, id));
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true });
    expect(state.posts).toBe(0);
    expect(claims(hh, id)).toEqual([]);
  });

  it("a draft that appears during the lookup under the claim is recovered, with no POST", async () => {
    const { hh, id, state, seed } = await setup();
    state.onLookup = (n) => {
      if (n === 2) seed(approvedDraft(hh, id));
    };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true });
    expect(state.posts).toBe(0);
    expect(state.stored).toHaveLength(1);
    expect(claims(hh, id)).toHaveLength(1);
  });

  describe("row sequences after the claim (ledger contract)", () => {
    const sequence = (hh: H, id: string) =>
      hh.rows().filter((r) => r.action_id === id && !["plan_created", "approved", "cli_command", "tool_call"].includes(r.kind)).map((r) => r.kind);

    it("an ambiguous write: write_claimed, apply_refused; unchanged", async () => {
      const { hh, id, state } = await setup();
      state.postFails = { error: new ProviderError("gmail", "createDraft", { status: 503 }), lands: false };
      await applyAction(hh.ctx, id);
      expect(sequence(hh, id)).toEqual(["write_claimed", "apply_refused"]);
      expect(status(hh, id)).toBe("approved");
    });

    it("an ambiguous write whose lookup needs a sign-in: write_claimed, apply_refused (AUTH_REQUIRED), claim kept", async () => {
      const { hh, id, state } = await setup();
      state.postFails = { error: new ProviderError("gmail", "createDraft", { status: 503 }), lands: false };
      state.onLookup = (n) => {
        if (n === 3) throw new AuthRequiredError();
      };
      expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "AUTH_REQUIRED" });
      expect(sequence(hh, id)).toEqual(["write_claimed", "apply_refused"]);
      expect(released(hh, id)).toEqual([]);
    });

    it("a definite write failure whose lookup fails: write_claimed, apply_refused, claim kept", async () => {
      const { hh, id, state } = await setup();
      state.postFails = { error: new ProviderError("gmail", "createDraft", { status: 400 }), lands: false };
      state.onLookup = (n) => {
        if (n === 3) throw new ProviderError("gmail", "threadDrafts", { status: 503 });
      };
      expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
      expect(sequence(hh, id)).toEqual(["write_claimed", "apply_refused"]);
      expect(released(hh, id)).toEqual([]);
      expect(status(hh, id)).toBe("approved");
    });

    it("a definite write failure: write_claimed, apply_failed; failed", async () => {
      const { hh, id, state } = await setup();
      state.postFails = { error: new ProviderError("gmail", "createDraft", { status: 400 }), lands: false };
      await applyAction(hh.ctx, id);
      expect(sequence(hh, id)).toEqual(["write_claimed", "apply_failed"]);
      expect(status(hh, id)).toBe("failed");
    });

    it("this action's recorded draft, edited, found under the claim: apply_failed (STALE_PLAN); failed, no POST", async () => {
      const { hh, id, state, seed } = await setup();
      // Another process of this action POSTs and records its draft while this one is in its recovery lookup; the
      // user then edits it.
      state.onLookup = (n) => {
        if (n !== 1) return;
        const d = seed({ ...approvedDraft(hh, id), subject: "Edited" });
        writeRecords(hh.ctx, id).record(d.draftId);
      };
      expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "STALE_PLAN" });
      expect(sequence(hh, id)).toEqual(["write_landed", "write_claimed", "apply_failed"]);
      expect(state.posts).toBe(0);
    });
  });

  it("calendar applies write no write_claimed row and keep their row sequence", async () => {
    const hh = await setupHarness({ env: { DESKHAND_ALLOW_WRITES: "1" } });
    h = hh;
    const id = seedAction(hh.ctx, "approved");
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false });
    expect(hh.rows().filter((r) => r.action_id === id).map((r) => r.kind)).toEqual(["plan_created", "applied"]);
  });
});

describe("write-claim.ts", () => {
  const load = () => import("../src/approval/write-claim.js");

  it("exports the contract's values", async () => {
    const m = await load();
    expect(m.WRITE_CLAIM_HOLD_MS).toBe(HOLD);
    expect(m.WRITE_CLAIM_START_LIMIT_MS).toBe(START_LIMIT);
  });

  it("takes a claim, refuses while it is held, and reports it live", async () => {
    const m = await load();
    const { hh, id } = await setup();
    expect(m.hasLiveClaim(hh.ctx, id)).toBe(false);
    const c = m.takeWriteClaim(hh.ctx, id);
    expect(c).toMatchObject({ ok: true });
    expect(m.hasLiveClaim(hh.ctx, id)).toBe(true);
    expect(m.takeWriteClaim(hh.ctx, id)).toEqual({ ok: false, reason: "held" });
    at(HOLD);
    expect(m.hasLiveClaim(hh.ctx, id)).toBe(false);
  });

  it("refuses a plan that is not approved", async () => {
    const m = await load();
    const { hh, id } = await setup();
    hh.db.run("UPDATE actions SET status = 'failed' WHERE id = ?", [id]);
    expect(m.takeWriteClaim(hh.ctx, id)).toEqual({ ok: false, reason: "not_approved" });
    expect(claims(hh, id)).toEqual([]);
  });

  it("an unparseable claim ts counts as held (fail closed)", async () => {
    const m = await load();
    const { hh, id } = await setup();
    hh.db.run(
      "INSERT INTO events (ts, action_id, tool, kind, outcome, preview_json) VALUES ('not-a-time', ?, 'action_apply', 'write_claimed', 'ok', '{}')",
      [id],
    );
    expect(m.hasLiveClaim(hh.ctx, id)).toBe(true);
    expect(m.takeWriteClaim(hh.ctx, id)).toEqual({ ok: false, reason: "held" });
  });

  it("claimStillValid: only the newest claim, on an approved plan, inside the start limit", async () => {
    const m = await load();
    const { hh, id } = await setup();
    const c = m.takeWriteClaim(hh.ctx, id);
    if (!c.ok) throw new Error("no claim");
    expect(m.claimStillValid(hh.ctx, id, c.claimId)).toBe(true);
    at(START_LIMIT - 1);
    expect(m.claimStillValid(hh.ctx, id, c.claimId)).toBe(true);
    at(START_LIMIT);
    expect(m.claimStillValid(hh.ctx, id, c.claimId)).toBe(false);
    at(HOLD);
    const next = m.takeWriteClaim(hh.ctx, id);
    if (!next.ok) throw new Error("no second claim");
    expect(m.claimStillValid(hh.ctx, id, c.claimId)).toBe(false);
    expect(m.claimStillValid(hh.ctx, id, next.claimId)).toBe(true);
    hh.db.run("UPDATE actions SET status = 'failed' WHERE id = ?", [id]);
    expect(m.claimStillValid(hh.ctx, id, next.claimId)).toBe(false);
  });

  it("a clock that moved behind the claim: still held, and no longer valid to start a POST", async () => {
    const m = await load();
    const { hh, id } = await setup();
    at(1000);
    const c = m.takeWriteClaim(hh.ctx, id);
    if (!c.ok) throw new Error("no claim");
    at(0);
    expect(m.hasLiveClaim(hh.ctx, id)).toBe(true);
    expect(m.takeWriteClaim(hh.ctx, id)).toEqual({ ok: false, reason: "held" });
    expect(m.claimStillValid(hh.ctx, id, c.claimId)).toBe(false);
  });

  it("a release row naming another claim id does not release this claim; one naming this claim does", async () => {
    const m = await load();
    const { hh, id } = await setup();
    const c = m.takeWriteClaim(hh.ctx, id);
    if (!c.ok) throw new Error("no claim");
    hh.db.run(
      "INSERT INTO events (ts, action_id, tool, kind, outcome, error_code, preview_json) VALUES (?, ?, 'action_apply', 'apply_refused', 'error', 'PROVIDER_ERROR', ?)",
      [NOW, id, JSON.stringify({ v: 1, input: null, output: { releasedClaim: c.claimId + 1000 }, note: "x" })],
    );
    expect(m.hasLiveClaim(hh.ctx, id)).toBe(true);
    hh.db.run(
      "INSERT INTO events (ts, action_id, tool, kind, outcome, error_code, preview_json) VALUES (?, ?, 'action_apply', 'apply_refused', 'error', 'PROVIDER_ERROR', ?)",
      [NOW, id, JSON.stringify({ v: 1, input: null, output: { releasedClaim: c.claimId }, note: "x" })],
    );
    expect(m.hasLiveClaim(hh.ctx, id)).toBe(false);
  });
});

describe("the last check before the POST re-reads the stored plan (M4b fix wave A)", () => {
  const SWEPT = "The plan's content was removed after the action ended; it can no longer be written.";
  const UNDER_CLAIM = 2; // the recovery lookup is the first, the one under the claim the second
  const expiryOf = (hh: H, id: string): number => Date.parse(getAction(hh.db, id)!.expires_at);

  it.each([
    ["past expiry", 5000],
    ["exactly at expiry", 0],
    ["past expiry and past the start limit", START_LIMIT + 1000],
  ])("the clock reaches %s during the lookup: PLAN_EXPIRED, no POST, status unchanged, claim released", async (_n, after) => {
    const { hh, id, state } = await setup();
    const expires = expiryOf(hh, id);
    now = expires - 5000;
    state.onLookup = (n) => {
      if (n === UNDER_CLAIM) now = expires + after;
    };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PLAN_EXPIRED" });
    expect(state.posts).toBe(0);
    expect(status(hh, id)).toBe("approved");
    expect(released(hh, id)).toEqual([claims(hh, id)[0]!.id]);
    const row = rowsOf(hh, id, "apply_refused")[0]!;
    expect([row.outcome, row.error_code]).toEqual(["rejected", "PLAN_EXPIRED"]);
  });

  it("an expires_at that no longer parses fails closed", async () => {
    const { hh, id, state } = await setup();
    state.onLookup = (n) => {
      if (n === UNDER_CLAIM) hh.db.run("UPDATE actions SET expires_at = 'not-a-time' WHERE id = ?", [id]);
    };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PLAN_EXPIRED" });
    expect(state.posts).toBe(0);
    expect(status(hh, id)).toBe("approved");
  });

  it("a sweep on another connection removes the body during the lookup: PLAN_MODIFIED, failed, no POST", async () => {
    const { hh, id, state } = await setup();
    const expires = expiryOf(hh, id);
    const other = { ...otherProcess(hh), clock: () => new Date(expires) }; // that process's clock is ahead of ours
    state.onLookup = (n) => {
      if (n === UNDER_CLAIM) expect(sweepDraftBodies(other)).toBe(1);
    };
    expect(await applyAction(hh.ctx, id)).toEqual({ ok: false, errorCode: "PLAN_MODIFIED", message: SWEPT });
    expect(state.posts).toBe(0);
    expect(status(hh, id)).toBe("failed");
    expect(rowsOf(hh, id, "apply_failed")).toHaveLength(1);
  });

  it("an apply just inside the expiry still writes", async () => {
    const { hh, id, state } = await setup();
    const expires = expiryOf(hh, id);
    now = expires - 5000;
    state.onLookup = (n) => {
      if (n === UNDER_CLAIM) now = expires - 1;
    };
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false });
    expect(state.posts).toBe(1);
    expect(status(hh, id)).toBe("applied");
  });

  it("a claim another apply took over is still the held refusal, even past expiry", async () => {
    const { hh, id, state } = await setup();
    const expires = expiryOf(hh, id);
    now = expires - HOLD - 1000;
    state.onLookup = (n) => {
      if (n !== UNDER_CLAIM) return;
      now = expires - 1000;
      expect(takeWriteClaim(hh.ctx, id).ok).toBe(true);
      now = expires;
    };
    expect(await applyAction(hh.ctx, id)).toEqual(HELD_REFUSAL);
    expect(state.posts).toBe(0);
    expect(status(hh, id)).toBe("approved");
  });
});
