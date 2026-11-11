import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_FIXTURE_NOW, loadFixtureWorld } from "../src/providers/fixture/world.js";

const dir = mkdtempSync(join(tmpdir(), "deskhand-world-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, body: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

const ev = {
  id: "evt_standup",
  title: "Team standup",
  start: "2026-11-10T09:30:00.000Z",
  end: "2026-11-10T09:45:00.000Z",
  attendees: ["ana@example.com"],
  etag: "e1",
};

const valid = {
  fixture_version: 1,
  now: "2026-11-10T09:00:00.000Z",
  calendars: { primary: { events: [ev] } },
  settings: { latency_ms: 0 },
};

describe("loadFixtureWorld", () => {
  it("loads a valid file", () => {
    const w = loadFixtureWorld(write("ok.json", valid));
    expect(w.fixture_version).toBe(1);
    expect(w.calendars["primary"]?.events[0]?.id).toBe("evt_standup");
  });

  it("gives an empty world with a fixed now when the path is unset", () => {
    const w = loadFixtureWorld(undefined);
    expect(w.calendars).toEqual({});
    expect(w.now).toBe(DEFAULT_FIXTURE_NOW);
  });

  it("rejects a missing fixture_version naming the file", () => {
    const { fixture_version: _v, ...rest } = valid;
    const p = write("nover.json", rest);
    expect(() => loadFixtureWorld(p)).toThrow(p);
  });

  it("rejects an unknown fixture_version naming the file", () => {
    const p = write("v2.json", { ...valid, fixture_version: 2 });
    expect(() => loadFixtureWorld(p)).toThrow(p);
  });

  it("rejects malformed JSON, unknown keys and duplicate event ids", () => {
    expect(() => loadFixtureWorld(write("bad.json", "{nope"))).toThrow(/bad\.json/);
    expect(() => loadFixtureWorld(write("extra.json", { ...valid, mail: [] }))).toThrow(/extra\.json/);
    expect(() =>
      loadFixtureWorld(write("badset.json", { ...valid, settings: { nope: 1 } })),
    ).toThrow(/badset\.json/);
    expect(() =>
      loadFixtureWorld(write("dup.json", { ...valid, calendars: { primary: { events: [ev, ev] } } })),
    ).toThrow(/dup\.json/);
  });

  it("rejects an event whose start is not before end", () => {
    const bad = { ...ev, end: ev.start };
    expect(() =>
      loadFixtureWorld(write("order.json", { ...valid, calendars: { primary: { events: [bad] } } })),
    ).toThrow(/order\.json/);
  });

  it("throws a missing-file error naming the path", () => {
    const p = join(dir, "missing.json");
    expect(() => loadFixtureWorld(p)).toThrow(p);
  });

  describe("all_day events", () => {
    const offsite = {
      id: "evt_offsite",
      title: "Offsite",
      start: "2026-11-12",
      end: "2026-11-13",
      attendees: [],
      etag: "a1",
      all_day: true,
    };
    const withEvent = (e: unknown) => ({ ...valid, calendars: { primary: { events: [e] } } });

    it("loads an all-day event", () => {
      const w = loadFixtureWorld(write("allday.json", withEvent(offsite)));
      expect(w.calendars["primary"]?.events[0]).toMatchObject({ all_day: true, start: "2026-11-12" });
    });

    it("loads all_day: false with instants", () => {
      expect(() => loadFixtureWorld(write("adfalse.json", withEvent({ ...ev, all_day: false })))).not.toThrow();
    });

    it.each([
      ["all_day true with instants", { ...ev, all_day: true }],
      ["dates without all_day", { ...offsite, all_day: undefined }],
      ["dates with all_day false", { ...offsite, all_day: false }],
      ["start equal to end", { ...offsite, end: "2026-11-12" }],
      ["start after end", { ...offsite, start: "2026-11-14" }],
      ["an impossible date", { ...offsite, start: "2026-02-30", end: "2026-03-02" }],
      ["a non-boolean all_day", { ...offsite, all_day: "yes" }],
    ])("rejects %s", (name, e) => {
      const p = write(`bad-${name.replace(/\W+/g, "-")}.json`, withEvent(e));
      expect(() => loadFixtureWorld(p)).toThrow(p);
    });
  });
});
