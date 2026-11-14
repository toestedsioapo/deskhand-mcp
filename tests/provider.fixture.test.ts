import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureProvider } from "../src/providers/fixture/provider.js";
import type { NewCalendarEvent } from "../src/providers/types.js";
import { makeWorld } from "./helpers/seed.js";

const dir = mkdtempSync(join(tmpdir(), "deskhand-prov-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const newEvent: NewCalendarEvent = {
  title: "Sync",
  start: "2026-11-10T14:00:00.000Z",
  end: "2026-11-10T15:00:00.000Z",
  attendees: ["ana@example.com"],
  sendUpdates: "none",
  calendarId: "primary",
};

describe("fixture provider", () => {
  it("freeBusy returns overlapping events and addBusy ranges only", async () => {
    const p = createFixtureProvider(makeWorld());
    p.addBusy("primary", { start: "2026-11-10T12:00:00.000Z", end: "2026-11-10T13:00:00.000Z" });
    const { busy } = await p.freeBusy("primary", {
      start: "2026-11-10T09:40:00.000Z",
      end: "2026-11-10T12:30:00.000Z",
    });
    expect(busy).toEqual([
      { start: "2026-11-10T09:30:00.000Z", end: "2026-11-10T09:45:00.000Z" },
      { start: "2026-11-10T12:00:00.000Z", end: "2026-11-10T13:00:00.000Z" },
    ]);
    const none = await p.freeBusy("primary", {
      start: "2026-11-10T16:00:00.000Z",
      end: "2026-11-10T17:00:00.000Z",
    });
    expect(none.busy).toEqual([]);
    const unknown = await p.freeBusy("nope", {
      start: "2026-11-10T00:00:00.000Z",
      end: "2026-11-11T00:00:00.000Z",
    });
    expect(unknown.busy).toEqual([]);
  });

  it("getEvent returns null for unknown ids and a new etag after touchEvent", async () => {
    const p = createFixtureProvider(makeWorld());
    expect(await p.getEvent("primary", "nope")).toBeNull();
    const before = await p.getEvent("primary", "evt_standup");
    expect(before?.etag).toBe("e1");
    p.touchEvent("primary", "evt_standup");
    const after = await p.getEvent("primary", "evt_standup");
    expect(after?.etag).not.toBe("e1");
    expect(after?.title).toBe("Team standup");
  });

  it("createEvent uses the key as id, records the write, and is idempotent", async () => {
    const p = createFixtureProvider(makeWorld());
    const a = await p.createEvent(newEvent, "key1");
    expect(a.id).toBe("key1");
    expect(p.writes).toHaveLength(1);
    const b = await p.createEvent(newEvent, "key1");
    expect(b).toEqual(a);
    expect(p.writes).toHaveLength(1);
    expect(await p.getEvent("primary", "key1")).toEqual(a);
    const { busy } = await p.freeBusy("primary", { start: newEvent.start, end: newEvent.end });
    expect(busy).toEqual([{ start: newEvent.start, end: newEvent.end }]);
  });

  it("calls afterWrite after the write is recorded, once per distinct write", async () => {
    const seen: number[] = [];
    const p = createFixtureProvider(makeWorld(), { afterWrite: () => seen.push(p.writes.length) });
    await p.createEvent(newEvent, "k1");
    await p.createEvent(newEvent, "k1");
    expect(seen).toEqual([1]);
  });

  it("appends exactly one JSON line per distinct write to write_log", async () => {
    const log = join(dir, "writes.jsonl");
    const world = makeWorld({ settings: { latency_ms: 0, write_log: log } });
    const p = createFixtureProvider(world);
    await p.createEvent(newEvent, "k1");
    await p.createEvent(newEvent, "k1");
    await p.createEvent({ ...newEvent, title: "Other" }, "k2");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({ seq: 1, op: "calendar.createEvent", idempotency_key: "k1" });
    expect(first["ts"]).toBe(world.now);
    expect(JSON.parse(lines[1]!)).toMatchObject({ seq: 2, idempotency_key: "k2" });
  });

  it("latency_ms delays every call", async () => {
    const p = createFixtureProvider(makeWorld({ settings: { latency_ms: 50 } }));
    const t0 = performance.now();
    await p.getEvent("primary", "evt_standup");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
  });

  describe("listEvents", () => {
    const world = () =>
      makeWorld({
        calendars: {
          primary: {
            events: [
              { id: "b", title: "B", start: "2026-11-10T11:00:00.000Z", end: "2026-11-10T12:00:00.000Z", attendees: [], etag: "e1" },
              { id: "a", title: "A", start: "2026-11-10T09:30:00.000Z", end: "2026-11-10T09:45:00.000Z", attendees: ["x@example.com"], etag: "e1" },
              { id: "c", title: "C", start: "2026-11-11T09:00:00.000Z", end: "2026-11-11T10:00:00.000Z", attendees: [], etag: "e1" },
            ],
          },
        },
      });
    const day10 = { start: "2026-11-10T00:00:00.000Z", end: "2026-11-11T00:00:00.000Z" };

    it("returns overlapping events in start order, allDay false", async () => {
      const p = createFixtureProvider(world());
      const r = await p.listEvents("primary", day10, 10);
      expect(r.events.map((e) => e.id)).toEqual(["a", "b"]);
      expect(r.events.every((e) => e.allDay === false)).toBe(true);
      expect(r.truncated).toBe(false);
    });

    it("sorts ties by id", async () => {
      const t = { start: "2026-11-10T09:00:00.000Z", end: "2026-11-10T10:00:00.000Z", attendees: [], etag: "e1" };
      const p = createFixtureProvider(
        makeWorld({ calendars: { primary: { events: [{ id: "z", title: "Z", ...t }, { id: "m", title: "M", ...t }] } } }),
      );
      const r = await p.listEvents("primary", day10, 10);
      expect(r.events.map((e) => e.id)).toEqual(["m", "z"]);
    });

    it("caps at limit and sets truncated", async () => {
      const p = createFixtureProvider(world());
      const r = await p.listEvents("primary", day10, 1);
      expect(r.events.map((e) => e.id)).toEqual(["a"]);
      expect(r.truncated).toBe(true);
      const exact = await p.listEvents("primary", day10, 2);
      expect(exact.truncated).toBe(false);
    });

    it("returns an empty result for an unknown calendar", async () => {
      const p = createFixtureProvider(world());
      expect(await p.listEvents("nope", day10, 5)).toEqual({ events: [], truncated: false });
    });

    it("includes created events with allDay false", async () => {
      const p = createFixtureProvider(makeWorld());
      const created = await p.createEvent(newEvent, "key1");
      expect(created.allDay).toBe(false);
      const r = await p.listEvents("primary", { start: newEvent.start, end: newEvent.end }, 5);
      expect(r.events).toEqual([created]);
    });

    it("returns copies", async () => {
      const p = createFixtureProvider(world());
      const r = await p.listEvents("primary", day10, 5);
      r.events[0]!.title = "mutated";
      r.events[0]!.attendees.push("evil@example.com");
      const again = await p.listEvents("primary", day10, 5);
      expect(again.events[0]?.title).toBe("A");
      expect(again.events[0]?.attendees).toEqual(["x@example.com"]);
    });

    it("applies latency_ms", async () => {
      const p = createFixtureProvider(makeWorld({ settings: { latency_ms: 50 } }));
      const t0 = performance.now();
      await p.listEvents("primary", day10, 5);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    });
  });

  describe("all-day events", () => {
    const offsite = {
      id: "evt_offsite",
      title: "Offsite",
      start: "2026-11-12",
      end: "2026-11-13",
      attendees: [],
      etag: "a1",
      all_day: true,
    };
    const timed = {
      id: "evt_timed",
      title: "Timed",
      start: "2026-11-12T09:30:00.000Z",
      end: "2026-11-12T10:00:00.000Z",
      attendees: [],
      etag: "t1",
    };
    const world = () => makeWorld({ calendars: { primary: { events: [timed, offsite] } } });
    const day12 = { start: "2026-11-12T00:00:00.000Z", end: "2026-11-13T00:00:00.000Z" };

    it("listEvents returns dates, sorted before a later timed event", async () => {
      const p = createFixtureProvider(world());
      const r = await p.listEvents("primary", day12, 10);
      expect(r.events.map((e) => e.id)).toEqual(["evt_offsite", "evt_timed"]);
      expect(r.events[0]).toMatchObject({ allDay: true, start: "2026-11-12", end: "2026-11-13" });
      expect(r.events[0]?.start).not.toContain("T");
      expect(r.events[1]?.allDay).toBe(false);
    });

    it("is not returned for a range entirely on the end date", async () => {
      const p = createFixtureProvider(world());
      const r = await p.listEvents(
        "primary",
        { start: "2026-11-13T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" },
        10,
      );
      expect(r.events).toEqual([]);
    });

    it("does not count as busy in freeBusy", async () => {
      const p = createFixtureProvider(world());
      const { busy } = await p.freeBusy("primary", day12);
      expect(busy).toEqual([{ start: timed.start, end: timed.end }]);
    });

    it("getEvent returns the same shape", async () => {
      const p = createFixtureProvider(world());
      expect(await p.getEvent("primary", "evt_offsite")).toEqual({
        id: "evt_offsite",
        title: "Offsite",
        start: "2026-11-12",
        end: "2026-11-13",
        attendees: [],
        etag: "a1",
        allDay: true,
      });
      expect((await p.getEvent("primary", "evt_timed"))?.allDay).toBe(false);
    });
  });
});
