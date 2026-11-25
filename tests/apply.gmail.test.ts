import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { applyAction, idempotencyKey } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import { takeWriteClaim } from "../src/approval/write-claim.js";
import { writeRecords } from "../src/approval/write-landed.js";
import type { CliIo } from "../src/cli/io.js";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE, SCOPE_GMAIL_COMPOSE, SCOPE_GMAIL_READ } from "../src/config/scopes.js";
import { getAction } from "../src/ledger/actions.js";
import { last4 } from "../src/ledger/ids.js";
import { createGmailProvider } from "../src/providers/google/gmail.js";
import { assertAllowedGmailRequest } from "../src/providers/google/http.js";
import { buildDraftMime } from "../src/providers/google/mime.js";
import { GOOGLE_ENDPOINTS } from "../src/providers/google/oauth.js";
import { writeToken } from "../src/providers/google/token-store.js";
import { NOW, setupHarness } from "./helpers/harness.js";
import { replayFetch, type Replay } from "./helpers/replay-fetch.js";

const ACTION_ID = "act_01JC3Z8K4V7Q2W9X5R6T1N0BHM";
const KEY = "088afa7571116bd6a8f7b781318e85bd9a37eed81b5140bfe630e9f752558fa8";
const GMAIL_HEADER = "<gmail-assigned-1@example.com>";
const BODY = "Thanks Ana,\n\nThe numbers look right.";
const DIFFERS = "a draft with this action's id exists but differs from the approved plan";
const THREAD_CHANGED = "The world changed since planning: the thread's messages changed since planning.";
const HOLD = 60_000;

/** What planning reads. */
const PLAN = ["gmail-reply-thread-minimal", "gmail-reply-thread-full", "gmail-profile"];
/** A content lookup (only for an action that may have written) finding no draft in the account. A fresh apply reads nothing. */
const NOTHING = ["gmail-drafts-list-none"];
const RECHECK = ["gmail-profile", "gmail-reply-thread-minimal", "gmail-reply-thread-full"];
/** The POST and its read-back: Gmail stores its own Message-ID (M4b live check). */
const WRITE = ["gmail-drafts-create-200", "gmail-draft-get-gmail-header"];
/** A lookup with no id recorded that finds the approved draft in the thread by its content. */
const BY_CONTENT = ["gmail-drafts-list-reply", "gmail-draft-get-gmail-header"];
/** A lookup by the recorded draft id. */
const BY_ID = ["gmail-draft-get-gmail-header"];

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
let replay: Replay | undefined;
const BASE = Date.parse(NOW);
let now = BASE;

afterEach(async () => {
  try {
    replay?.verify();
  } finally {
    replay = undefined;
    await h?.close();
    h = undefined;
    now = BASE;
  }
});

const approvalIo = (id: string): CliIo => ({
  out: () => undefined,
  err: () => undefined,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  readLine: async () => last4(id),
});

/** The real tool, approval and engine over the real Gmail adapter, served only by recordings. */
async function setup(names: string[]) {
  const hh = await setupHarness({ env: { DESKHAND_ALLOW_WRITES: "1" } });
  h = hh;
  const configDir = hh.ctx.config.paths.configDir;
  mkdirSync(configDir, { recursive: true });
  writeToken(configDir, {
    version: 1,
    client_id: "cid.apps.googleusercontent.com",
    scopes: [SCOPE_CALENDAR_READ, SCOPE_GMAIL_READ, SCOPE_CALENDAR_WRITE, SCOPE_GMAIL_COMPOSE],
    refresh_token: "1//REFRESH-SECRET",
    access_token: "ya29.OLD-ACCESS-TOKEN",
    expires_at: new Date(BASE + 30 * 60_000).toISOString(),
    obtained_at: "2026-11-09T10:00:00.000Z",
  });
  replay = replayFetch([...PLAN, ...names]);
  const f = replay.fetch;
  const clock = () => new Date(now);
  hh.ctx.clock = clock;
  hh.ctx.ids = { newActionId: () => ACTION_ID };
  hh.ctx.mail = createGmailProvider({ fetch: f, configDir, now: clock, oauth: { fetch: f, endpoints: GOOGLE_ENDPOINTS, now: clock } });
  const r = await hh.client.callTool({
    name: "inbox_draft_reply",
    arguments: { thread_id: "t-reply", body: BODY, bcc: ["boss@example.com"] },
  });
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  const id = (r.structuredContent as { action_id: string }).action_id;
  expect(id).toBe(ACTION_ID);
  expect(await approveAction(hh.ctx, id, approvalIo(id))).toEqual({ ok: true });
  return { hh, id };
}

