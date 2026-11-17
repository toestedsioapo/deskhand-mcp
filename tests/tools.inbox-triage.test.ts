import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { inboxTriageInputSchema, inboxTriageOutputSchema } from "../src/tools/inbox-triage.js";
import { setupHarness } from "./helpers/harness.js";
import { msg, useMail } from "./helpers/mail-world.js";

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H;
beforeEach(async () => {
  h = await setupHarness({ env: { DESKHAND_ALLOW_WRITES: "1" } });
  useMail(h, [
    { id: "t1", messages: [msg("m1", "2026-11-08T10:00:00.000Z")] },
    { id: "t2", messages: [msg("m2", "2026-11-08T11:00:00.000Z", { subject: "Lunch plans" })] },
  ]);
});
afterEach(async () => {
  await h.close();
});

const call = (args: Record<string, unknown>) => h.client.callTool({ name: "inbox_triage", arguments: args });
const rows = () => h.rows().filter((r) => r.kind === "tool_call" && r.tool === "inbox_triage");
const w = (source: string, content: string) => ({ untrusted: true, source, content });
const actionCount = () => h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM actions")!.n;

describe("inbox_triage schemas", () => {
  it("input schema is stable", () => expect(z.toJSONSchema(inboxTriageInputSchema)).toMatchSnapshot());
  it("output schema is stable", () => expect(z.toJSONSchema(inboxTriageOutputSchema)).toMatchSnapshot());
});

describe("inbox_triage", () => {
  it("is listed, read-only", async () => {
    const t = (await h.client.listTools()).tools.find((x) => x.name === "inbox_triage");
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(t?.description).toContain("never applies");
  });

  it("returns the proposals with untrusted subjects and applied: false", async () => {
    const r = await call({
      proposals: [
        { thread_id: "t1", priority: "high", next_action: "reply", labels: ["budget"], reason: "Needs an answer" },
        { thread_id: "t2", priority: "low", next_action: "archive" },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      proposals: [
        { thread_id: "t1", subject: w("mail:t1", "Q4 budget"), priority: "high", next_action: "reply", labels: ["budget"], reason: "Needs an answer" },
        { thread_id: "t2", subject: w("mail:t2", "Lunch plans"), priority: "low", next_action: "archive", labels: [], reason: null },
      ],
      applied: false,
      note: "Proposals only. Deskhand never applies labels or moves mail.",
    });
  });

  it("writes one tool_call row, no actions row, and leaves the mailbox unchanged", async () => {
    const before = JSON.stringify(await h.ctx.mail!.getThread("t1", 100));
    await call({ proposals: [{ thread_id: "t1", priority: "normal", next_action: "none" }] });
    expect(rows()).toHaveLength(1);
    expect(actionCount()).toBe(0);
    expect(JSON.stringify(await h.ctx.mail!.getThread("t1", 100))).toBe(before);
    expect(JSON.stringify(rows()[0])).not.toContain("Q4 budget");
  });

  it("an unknown thread is NOT_FOUND and nothing is returned for the others", async () => {
    const r = await call({
      proposals: [
        { thread_id: "t1", priority: "high", next_action: "reply" },
        { thread_id: "nope", priority: "low", next_action: "none" },
      ],
    });
    expect(r.isError).toBe(true);
    expect(rows()[0]!.error_code).toBe("NOT_FOUND");
    expect(r.structuredContent).toBeUndefined();
    expect(rows()).toHaveLength(1);
  });

  it("refuses a duplicate thread id, bad labels, too many labels, a long reason and an empty list", async () => {
    const p = { thread_id: "t1", priority: "high", next_action: "reply" };
    const bad: Record<string, unknown>[] = [
      { proposals: [p, p] },
      { proposals: [{ ...p, labels: ["a\nb"] }] },
      { proposals: [{ ...p, labels: ["x".repeat(41)] }] },
      { proposals: [{ ...p, labels: ["1", "2", "3", "4", "5", "6"] }] },
      { proposals: [{ ...p, reason: "r".repeat(301) }] },
      { proposals: [] },
    ];
    for (const args of bad) {
      const r = await call(args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(rows()).toHaveLength(bad.length);
    expect(rows().every((r) => r.error_code === "INVALID_INPUT")).toBe(true);
    expect(actionCount()).toBe(0);
  });

  it("action_apply given a triage call's id is UNKNOWN_ACTION", async () => {
    await call({ proposals: [{ thread_id: "t1", priority: "high", next_action: "reply" }] });
    // A triage call has no action id (its row's action_id is null), so there is nothing to apply: any id is unknown.
    expect(rows()[0]!.action_id).toBeNull();
    const r = await h.client.callTool({ name: "action_apply", arguments: { action_id: h.ctx.ids.newActionId() } });
    expect(r.isError).toBe(true);
    const apply = h.rows().filter((x) => x.kind === "tool_call" && x.tool === "action_apply");
    expect(apply.map((x) => x.error_code)).toEqual(["UNKNOWN_ACTION"]);
    expect(actionCount()).toBe(0);
  });
});
