import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { inboxReadThreadInputSchema, inboxReadThreadOutputSchema } from "../src/tools/inbox-read-thread.js";
import { setupHarness } from "./helpers/harness.js";
import { msg, useMail } from "./helpers/mail-world.js";

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H;
beforeEach(async () => {
  h = await setupHarness();
});
afterEach(async () => {
  await h.close();
});

const call = (args: Record<string, unknown>) => h.client.callTool({ name: "inbox_read_thread", arguments: args });
const rows = () => h.rows().filter((r) => r.kind === "tool_call" && r.tool === "inbox_read_thread");
const w = (source: string, content: string) => ({ untrusted: true, source, content });

describe("inbox_read_thread schemas", () => {
  it("input schema is stable", () => expect(z.toJSONSchema(inboxReadThreadInputSchema)).toMatchSnapshot());
  it("output schema is stable", () => expect(z.toJSONSchema(inboxReadThreadOutputSchema)).toMatchSnapshot());
});

describe("inbox_read_thread", () => {
  it("is listed, read-only, and says the text is untrusted", async () => {
    const t = (await h.client.listTools()).tools.find((x) => x.name === "inbox_read_thread");
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(t?.description).toContain("untrusted");
  });

  it("returns every output field, wrapped with source mail:<thread_id>", async () => {
    useMail(h, [
      {
        id: "t1",
        messages: [
          msg("m1", "2026-11-08T10:00:00.000Z", {
            reply_to: [{ address: "ana.reply@example.com", name: "Ana R" }],
            cc: [{ address: "cc@example.com" }],
            unread: true,
          }),
        ],
      },
    ]);
    const r = await call({ thread_id: "t1" });
    expect(r.isError).toBeFalsy();
    const s = "mail:t1";
    expect(r.structuredContent).toEqual({
      thread_id: "t1",
      truncated: false,
      messages: [
        {
          id: "m1",
          date: "2026-11-08T10:00:00.000Z",
          from: { address: w(s, "ana@example.com"), name: w(s, "Ana Lopez") },
          reply_to: [{ address: w(s, "ana.reply@example.com"), name: w(s, "Ana R") }],
          to: [{ address: w(s, "me@example.com"), name: w(s, "") }],
          cc: [{ address: w(s, "cc@example.com"), name: w(s, "") }],
          subject: w(s, "Q4 budget"),
          body_text: w(s, "Please review the numbers"),
          body_truncated: false,
          unread: true,
        },
      ],
    });
  });

  it("an unknown id is NOT_FOUND, logged as an error row", async () => {
    useMail(h, []);
    const r = await call({ thread_id: "nope" });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toBe("NOT_FOUND: No thread with id nope.");
    await h.logging.whenIdle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ outcome: "error", error_code: "NOT_FOUND" });
  });

  it("rejects a malformed thread id and logs each row", async () => {
    useMail(h, []);
    const ids = ["", "a b", "../x", "a".repeat(65)];
    for (const id of ids) expect((await call({ thread_id: id })).isError).toBe(true);
    await h.logging.whenIdle();
    expect(rows()).toHaveLength(ids.length);
    expect(rows().every((r) => r.error_code === "INVALID_INPUT")).toBe(true);
  });

  it("Review Focus 5: 150 messages and one 50000-char body", async () => {
    const SECRET = "BODYSECRET";
    const messages = Array.from({ length: 150 }, (_, i) =>
      msg(`m${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), {
        body_text: i === 149 ? `${SECRET}${"y".repeat(50_000)}` : `${SECRET} message ${i}`,
      }),
    );
    useMail(h, [{ id: "big", messages }]);
    const r = await call({ thread_id: "big" });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as {
      truncated: boolean;
      messages: { id: string; body_text: { content: string }; body_truncated: boolean }[];
    };
    expect(out.truncated).toBe(true);
    expect(out.messages).toHaveLength(100);
    expect(out.messages[0]!.id).toBe("m50");
    const last = out.messages[99]!;
    expect(last.id).toBe("m149");
    expect(last.body_text.content).toHaveLength(20_000);
    expect(last.body_truncated).toBe(true);
    expect(out.messages.slice(0, 99).every((m) => !m.body_truncated)).toBe(true);
    await h.logging.whenIdle();
    const row = rows()[0]!;
    expect(Buffer.byteLength(row.preview_json, "utf8")).toBeLessThanOrEqual(4096);
    expect(row.preview_json).not.toContain(SECRET);
    expect(row.preview_json).not.toContain("yyyy");
  });
});
