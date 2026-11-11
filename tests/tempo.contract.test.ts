import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findSlots, type SlotQuery, type SlotResult } from "../src/tempo/index.js";
import { partyRulesSchema } from "../src/tempo/rules.js";

/**
 * Contract test: tempo-core's own shipped fixtures, run through the Deskhand adapter.
 * A Tempo upgrade that changes behaviour fails here (ADR 0006).
 *
 * The shipped fixtures name `evaluate` (and one `explain`) as their entry; none names `suggest`.
 * `suggest` takes the same input and returns the same shape, so the `evaluate` fixtures are the
 * contract for it, with one documented difference: on a `book`, `suggest.slots` is the ranked
 * search result with the requested slot first (tempo-core A-66), where `evaluate.slots` holds
 * only the requested slot.
 */
interface Fixture {
  id: string;
  entry: string;
  input: {
    request: { date: string; start: string; end: string; timeZone: string };
    participants: SlotQuery["participants"];
    options: { now: string; minNoticeMinutes?: number; searchHorizonDays?: number; maxSuggestions?: number };
  };
  expected:
    | { ok: true; decision: "book" | "counter_offer"; requested: object; slots: object[]; reasons: object[] }
    | { ok: false; error: { code: string; message: string } };
}

const resolveFixture = (rel: string): string => fileURLToPath(import.meta.resolve(`@marvinliem/tempo-core/fixtures/${rel}`));

// The package's own lock file lists every shipped fixture; resolve each through the `./fixtures/*` export.
const loadFixtures = (dir: "examples" | "dst"): Fixture[] =>
  Object.keys(JSON.parse(readFileSync(resolveFixture("fixtures.lock.json"), "utf8")) as Record<string, string>)
    .filter((rel) => rel.startsWith(`${dir}/`) && rel.endsWith(".json"))
    .sort()
    .map((rel) => JSON.parse(readFileSync(resolveFixture(rel), "utf8")) as Fixture);

const ALL = [...loadFixtures("examples"), ...loadFixtures("dst")];
// `explain` has a different output shape; every other entry shares suggest's input.
const SUGGEST_COMPATIBLE = ALL.filter((f) => f.entry === "evaluate" || f.entry === "suggest");

const toQuery = (f: Fixture): SlotQuery => {
  const { request, participants, options } = f.input;
  const q: SlotQuery = { ...request, participants, now: new Date(options.now) };
  if (options.minNoticeMinutes !== undefined) q.minNoticeMinutes = options.minNoticeMinutes;
  if (options.searchHorizonDays !== undefined) q.searchHorizonDays = options.searchHorizonDays;
  if (options.maxSuggestions !== undefined) q.maxSuggestions = options.maxSuggestions;
  return q;
};

describe("tempo adapter contract (tempo-core shipped fixtures)", () => {
  it("finds fixtures to run, covering book, counter_offer and error", () => {
    const ran = SUGGEST_COMPATIBLE.map((f) => (f.expected.ok ? f.expected.decision : "error"));
    expect(ran).toContain("book");
    expect(ran).toContain("counter_offer");
    expect(ran).toContain("error");
  });

  for (const f of SUGGEST_COMPATIBLE) {
    it(`${f.id}: findSlots matches the fixture`, () => {
      const got = findSlots(toQuery(f));
      if (!f.expected.ok) {
        expect(got).toEqual({ ok: false, code: f.expected.error.code, message: f.expected.error.message } satisfies SlotResult);
        return;
      }
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.decision).toBe(f.expected.decision);
      expect(got.requested).toEqual(f.expected.requested);
      expect(got.reasons).toEqual(f.expected.reasons);
      if (f.expected.decision === "counter_offer") {
        expect(got.slots).toEqual(f.expected.slots);
      } else {
        // book: the requested slot first (A-66), then any further ranked slots.
        expect(got.slots[0]).toEqual(f.expected.requested);
      }
    });
  }

  it("every participant in every successful fixture parses with partyRulesSchema", () => {
    const parties = ALL.filter((f) => f.expected.ok).flatMap((f) => f.input.participants);
    expect(parties.length).toBeGreaterThan(0);
    for (const p of parties) expect(partyRulesSchema.safeParse(p).success, p.partyId).toBe(true);
  });

  it("partyRulesSchema is strict and defaults blackouts to []", () => {
    const base = { partyId: "a", timeZone: "UTC", weeklyRules: { monday: [{ start: "09:00", end: "24:00" }] } };
    expect(partyRulesSchema.parse(base).blackouts).toEqual([]);
    expect(partyRulesSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(partyRulesSchema.safeParse({ ...base, partyId: "" }).success).toBe(false);
    expect(partyRulesSchema.safeParse({ ...base, partyId: "x".repeat(65) }).success).toBe(false);
    expect(partyRulesSchema.safeParse({ ...base, weeklyRules: { monday: [{ start: "9:00", end: "17:00" }] } }).success).toBe(false);
    expect(partyRulesSchema.safeParse({ ...base, weeklyRules: { monday: [{ start: "24:00", end: "17:00" }] } }).success).toBe(false);
    expect(partyRulesSchema.safeParse({ ...base, blackouts: ["2025-1-1"] }).success).toBe(false);
  });

  it("drops milliseconds from `now` (Tempo rejects fractions)", () => {
    const f = SUGGEST_COMPATIBLE.find((x) => x.id === "EX-01")!;
    const q = toQuery(f);
    const got = findSlots({ ...q, now: new Date(q.now.getTime() + 789) });
    expect(got.ok).toBe(true);
  });

  it("package.json pins tempo-core to exactly 0.1.0", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies["@marvinliem/tempo-core"]).toBe("0.1.0");
  });
});
