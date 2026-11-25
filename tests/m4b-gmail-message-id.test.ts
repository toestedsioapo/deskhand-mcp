import { afterEach, describe, expect, it } from "vitest";
import { applyAction } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import type { CliIo } from "../src/cli/io.js";
import { getAction } from "../src/ledger/actions.js";
import { last4 } from "../src/ledger/ids.js";
import { createFixtureMailProvider } from "../src/providers/fixture/index.js";
import { setupHarness } from "./helpers/harness.js";
import { mailWorld, msg, type Thread } from "./helpers/mail-world.js";

// M4b live check, step 6 (2026-11-25): Gmail replaced the client-supplied Message-ID on a draft with its own, and the
// apply ended STALE_PLAN. The fixture now rewrites it the same way, so the suite would have caught it.

const THREAD: Thread = {
  id: "th_budget",
  messages: [msg("m1", "2026-11-09T10:00:00.000Z", { message_id: "<m1@example.com>" })],
};
const OURS = /deskhand\.invalid/;

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const approvalIo = (id: string): CliIo => ({
  out: () => undefined,
  err: () => undefined,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  readLine: async () => last4(id),
});

describe("the provider assigns the draft's Message-ID (M4b live check)", () => {
  it("the fixture's createDraft stores a Message-ID of its own, never one derived from the action", async () => {
    const mail = createFixtureMailProvider(mailWorld([THREAD]));
    const created = await mail.createDraft(
      {
        threadId: "th_budget",
        idempotencyKey: "a".repeat(64),
        inReplyTo: "<m1@example.com>",
        references: ["<m1@example.com>"],
        to: ["ana@example.com"],
        cc: [],
        bcc: [],
        subject: "Re: Q4 budget",
        body: "Thanks",
      },
      () => undefined,
    );
    expect(created.messageIdHeader).toMatch(/^<fixture\.dr_1@mail\.fixture\.invalid>$/);
  });

  it("an apply whose draft comes back with the provider's Message-ID ends applied and stores that Message-ID", async () => {
    const hh = await setupHarness({ env: { DESKHAND_ALLOW_WRITES: "1" } });
    h = hh;
    hh.ctx.mail = createFixtureMailProvider(mailWorld([THREAD]));
    const r = await hh.client.callTool({ name: "inbox_draft_reply", arguments: { thread_id: "th_budget", body: "Thanks Ana" } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const id = (r.structuredContent as { action_id: string }).action_id;
    expect(await approveAction(hh.ctx, id, approvalIo(id))).toEqual({ ok: true });

    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: true, replayed: false });
    const a = getAction(hh.db, id)!;
    expect(a.status).toBe("applied");
    const stored = a.result_json as { messageIdHeader: string };
    expect(stored.messageIdHeader).toMatch(/@mail\.fixture\.invalid>$/);
    expect(JSON.stringify(a.result_json)).not.toMatch(OURS);
  });
});
