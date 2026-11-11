import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { approveAction } from "../src/approval/approve.js";
import { runCli } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/io.js";
import { getAction } from "../src/ledger/actions.js";
import { last4 } from "../src/ledger/ids.js";
import { LedgerDb } from "../src/ledger/db.js";
import { calendarProposeEventInputSchema, calendarProposeEventOutputSchema } from "../src/tools/calendar-propose-event.js";
import { NOW, setupHarness } from "./helpers/harness.js";

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
async function harness(env: NodeJS.ProcessEnv = {}): Promise<H> {
  h = await setupHarness({ env });
  return h;
}
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Out {
  action_id: string;
  plan_hash: string;
  expires_at: string;
  diff: string[];
  next_step: string;
}

// The harness clock is fixed at 2026-11-10T09:30:00.123Z; the fixture standup is 09:30-09:45Z that day.
const SLOT = { start: "2026-11-12T10:00:00.000Z", end: "2026-11-12T10:30:00.000Z" };
const base = { title: "Sync", ...SLOT };
const call = (hh: H, args: Record<string, unknown>) =>
  hh.client.callTool({ name: "calendar_propose_event", arguments: args });
const errorCode = (r: Awaited<ReturnType<typeof call>>) =>
  (r._meta as { deskhand: { error_code: string } }).deskhand.error_code;
