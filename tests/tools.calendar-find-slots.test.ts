import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFixtureProvider } from "../src/providers/fixture/provider.js";
import type { CalendarProvider } from "../src/providers/types.js";
import { calendarFindSlotsInputSchema, calendarFindSlotsOutputSchema } from "../src/tools/calendar-find-slots.js";
import { setupHarness } from "./helpers/harness.js";
import { makeWorld } from "./helpers/seed.js";

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H;
beforeEach(async () => {
  h = await setupHarness();
});
afterEach(async () => {
  await h.close();
});

interface Slot {
  start: string;
  end: string;
  startUtc: string;
  endUtc: string;
}
interface Out {
  decision: "book" | "counter_offer" | "none";
  requested: Slot;
  slots: Slot[];
  busy_dropped: number;
  reasons: { code: string; participant_id: string | null; message: string }[];
  note: string | null;
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
const hours = (start: string, end: string) =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, [{ start, end }]]));
const rules = (partyId: string, start = "09:00", end = "17:00") => ({
  partyId,
  timeZone: "UTC",
  weeklyRules: hours(start, end),
});

// The harness clock is fixed at 2026-11-10T09:30:00Z (a Tuesday); the fixture standup is 09:30-09:45Z that day.
const base = {
  date: "2026-11-10",
  start: "10:00",
  end: "10:30",
  time_zone: "UTC",
  participants: [rules("them")],
  own_rules: rules("me"),
};
const call = (args: Record<string, unknown>) => h.client.callTool({ name: "calendar_find_slots", arguments: args });
const find = async (args: Record<string, unknown>): Promise<Out> => {
  const r = await call(args);
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  await h.logging.whenIdle();
  return r.structuredContent as unknown as Out;
};
const errorCode = (r: Awaited<ReturnType<typeof call>>) =>
  (r._meta as { deskhand: { error_code: string } }).deskhand.error_code;
const toolCallRows = () => h.rows().filter((r) => r.kind === "tool_call" && r.tool === "calendar_find_slots");
const overlaps = (s: Slot, bs: string, be: string) => Date.parse(s.startUtc) < Date.parse(be) && Date.parse(s.endUtc) > Date.parse(bs);

describe("calendar_find_slots schemas", () => {
  it("input schema is stable", () => expect(z.toJSONSchema(calendarFindSlotsInputSchema)).toMatchSnapshot());
  it("output schema is stable", () => expect(z.toJSONSchema(calendarFindSlotsOutputSchema)).toMatchSnapshot());
});

