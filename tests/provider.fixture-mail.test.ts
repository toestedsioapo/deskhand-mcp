import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureMailProvider } from "../src/providers/fixture/index.js";
import type { FixtureMessage, FixtureWorld } from "../src/providers/fixture/world.js";
import type { NewDraft } from "../src/providers/types.js";

const dir = mkdtempSync(join(tmpdir(), "deskhand-mail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const msg = (id: string, date: string, over: Partial<FixtureMessage> = {}): FixtureMessage => ({
  id,
  date,
  from: { address: "ana@example.com", name: "Ana Lopez" },
  to: [{ address: "me@example.com" }],
  subject: "Q4 budget",
  body_text: "Please review the numbers",
  ...over,
});

function world(threads: { id: string; messages: FixtureMessage[] }[], writeLog?: string): FixtureWorld {
  return {
    fixture_version: 2,
    now: "2026-11-10T09:00:00.000Z",
    calendars: {},
    mail: { owner: "me@example.com", threads },
    settings: { latency_ms: 0, ...(writeLog ? { write_log: writeLog } : {}) },
  };
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const draft = (over: Partial<NewDraft> = {}): NewDraft => ({
  threadId: "t1",
  idempotencyKey: "k1",
  inReplyTo: null,
  references: [],
  to: ["ana@example.com"],
  cc: [],
  bcc: [],
  subject: "Re: Q4 budget",
  body: "SECRET BODY TEXT",
  ...over,
});

const base = world([
  { id: "t1", messages: [msg("m1", "2026-11-08T10:00:00.000Z"), msg("m2", "2026-11-09T10:00:00.000Z", { unread: true })] },
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

describe("fixture mailbox search", () => {
  const mail = createFixtureMailProvider(base);

  it("profile returns the owner", async () => {
    expect(await mail.profile()).toEqual({ email: "me@example.com" });
  });

  it("orders newest lastDate first and reports summary fields", async () => {
    const { threads, truncated } = await mail.searchThreads("", 10);
    expect(threads.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(truncated).toBe(false);
    expect(threads[1]).toMatchObject({
      subject: "Q4 budget",
      lastDate: "2026-11-09T10:00:00.000Z",
      messageCount: 2,
      unread: true,
    });
    expect(threads[0]!.snippet).toHaveLength(100);
  });

  it("applies limit and truncated", async () => {
    const r = await mail.searchThreads("", 1);
    expect(r.threads.map((t) => t.id)).toEqual(["t2"]);
    expect(r.truncated).toBe(true);
  });

  it("requires every term; matches subject, body and addresses case-insensitively", async () => {
    expect((await mail.searchThreads("budget NUMBERS", 10)).threads.map((t) => t.id)).toEqual(["t1"]);
    expect((await mail.searchThreads("budget sushi", 10)).threads).toEqual([]);
    expect((await mail.searchThreads("CORP.TEST", 10)).threads.map((t) => t.id)).toEqual(["t2"]);
  });

  it("from: matches a substring of address or name", async () => {
    expect((await mail.searchThreads("from:lopez", 10)).threads.map((t) => t.id)).toEqual(["t1"]);
    expect((await mail.searchThreads("from:ben@", 10)).threads.map((t) => t.id)).toEqual(["t2"]);
  });

  it("is:unread matches threads with an unread message", async () => {
    expect((await mail.searchThreads("is:unread", 10)).threads.map((t) => t.id)).toEqual(["t1"]);
  });

  it("refuses an unsupported operator", async () => {
    await expect(mail.searchThreads("label:inbox", 10)).rejects.toThrow(
      /query operator not supported by the fixture provider/,
    );
    await expect(mail.searchThreads("is:read", 10)).rejects.toThrow(/not supported/);
  });
});

describe("fixture mailbox threadMessageIds", () => {
  it("leaves out drafts, has no cap, and returns null for an unknown thread", async () => {
    const messages = [
      ...Array.from({ length: 150 }, (_, i) => msg(`m${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString())),
      msg("md", "2026-11-09T11:00:00.000Z", { draft: true }),
    ];
    const mail = createFixtureMailProvider(world([{ id: "t1", messages }]));
    const ids = await mail.threadMessageIds("t1");
    expect(ids).toHaveLength(150);
    expect(ids).not.toContain("md");
    expect(new Set(ids)).toEqual(new Set(messages.slice(0, 150).map((m) => m.id)));
    expect(await mail.threadMessageIds("nope")).toBeNull();
  });
});

describe("fixture mailbox getThread", () => {
  it("returns oldest first, drops drafts, null for unknown", async () => {
    const w = world([
      {
        id: "t1",
        messages: [
          msg("m2", "2026-11-09T10:00:00.000Z"),
          msg("m1", "2026-11-08T10:00:00.000Z", { message_id: "<a@x>" }),
          msg("md", "2026-11-09T11:00:00.000Z", { draft: true }),
        ],
      },
    ]);
    const mail = createFixtureMailProvider(w);
    const t = await mail.getThread("t1", 100);
    expect(t!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(t!.truncated).toBe(false);
    expect(t!.messages[0]).toMatchObject({ messageIdHeader: "<a@x>", threadId: "t1", unread: false });
    expect(t!.messages[1]!.messageIdHeader).toBeNull();
    expect(await mail.getThread("nope", 100)).toBeNull();
  });

  it("sentByOwner is true only for an explicit sent: true, never from the From address", async () => {
    const mail = createFixtureMailProvider(
      world([
        {
          id: "t1",
          messages: [
            msg("m1", "2026-11-08T10:00:00.000Z"),
            msg("m2", "2026-11-09T10:00:00.000Z", { from: { address: "me@example.com" } }),
            msg("m3", "2026-11-09T11:00:00.000Z", { from: { address: "me@example.com" }, sent: true }),
          ],
        },
      ]),
    );
    const t = await mail.getThread("t1", 100);
    expect(t!.messages.map((m) => m.sentByOwner)).toEqual([false, false, true]);
  });

  it("keeps the newest maxMessages and flags truncation", async () => {
    const messages = Array.from({ length: 150 }, (_, i) =>
      msg(`m${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    const t = await createFixtureMailProvider(world([{ id: "t1", messages }])).getThread("t1", 100);
    expect(t!.messages).toHaveLength(100);
    expect(t!.messages[0]!.id).toBe("m50");
    expect(t!.messages[99]!.id).toBe("m149");
    expect(t!.truncated).toBe(true);
  });

  it("cuts a body at 20000 characters", async () => {
    const w = world([
      { id: "t1", messages: [msg("m1", "2026-11-08T10:00:00.000Z", { body_text: "y".repeat(25000) })] },
    ]);
    const m = (await createFixtureMailProvider(w).getThread("t1", 10))!.messages[0]!;
    expect(m.bodyText).toHaveLength(20000);
    expect(m.bodyTruncated).toBe(true);
    expect(m.snippet).toHaveLength(100);
  });
});

describe("fixture mailbox createDraft", () => {
  const one = [{ id: "t1", messages: [msg("m1", "2026-11-08T10:00:00.000Z")] }];

  it("like Gmail, never de-duplicates: every call is a new draft with its own Message-ID, reported by id", async () => {
    const logPath = join(dir, "w1.log");
    let writes = 0;
    const reported: string[] = [];
    const mail = createFixtureMailProvider(world(one, logPath), { afterWrite: () => void (writes += 1) });
    expect(await mail.threadDrafts("t1")).toEqual([]);
    const a = await mail.createDraft(draft(), (id) => void reported.push(id));
    const b = await mail.createDraft(draft(), (id) => void reported.push(id));
    expect(a).toMatchObject({
      draftId: "dr_1",
      messageId: "msg_dr_1",
      messageIdHeader: "<fixture.dr_1@mail.fixture.invalid>",
      bodySha256: sha("SECRET BODY TEXT"),
    });
    expect(b).toMatchObject({ draftId: "dr_2", messageIdHeader: "<fixture.dr_2@mail.fixture.invalid>" });
    expect(Date.parse(a.date)).toBeLessThan(Date.parse(b.date));
    expect(reported).toEqual(["dr_1", "dr_2"]);
    expect(writes).toBe(2);
    expect(await mail.getDraft("dr_1")).toEqual(a);
    expect(await mail.getDraft("dr_9")).toBeNull();
    expect(await mail.threadDrafts("t1")).toEqual([a, b]);
    expect(await mail.threadDrafts("t2")).toEqual([]);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { idempotency_key: string });
    expect(lines.map((l) => l.idempotency_key)).toEqual(["k1", "k1"]);
  });

  it("logs no body text", async () => {
    const logPath = join(dir, "w2.log");
    const mail = createFixtureMailProvider(world(one, logPath));
    await mail.createDraft(draft(), () => undefined);
    const text = readFileSync(logPath, "utf8");
    expect(text).not.toContain("SECRET BODY TEXT");
    expect(text).toContain("mail.createDraft");
    expect(text).toContain("[omitted 16 chars sha256:");
  });

  it("does not show drafts in getThread and has no send member", async () => {
    const mail = createFixtureMailProvider(world(one));
    await mail.createDraft(draft(), () => undefined);
    expect((await mail.getThread("t1", 10))!.messages).toHaveLength(1);
    expect(Object.keys(mail).filter((k) => /send/i.test(k))).toEqual([]);
  });
});

describe("a world without mail", () => {
  it("keeps refusing every call", async () => {
    const w: FixtureWorld = {
      fixture_version: 1,
      now: "2026-11-10T09:00:00.000Z",
      calendars: {},
      settings: { latency_ms: 0 },
    };
    const mail = createFixtureMailProvider(w);
    await expect(mail.profile()).rejects.toThrow(/no mailbox in this world/);
    await expect(mail.searchThreads("", 1)).rejects.toThrow(/no mailbox in this world/);
  });
});
