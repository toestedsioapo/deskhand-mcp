import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { inboxSearchInputSchema, inboxSearchOutputSchema } from "../src/tools/inbox-search.js";
import { setupHarness } from "./helpers/harness.js";
import { msg, useMail } from "./helpers/mail-world.js";

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H;
beforeEach(async () => {
  h = await setupHarness();
  useMail(h, [
    {
      id: "t1",
      messages: [
        msg("m1", "2026-11-08T10:00:00.000Z"),
        msg("m2", "2026-11-09T10:00:00.000Z", { unread: true, body_text: "Second message body" }),
      ],
    },
    {
      id: "t2",
      messages: [
        msg("m3", "2026-11-10T08:00:00.000Z", {
          from: { address: "ben@corp.test", name: "Ben" },
          subject: "Lunch plans",
          body_text: "Sushi? " + "x".repeat(200),
        }),
      ],
    },
  ]);
});
afterEach(async () => {
  await h.close();
});

const call = (args: Record<string, unknown>) => h.client.callTool({ name: "inbox_search", arguments: args });
const rows = () => h.rows().filter((r) => r.kind === "tool_call" && r.tool === "inbox_search");

describe("inbox_search schemas", () => {
  it("input schema is stable", () => expect(z.toJSONSchema(inboxSearchInputSchema)).toMatchSnapshot());
  it("output schema is stable", () => expect(z.toJSONSchema(inboxSearchOutputSchema)).toMatchSnapshot());
});

describe("inbox_search", () => {
  it("is listed, read-only, and says the text is untrusted", async () => {
    const t = (await h.client.listTools()).tools.find((x) => x.name === "inbox_search");
    expect(t?.annotations?.readOnlyHint).toBe(true);
    expect(t?.description).toContain("untrusted");
  });

  it("returns every output field, wrapped", async () => {
    const r = await call({ query: "budget" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({
      threads: [
        {
          id: "t1",
          subject: { untrusted: true, source: "mail:search", content: "Q4 budget" },
          from: {
            address: { untrusted: true, source: "mail:search", content: "ana@example.com" },
            name: { untrusted: true, source: "mail:search", content: "Ana Lopez" },
          },
          last_date: "2026-11-09T10:00:00.000Z",
          snippet: { untrusted: true, source: "mail:search", content: "Second message body" },
          message_count: 2,
          unread: true,
        },
      ],
      truncated: false,
    });
  });

  it("limit truncates, newest first", async () => {
    const r = await call({ query: "e", limit: 1 });
    const out = r.structuredContent as { threads: { id: string }[]; truncated: boolean };
    expect(out.threads.map((t) => t.id)).toEqual(["t2"]);
    expect(out.truncated).toBe(true);
  });

  it("rejects bad input and still logs a row for each", async () => {
    const bad: Record<string, unknown>[] = [
      { query: "" },
      { query: "a".repeat(501) },
      { query: "a‮b" },
      { query: "a\nb" },
      { query: "x", limit: 26 },
      { query: "x", limit: 0 },
      { query: "x", extra: 1 },
    ];
    for (const args of bad) expect((await call(args)).isError).toBe(true);
    await h.logging.whenIdle();
    expect(rows()).toHaveLength(bad.length);
    expect(rows().every((r) => r.error_code === "INVALID_INPUT")).toBe(true);
  });

  it("maps an unsupported operator to PROVIDER_ERROR", async () => {
    expect((await call({ query: "label:x" })).isError).toBe(true);
    await h.logging.whenIdle();
    expect(rows()[0]!.error_code).toBe("PROVIDER_ERROR");
  });

  it("logs a preview with no subject or snippet in clear and creates no action", async () => {
    await call({ query: "Q4" });
    await h.logging.whenIdle();
    const row = rows()[0]!;
    expect(row.outcome).toBe("ok");
    expect(row.preview_json).not.toContain("Q4 budget");
    expect(row.preview_json).not.toContain("Second message body");
    expect(h.db.all("SELECT * FROM actions")).toHaveLength(0);
  });

  it("is PROVIDER_NOT_CONFIGURED without a provider", async () => {
    h.ctx.mail = null;
    h.ctx.provider = null;
    expect((await call({ query: "x" })).isError).toBe(true);
    await h.logging.whenIdle();
    expect(rows()[0]!.error_code).toBe("PROVIDER_NOT_CONFIGURED");
  });
});