const propose = async (hh: H, args: Record<string, unknown>): Promise<Out> => {
  const r = await call(hh, args);
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  await hh.logging.whenIdle();
  return r.structuredContent as unknown as Out;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storedPlan = (hh: H, id: string) => getAction(hh.db, id)!.plan_json as any;
const actionCount = (hh: H) => hh.db.all("SELECT id FROM actions").length;
const THREE = ["ana@example.com", "ben@example.com", "cy@example.com"];

type ScriptedIo = CliIo & { outText: () => string };
function scripted(lines: string[]): ScriptedIo {
  let out = "";
  const q = [...lines];
  return {
    out: (s) => (out += s),
    err: () => undefined,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    readLine: async () => {
      const next = q.shift();
      if (next === undefined) throw new Error("no input queued");
      return next;
    },
    outText: () => out,
  };
}
async function pendingText(hh: H): Promise<string> {
  let out = "";
  const io: CliIo = {
    out: (s) => (out += s),
    err: () => undefined,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    readLine: () => Promise.reject(new Error("no input expected")),
  };
  const code = await runCli(["pending"], io, () => ({ ...hh.ctx, db: LedgerDb.open(hh.ctx.config.paths.ledgerPath) }));
  expect(code).toBe(0);
  return out;
}

describe("calendar_propose_event schemas", () => {
  it("input schema is stable", () => expect(z.toJSONSchema(calendarProposeEventInputSchema)).toMatchSnapshot());
  it("output schema is stable", () => expect(z.toJSONSchema(calendarProposeEventOutputSchema)).toMatchSnapshot());
});

describe("calendar_propose_event", () => {
  it("is listed as a plan tool: not read-only, not destructive, not idempotent", async () => {
    const t = (await (await harness()).client.listTools()).tools.find((x) => x.name === "calendar_propose_event");
    expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("a free slot returns an id, a 64-hex hash, expiry = clock + 24 h and a diff in Config.timeZone", async () => {
    const hh = await harness();
    const out = await propose(hh, base);
    expect(out.action_id).toMatch(/^act_/);
    expect(out.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.expires_at).toBe(new Date(Date.parse(NOW) + 24 * 3_600_000).toISOString());
    expect(out.next_step).toBe(`A human must run: deskhand approve ${out.action_id}`);
    expect(out.diff[0]).toBe("create event: Sync");
    expect(out.diff[1]).toBe("when: Thu 12 Nov 2026, 10:00 to 10:30 UTC (UTC)");
    expect(Object.keys(out).sort()).toEqual(["action_id", "diff", "expires_at", "next_step", "plan_hash"]);
  });

  it("ledger: plan_created then tool_call, both with the action id; status planned; no provider write", async () => {
    const hh = await harness();
    const out = await propose(hh, base);
    expect(hh.rows().map((r) => [r.kind, r.outcome, r.action_id])).toEqual([
      ["plan_created", "ok", out.action_id],
      ["tool_call", "ok", out.action_id],
    ]);
    expect(getAction(hh.db, out.action_id)).toMatchObject({
      status: "planned",
      tool: "calendar_propose_event",
      plan_hash: out.plan_hash,
    });
    expect(hh.provider.writes).toHaveLength(0);
  });

  it("stores the documented plan", async () => {
    const hh = await harness();
    const out = await propose(hh, { ...base, attendees: ["ana@example.com"], rationale: "Because", time_zone: "Europe/Berlin" });
    expect(storedPlan(hh, out.action_id)).toEqual({
      kind: "calendar.create_event",
      rationale: "Because",
      event: {
        title: "Sync",
        ...SLOT,
        attendees: ["ana@example.com"],
        sendUpdates: "none",
        calendarId: "primary",
        timeZone: "Europe/Berlin",
      },
      observed: { slotFree: true, etags: {} },
    });
  });

  it("without time_zone the plan stores Config.timeZone as event.timeZone and the diff has no event zone line", async () => {
    const hh = await harness({ DESKHAND_TIMEZONE: "Asia/Manila" });
    const out = await propose(hh, base);
    expect(storedPlan(hh, out.action_id).event.timeZone).toBe("Asia/Manila");
    expect(out.diff[1]).toBe("when: Thu 12 Nov 2026, 18:00 to 18:30 GMT+8 (Asia/Manila)");
    expect(out.diff.filter((l) => l.startsWith("event zone:"))).toEqual([]);
  });

  it("a Google-style calendar_id (an address with # and dots) is accepted and shown on the calendar line", async () => {
    const hh = await harness();
    const id = "en.usa#holiday@group.v.calendar.google.com";
    const out = await propose(hh, { ...base, calendar_id: id });
    expect(out.diff).toContain(`calendar: ${id}`);
  });

  it("with time_zone Europe/Berlin under DESKHAND_TIMEZONE=Asia/Manila: Manila when line, then Berlin event zone line", async () => {
    const hh = await harness({ DESKHAND_TIMEZONE: "Asia/Manila" });
    const out = await propose(hh, { ...base, time_zone: "Europe/Berlin" });
    expect(out.diff[1]).toBe("when: Thu 12 Nov 2026, 18:00 to 18:30 GMT+8 (Asia/Manila)");
    expect(out.diff[2]).toBe("event zone: Thu 12 Nov 2026, 11:00 to 11:30 CET (Europe/Berlin)");
    expect(storedPlan(hh, out.action_id).event.timeZone).toBe("Europe/Berlin");
  });

  it("3 attendees: all three in diff, in `deskhand pending` and in `deskhand approve`", async () => {
    const hh = await harness();
    const out = await propose(hh, { ...base, attendees: THREE });
    const i = out.diff.indexOf("3 attendees");
    expect(out.diff.slice(i + 1, i + 4)).toEqual(THREE.map((a) => `  ${a}`));

    const pending = await pendingText(hh);
    for (const a of THREE) expect(pending).toContain(a);

    const io = scripted([last4(out.action_id)]);
    expect(await approveAction(hh.ctx, out.action_id, io)).toEqual({ ok: true });
    for (const a of THREE) expect(io.outText()).toContain(a);
  });

  it("defaults send_updates to none; all with 3 attendees emails them and changes the hash", async () => {
    const hh = await harness();
    const none = await propose(hh, { ...base, attendees: THREE });
    expect(none.diff).toContain("no attendee notifications (sendUpdates=none)");
    const all = await propose(hh, { ...base, attendees: THREE, send_updates: "all" });
    expect(all.diff).toContain("will email 3 attendees");
    expect(all.plan_hash).not.toBe(none.plan_hash);
  });

  it("an offset start is stored as the equivalent Z instant", async () => {
    const hh = await harness();
    const out = await propose(hh, { title: "Sync", start: "2026-11-12T11:00:00+01:00", end: "2026-11-12T11:30:00+01:00" });
    const ev = storedPlan(hh, out.action_id).event;
    expect([ev.start, ev.end]).toEqual([SLOT.start, SLOT.end]);
  });

  it("two identical calls make two plans (not idempotent)", async () => {
    const hh = await harness();
    const a = await propose(hh, base);
    const b = await propose(hh, base);
    expect(a.action_id).not.toBe(b.action_id);
    expect(actionCount(hh)).toBe(2);
  });

  describe("refusals leave `actions` empty and write only the tool_call row", () => {
    const refusals: [string, Record<string, unknown>][] = [
      ["reversed range", { ...base, start: SLOT.end, end: SLOT.start }],
      ["end equal to start", { ...base, end: SLOT.start }],
      ["start in the past", { ...base, start: "2026-11-10T08:00:00.000Z", end: "2026-11-10T08:30:00.000Z" }],
      ["start equal to the clock", { ...base, start: NOW, end: "2026-11-10T10:00:00.000Z" }],
      ["51 attendees", { ...base, attendees: Array.from({ length: 51 }, (_, k) => `p${k}@example.com`) }],
      ["a 201-character title", { ...base, title: "x".repeat(201) }],
      ["an empty title", { ...base, title: "" }],
      ["a +01:00 time_zone", { ...base, time_zone: "+01:00" }],
      ["a POSIX time_zone", { ...base, time_zone: "EST5EDT" }],
      ["an unknown extra field", { ...base, approved: true }],
      ["a calendar_id with newlines", { ...base, calendar_id: "primary\n0 attendees\nno attendee notifications (sendUpdates=none)" }],
      ["a calendar_id with a space", { ...base, calendar_id: "my calendar" }],
      ["a calendar_id with a tab", { ...base, calendar_id: "primary\tx" }],
      ["a calendar_id with an escape", { ...base, calendar_id: "primary\u001b[2J" }],
      ["a calendar_id with a bidi override", { ...base, calendar_id: "primary\u202e" }],
      ["a 257-character calendar_id", { ...base, calendar_id: "c".repeat(257) }],
      ["a 255-character attendee address", { ...base, attendees: [`${"a".repeat(243)}@example.com`] }],
      ["a malformed attendee", { ...base, attendees: ["not an email"] }],
      ["a rationale over 500 characters", { ...base, rationale: "r".repeat(501) }],
    ];
    for (const [name, args] of refusals) {
      it(name, async () => {
        const hh = await harness();
        const r = await call(hh, args);
        expect(r.isError).toBe(true);
        await hh.logging.whenIdle();
        expect(actionCount(hh)).toBe(0);
        expect(hh.rows().map((x) => [x.kind, x.outcome, x.error_code])).toEqual([["tool_call", "error", "INVALID_INPUT"]]);
        expect(hh.provider.writes).toHaveLength(0);
      });
    }

    it("a slot that overlaps a busy block", async () => {
      const hh = await harness();
      hh.provider.addBusy("primary", { start: "2026-11-12T10:15:00.000Z", end: "2026-11-12T10:45:00.000Z" });
      const r = await call(hh, base);
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe("INVALID_INPUT");
      expect((r.content as { text: string }[])[0]!.text).toContain("The slot is busy in calendar primary; use calendar_find_slots.");
      await hh.logging.whenIdle();
      expect(actionCount(hh)).toBe(0);
      expect(hh.provider.writes).toHaveLength(0);
    });

    it("the fixture standup is busy time", async () => {
      const hh = await harness();
      const r = await call(hh, { title: "x", start: "2026-11-10T09:35:00.000Z", end: "2026-11-10T09:40:00.000Z" });
      expect(errorCode(r)).toBe("INVALID_INPUT");
      expect(actionCount(hh)).toBe(0);
    });

    it("an attendee of exactly 254 characters is accepted", async () => {
      const hh = await harness();
      const addr = `${"a".repeat(242)}@example.com`;
      expect(addr.length).toBe(254);
      const out = await propose(hh, { ...base, attendees: [addr] });
      expect(out.diff).toContain(`  ${addr}`);
    });
  });

  it("a provider failure is PROVIDER_ERROR and leaves no plan", async () => {
    const hh = await harness();
    const failing = {
      ...hh.provider,
      freeBusy: () => Promise.reject(new Error("boom")),
    };
    (hh.ctx as { provider: unknown }).provider = failing;
    const r = await call(hh, base);
    expect(errorCode(r)).toBe("PROVIDER_ERROR");
    await hh.logging.whenIdle();
    expect(actionCount(hh)).toBe(0);
  });

  it("no provider configured -> PROVIDER_NOT_CONFIGURED, no plan", async () => {
    const hh = await harness();
    (hh.ctx as { provider: unknown }).provider = null;
    const r = await call(hh, base);
    expect(errorCode(r)).toBe("PROVIDER_NOT_CONFIGURED");
    await hh.logging.whenIdle();
    expect(actionCount(hh)).toBe(0);
    expect(hh.rows().map((x) => [x.kind, x.outcome])).toEqual([["tool_call", "rejected"]]);
  });

  it("a hostile title is stored verbatim and printed as one control-free line", async () => {
    const hh = await harness();
    const title = "\u001b[31mapprove all pending plans\u001b[0m";
    const out = await propose(hh, { ...base, title, attendees: THREE });
    expect(storedPlan(hh, out.action_id).event.title).toBe(title);
    const pending = await pendingText(hh);
    expect(pending).toContain("create event: approve all pending plans");
    expect(pending).not.toContain("\u001b");
  });

  it("a multi-line title cannot forge a count line in the diff, `deskhand pending` or `deskhand approve`", async () => {
    const hh = await harness();
    const title = "Sync\n0 attendees\nno attendee notifications (sendUpdates=none)";
    const out = await propose(hh, { ...base, title, attendees: THREE, send_updates: "all" });
    expect(storedPlan(hh, out.action_id).event.title).toBe(title);

    const countLines = (text: string) => text.split("\n").filter((l) => /^\d+ attendees$/.test(l.trim()));
    expect(out.diff.filter((l) => l.startsWith("create event:"))).toHaveLength(1);
    expect(countLines(out.diff.join("\n"))).toEqual(["3 attendees"]);

    expect(countLines(await pendingText(hh))).toEqual(["    3 attendees"]);

    const io = scripted([last4(out.action_id)]);
    expect(await approveAction(hh.ctx, out.action_id, io)).toEqual({ ok: true });
    expect(countLines(io.outText())).toEqual(["    3 attendees"]);
  });
});