const draftPosts = () => replay!.seen.filter((r) => r.method === "POST" && r.url.endsWith("/gmail/v1/users/me/drafts"));
const status = (hh: H, id: string) => getAction(hh.db, id)!.status;
const dump = (hh: H) => JSON.stringify([hh.db.all("SELECT * FROM actions"), hh.db.all("SELECT * FROM events")]);

describe("apply through Gmail", () => {
  it("the recordings' key is this action's", () => {
    expect(idempotencyKey(ACTION_ID)).toBe(KEY);
  });

  it("a normal apply ends applied with one POST carrying the approved draft, though Gmail rewrote its Message-ID", async () => {
    const { hh, id } = await setup([...RECHECK, ...WRITE]);
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false, output: { draft_id: "dr-1", message_id: "dm-1" } });
    expect(status(hh, id)).toBe("applied");
    expect(draftPosts()).toHaveLength(1);
    expect((getAction(hh.db, id)!.result_json as { messageIdHeader: string }).messageIdHeader).toBe(GMAIL_HEADER);
    const landed = hh.rows().filter((r) => r.action_id === id && r.kind === "write_landed");
    expect(landed.map((r) => (JSON.parse(r.preview_json) as { output: unknown }).output)).toEqual([{ writeId: "dr-1" }]);
    const sent = JSON.parse(draftPosts()[0]!.body!) as { message: { raw: string; threadId: string } };
    expect(sent.message.threadId).toBe("t-reply");
    const raw = Buffer.from(sent.message.raw, "base64url").toString("utf8");
    expect(raw).not.toMatch(/^message-id:/im);
    expect(raw).toBe(
      buildDraftMime({
        threadId: "t-reply",
        idempotencyKey: KEY,
        inReplyTo: "<r2@example.com>",
        references: ["<r1@example.com>", "<r2@example.com>"],
        to: ["ana@example.com"],
        cc: [],
        bcc: ["boss@example.com"],
        subject: "Re: Q4 budget",
        body: BODY,
      }),
    );
  });

  it("a replay of an applied action sends nothing", async () => {
    const { hh, id } = await setup([...RECHECK, ...WRITE]);
    const first = await applyAction(hh.ctx, id);
    const requests = replay!.seen.length;
    const second = await applyAction(hh.ctx, id);
    expect(second).toMatchObject({ ok: true, replayed: true });
    expect((second as { output: unknown }).output).toEqual((first as { output: unknown }).output);
    expect(replay!.seen).toHaveLength(requests);
    expect(draftPosts()).toHaveLength(1);
  });

  it("recovery after a crash before the ledger commit ends applied with no second POST", async () => {
    const { hh, id } = await setup([...RECHECK, ...WRITE, ...BY_ID]);
    hh.ctx.hooks = {
      beforeCommit: () => {
        throw new Error("crash before commit");
      },
    };
    await expect(applyAction(hh.ctx, id)).rejects.toThrow("crash before commit");
    expect(status(hh, id)).toBe("approved");
    hh.ctx.hooks = undefined;
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr-1" } });
    expect(status(hh, id)).toBe("applied");
    expect(draftPosts()).toHaveLength(1);
  });

  it("after a crashed attempt, an existing draft with the approved content is recovered with no POST", async () => {
    const { hh, id } = await setup(BY_CONTENT);
    expect(takeWriteClaim(hh.ctx, id)).toMatchObject({ ok: true }); // the earlier attempt, which died before recording
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr-1" } });
    expect(status(hh, id)).toBe("applied");
    expect(draftPosts()).toHaveLength(0);
  });

  it("a 500 that landed, not yet listed: the retry at 60 s finds it by content across list pages, with one POST in total", async () => {
    const { hh, id } = await setup([
      ...RECHECK,
      "gmail-drafts-create-500",
      ...NOTHING,
      "gmail-drafts-page-1",
      "gmail-drafts-page-2",
      "gmail-draft-get-gmail-header",
    ]);
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    expect(status(hh, id)).toBe("approved");
    now = BASE + HOLD;
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr-1" } });
    expect(status(hh, id)).toBe("applied");
    expect(draftPosts()).toHaveLength(1);
  });

  it("a 500 then lookup absent stays approved (retryable), and no row holds the fake token", async () => {
    const { hh, id } = await setup([...RECHECK, "gmail-drafts-create-500", ...NOTHING]);
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PROVIDER_ERROR" });
    const a = getAction(hh.db, id)!;
    expect(a.status).toBe("approved");
    expect(a.error).toBeNull();
    expect(draftPosts()).toHaveLength(1);
    expect(dump(hh)).not.toContain("FAKE-TOKEN");
  });

  it("the recorded draft, changed in Gmail, gives STALE_PLAN with no POST", async () => {
    const { hh, id } = await setup(["gmail-draft-get-differs"]);
    writeRecords(hh.ctx, id).record("dr-1");
    expect(await applyAction(hh.ctx, id)).toEqual({ ok: false, errorCode: "STALE_PLAN", message: DIFFERS });
    expect(status(hh, id)).toBe("failed");
    expect(draftPosts()).toHaveLength(0);
  });

  it("a message with an older internalDate added after approval gives STALE_PLAN with no POST", async () => {
    const { hh, id } = await setup(["gmail-profile", "gmail-reply-thread-backdated-minimal", "gmail-reply-thread-backdated-full"]);
    expect(await applyAction(hh.ctx, id)).toEqual({ ok: false, errorCode: "STALE_PLAN", message: THREAD_CHANGED });
    expect(status(hh, id)).toBe("failed");
    expect(draftPosts()).toHaveLength(0);
  });

  it("our draft as the thread's newest message does not make the re-check stale: it is recovered with no POST", async () => {
    // An earlier attempt claimed and died one hold ago, so this apply looks for its draft by content.
    const { hh, id } = await setup([
      ...NOTHING, // not visible yet at the recovery lookup
      "gmail-profile",
      "gmail-reply-thread-with-draft-minimal",
      "gmail-reply-thread-with-draft-full",
      ...BY_CONTENT, // the lookup under the claim sees it
    ]);
    expect(takeWriteClaim(hh.ctx, id)).toMatchObject({ ok: true });
    now = BASE + HOLD;
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: true, output: { draft_id: "dr-1" } });
    expect(status(hh, id)).toBe("applied");
    expect(draftPosts()).toHaveLength(0);
  });

  it("no-send proof: the whole propose, approve and apply flow stays on the allowlist and never names /send", async () => {
    const { hh, id } = await setup([...RECHECK, ...WRITE]);
    await applyAction(hh.ctx, id);
    expect(replay!.seen.length).toBeGreaterThan(6);
    for (const r of replay!.seen) {
      expect(r.url).not.toContain("/send");
      expect(() => assertAllowedGmailRequest(r.method, new URL(r.url))).not.toThrow();
    }
    expect(replay!.seen.filter((r) => r.method !== "GET")).toHaveLength(1);
  });
});

describe("the recorded draft is compared on every recipient (M4b fix wave D)", () => {
  it.each([
    ["an entry that does not parse", "gmail-draft-get-unparsed-recipient"],
    ["a second To header", "gmail-draft-get-second-to"],
  ])("%s: STALE_PLAN with the differs phrase and no POST", async (_name, recording) => {
    const { hh, id } = await setup([recording]);
    writeRecords(hh.ctx, id).record("dr-1");
    expect(await applyAction(hh.ctx, id)).toEqual({ ok: false, errorCode: "STALE_PLAN", message: DIFFERS });
    expect(status(hh, id)).toBe("failed");
    expect(draftPosts()).toHaveLength(0);
  });
});
