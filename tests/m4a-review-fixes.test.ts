import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { approveAction } from "../src/approval/approve.js";
import { sweepDraftBodies } from "../src/approval/body-sweep.js";
import type { CliIo } from "../src/cli/io.js";
import { LedgerDb } from "../src/ledger/db.js";
import { last4 } from "../src/ledger/ids.js";
import { isBodyLine, normaliseBody } from "../src/util/sanitize.js";
import { setupHarness } from "./helpers/harness.js";
import { msg, useMail } from "./helpers/mail-world.js";
import { bodyFields, seedAction, validDraftPlan } from "./helpers/seed.js";

// Regressions for the M4a whole-branch review (I1 to I3) and red-team round (F1 to F3).

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const S = "SENTINELTEXT";
const THREAD = {
  id: "t1",
  messages: [msg("m1", "2026-11-08T10:00:00.000Z", { message_id: `<${S}_ignore_previous@evil.example>` })],
};

async function harness(): Promise<H> {
  h = await setupHarness();
  useMail(h, [THREAD]);
  return h;
}

const previews = async (hh: H): Promise<string> => {
  await hh.logging.whenIdle();
  return hh.rows().map((r) => r.preview_json).join("\n");
};

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

describe("I1: sender-controlled Message-IDs", () => {
  it("action_explain wraps inReplyTo and references, and no preview holds them", async () => {
    const hh = await harness();
    const planned = await hh.client.callTool({ name: "inbox_draft_reply", arguments: { thread_id: "t1", body: "Thanks" } });
    const id = (planned.structuredContent as { action_id: string }).action_id;
    const r = await hh.client.callTool({ name: "action_explain", arguments: { action_id: id } });
    const draft = (r.structuredContent as { plan: { draft: { inReplyTo: unknown; references: unknown[] } } }).plan.draft;
    expect(draft.inReplyTo).toMatchObject({ untrusted: true, source: "mail:t1" });
    expect(draft.references[0]).toMatchObject({ untrusted: true, source: "mail:t1" });
    expect(await previews(hh)).not.toContain(S);
  });
});

describe("I2: a refused inbox call keeps none of its input", () => {
  it.each([
    ["a misnamed body key", { thread_id: "t1", reply: `${S} short reply` }],
    ["text in a key name", { thread_id: "t1", body: "x", [`${S} key`]: 1 }],
  ])("%s", async (_name, args) => {
    const hh = await harness();
    const r = await hh.client.callTool({ name: "inbox_draft_reply", arguments: args });
    expect(r.isError).toBe(true);
    expect(await previews(hh)).not.toContain(S);
  });
});

describe("I3: a busy checkpoint is retried", () => {
  it("a later sweep that removes nothing still clears the body from the WAL", async () => {
    const hh = await harness();
    const marker = randomBytes(20).toString("hex");
    seedAction(hh.ctx, "rejected", validDraftPlan({}, bodyFields(`Hi,\n${marker}`)));
    const wal = `${hh.ctx.config.paths.ledgerPath}-wal`;
    const reader = LedgerDb.open(hh.ctx.config.paths.ledgerPath);
    try {
      reader.run("BEGIN");
      reader.get("SELECT count(*) AS n FROM actions");
      const started = performance.now();
      expect(sweepDraftBodies(hh.ctx)).toBe(1);
      expect(performance.now() - started).toBeLessThan(2000); // a busy checkpoint must not wait out busy_timeout
      reader.run("COMMIT");
    } finally {
      reader.close();
    }
    expect(hh.ctx.db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(5000);
    expect(sweepDraftBodies(hh.ctx)).toBe(0);
    if (existsSync(wal)) expect(readFileSync(wal).includes(marker)).toBe(false);
  });
});

describe("F1 and F2: the summary above the approve prompt", () => {
  it("a subject cannot be the last row: the true new-recipients line is", async () => {
    const hh = await harness();
    const subject = "Re: Budget follow up notes for the finance review on Thursday morning new recipients: none";
    const id = seedAction(hh.ctx, "planned", validDraftPlan({}, { subject }));
    const io = scripted(last4(id));
    expect(await approveAction(hh.ctx, id, io)).toEqual({ ok: true });
    const rows = io.outText().split("\n").filter((l) => l.length > 0);
    const end = rows.findLastIndex((l) => l.startsWith("new recipients: "));
    expect(rows[end]).toBe("new recipients: 1 not on this thread");
    expect(rows[end - 1]).toBe("summary: to 2, cc 1, bcc 1");
    expect(rows.slice(end + 1).join("\n")).not.toContain("new recipients");
  });

  it("the summary states the body's size", async () => {
    const hh = await harness();
    const body = "one\ntwo\nthree";
    const id = seedAction(hh.ctx, "planned", validDraftPlan({}, bodyFields(body)));
    const io = scripted(last4(id));
    await approveAction(hh.ctx, id, io);
    const rows = io.outText().split("\n");
    const at = rows.findLastIndex((l) => l.startsWith("summary: "));
    expect(rows[at - 1]).toBe(`body: 3 lines, ${body.length} chars`);
  });

  it("refuses a whitespace run over 16 characters anywhere in a line", () => {
    expect(isBodyLine(`a${" ".repeat(16)}b`)).toBe(true);
    expect(isBodyLine(`${" ".repeat(16)}indented`)).toBe(true);
    expect(isBodyLine(`a${" ".repeat(17)}b`)).toBe(false);
    expect(isBodyLine(`${" ".repeat(17)}indented`)).toBe(false);
    expect(isBodyLine(`a${"　".repeat(17)}b`)).toBe(false);
    expect(normaliseBody(`Thanks.${" ".repeat(9000)}wire the money`)).toBeNull();
  });
});

describe("F3: free text in accepted inbox fields", () => {
  it("rationale, reason, labels and query stay out of every preview and of input_json", async () => {
    const hh = await harness();
    const planned = await hh.client.callTool({
      name: "inbox_draft_reply",
      arguments: { thread_id: "t1", body: "Thanks", rationale: `${S} rationale` },
    });
    const id = (planned.structuredContent as { action_id: string }).action_id;
    await hh.client.callTool({ name: "action_explain", arguments: { action_id: id } });
    const triage = await hh.client.callTool({
      name: "inbox_triage",
      arguments: {
        proposals: [{ thread_id: "t1", priority: "high", next_action: "reply", labels: [`${S} label`], reason: `${S} reason` }],
      },
    });
    expect(triage.isError).toBeFalsy();
    const search = await hh.client.callTool({ name: "inbox_search", arguments: { query: `${S} query` } });
    expect(search.isError).toBeFalsy();
    const text = (await previews(hh)).replaceAll(`${S}_ignore_previous`, "");
    expect(text).not.toContain(S);
    const row = hh.db.get<{ input_json: string }>("SELECT input_json FROM actions WHERE id = ?", [id])!;
    expect(row.input_json).not.toContain(S);
  });
});