describe("calendar_find_slots", () => {
  it("is listed, read-only", async () => {
    const t = (await h.client.listTools()).tools.find((x) => x.name === "calendar_find_slots");
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });

  it("books the requested slot when it fits both rule sets and the calendar is free", async () => {
    const out = await find(base);
    expect(out.decision).toBe("book");
    expect(out.slots).toHaveLength(1);
    expect(out.slots[0]).toEqual(out.requested);
    expect(out.requested.startUtc).toBe("2026-11-10T10:00:00Z");
    expect(out.busy_dropped).toBe(0);
    expect(out.reasons).toEqual([]);
    expect(out.note).toBeNull();
  });

  it("counter-offers when the requested slot overlaps the standup, dropping the busy slot", async () => {
    const out = await find({ ...base, start: "09:30", end: "10:00", max_suggestions: 10 });
    expect(out.decision).toBe("counter_offer");
    expect(out.busy_dropped).toBeGreaterThanOrEqual(1);
    expect(out.slots.length).toBeGreaterThan(0);
    for (const s of out.slots) expect(overlaps(s, "2026-11-10T09:30:00.000Z", "2026-11-10T09:45:00.000Z")).toBe(false);
    expect(out.slots.map((s) => s.startUtc)).not.toContain(out.requested.startUtc);
    expect(out.note).toBeNull();
  });

  it("limits slots to max_suggestions (default 3)", async () => {
    const dflt = await find({ ...base, start: "09:30", end: "10:00" });
    expect(dflt.slots).toHaveLength(3);
    const one = await find({ ...base, start: "09:30", end: "10:00", max_suggestions: 1 });
    expect(one.slots).toHaveLength(1);
  });

  it("counter-offers with Tempo's reason when the request is outside the counterparty's hours", async () => {
    const out = await find({ ...base, participants: [rules("them", "12:00", "17:00")] });
    expect(out.decision).toBe("counter_offer");
    expect(out.reasons).toContainEqual(expect.objectContaining({ code: "OUTSIDE_AVAILABILITY", participant_id: "them" }));
    expect(out.slots.length).toBeGreaterThan(0);
    expect(out.slots[0]!.startUtc).toBe("2026-11-10T12:00:00Z");
  });

  it("gives none with the note when the requested slot and every alternative are busy", async () => {
    const world = makeWorld();
    world.calendars.primary!.events.push({
      id: "evt_block",
      title: "Offsite",
      start: "2026-11-09T00:00:00.000Z",
      end: "2026-12-31T00:00:00.000Z",
      attendees: [],
      etag: "e9",
    });
    h.ctx.provider = createFixtureProvider(world);
    const out = await find({ ...base, calendar_id: "primary" });
    expect(out.decision).toBe("none");
    expect(out.slots).toEqual([]);
    expect(out.busy_dropped).toBeGreaterThanOrEqual(2);
    expect(out.note).toBe("All suggested slots are busy in calendar primary.");
  });

  it("reads own rules from rules.json, and own_rules overrides the file", async () => {
    writeFileSync(h.ctx.config.rulesPath, JSON.stringify(rules("me-file", "09:00", "17:00")));
    const { own_rules: _unused, ...noOwn } = base;
    expect((await find(noOwn)).decision).toBe("book");
    // The file says 09:00-17:00; own_rules narrows the day to the afternoon, so the 10:00 request no longer fits.
    const overridden = await find({ ...noOwn, own_rules: rules("me", "13:00", "17:00") });
    expect(overridden.decision).toBe("counter_offer");
    expect(overridden.reasons).toContainEqual(expect.objectContaining({ code: "OUTSIDE_AVAILABILITY", participant_id: "me" }));
  });

  it("gives INVALID_INPUT naming the path and own_rules when there is no rules file and no own_rules", async () => {
    const { own_rules: _unused, ...noOwn } = base;
    const r = await call(noOwn);
    expect(r.isError).toBe(true);
    expect(errorCode(r)).toBe("INVALID_INPUT");
    const text = JSON.stringify(r.content);
    expect(text).toContain("own_rules");
    expect(text).toContain(h.ctx.config.rulesPath.replaceAll("\\", "\\\\"));
    await h.logging.whenIdle();
    expect(toolCallRows()).toHaveLength(1);
    expect(toolCallRows()[0]).toMatchObject({ outcome: "error", error_code: "INVALID_INPUT" });
  });

  it("gives INVALID_INPUT for a rules file that is not JSON or fails the schema, and keeps answering ping", async () => {
    const { own_rules: _unused, ...noOwn } = base;
    for (const content of ["{not json", JSON.stringify({ partyId: "me" })]) {
      writeFileSync(h.ctx.config.rulesPath, content);
      const r = await call(noOwn);
      expect(r.isError).toBe(true);
      expect(errorCode(r)).toBe("INVALID_INPUT");
      expect(JSON.stringify(r.content)).toContain("own_rules");
      expect((await h.client.callTool({ name: "ping", arguments: {} })).isError).toBeFalsy();
    }
  });

  it("refuses a time_zone that is not an IANA zone name as INVALID_INPUT", async () => {
    for (const tz of ["+01:00", "EST5EDT", ""]) {
      const r = await call({ ...base, time_zone: tz });
      expect(r.isError, tz).toBe(true);
      expect(errorCode(r), tz).toBe("INVALID_INPUT");
    }
  });

  it("defaults time_zone to the configured zone", async () => {
    h.ctx.config.timeZone = "UTC";
    const { time_zone: _unused, ...noTz } = base;
    expect((await find(noTz)).requested.start).toContain("2026-11-10T10:00");
  });

  it("refuses a duplicate partyId between own rules and a participant as INVALID_INPUT", async () => {
    const r = await call({ ...base, participants: [rules("me")] });
    expect(r.isError).toBe(true);
    expect(errorCode(r)).toBe("INVALID_INPUT");
    expect(JSON.stringify(r.content)).toMatch(/me/);
  });

  it("refuses a calendar-invalid date as INVALID_INPUT", async () => {
    const r = await call({ ...base, date: "2026-02-31" });
    expect(r.isError).toBe(true);
    expect(errorCode(r)).toBe("INVALID_INPUT");
  });

  it("refuses bad shapes and out-of-range numbers as INVALID_INPUT", async () => {
    const bad = [
      { max_suggestions: 0 },
      { max_suggestions: 11 },
      { min_notice_minutes: -1 },
      { min_notice_minutes: 525601 },
      { search_horizon_days: 0 },
      { search_horizon_days: 91 },
      { participants: [] },
      { participants: Array.from({ length: 50 }, (_, i) => rules(`p${i}`)) },
      { date: "10/11/2026" },
      { start: "9:00" },
      { calendar_id: "" },
      { bogus: 1 },
    ];
    for (const extra of bad) expect((await call({ ...base, ...extra })).isError, JSON.stringify(extra)).toBe(true);
    await h.logging.whenIdle();
    const rows = toolCallRows();
    expect(rows).toHaveLength(bad.length);
    for (const row of rows) expect(row).toMatchObject({ outcome: "error", error_code: "INVALID_INPUT" });
  });

  it("gives PROVIDER_NOT_CONFIGURED, logged rejected, with no provider", async () => {
    h.ctx.provider = null;
    const r = await call(base);
    expect(r.isError).toBe(true);
    expect(errorCode(r)).toBe("PROVIDER_NOT_CONFIGURED");
    await h.logging.whenIdle();
    expect(toolCallRows()[0]).toMatchObject({ outcome: "rejected", error_code: "PROVIDER_NOT_CONFIGURED" });
  });

  it("maps a throwing freeBusy to PROVIDER_ERROR without leaking its message", async () => {
    const boom: CalendarProvider = {
      freeBusy: () => Promise.reject(new Error("secret internal detail")),
      getEvent: () => Promise.reject(new Error("x")),
      listEvents: () => Promise.reject(new Error("x")),
      createEvent: () => Promise.reject(new Error("x")),
    };
    h.ctx.provider = boom;
    const r = await call(base);
    expect(r.isError).toBe(true);
    expect(errorCode(r)).toBe("PROVIDER_ERROR");
    expect(JSON.stringify(r)).not.toContain("secret internal detail");
  });

  it("writes exactly one tool_call row per call and changes nothing else", async () => {
    const provider = createFixtureProvider(makeWorld());
    h.ctx.provider = provider;
    const before = h.rows().length;
    await find(base);
    await find({ ...base, start: "09:30", end: "10:00" });
    const rows = h.rows();
    expect(rows).toHaveLength(before + 2);
    expect(toolCallRows()).toHaveLength(2);
    expect(toolCallRows().every((r) => r.outcome === "ok")).toBe(true);
    expect(h.db.all("SELECT id FROM actions")).toHaveLength(0);
    expect(provider.writes).toHaveLength(0);
  });
});
