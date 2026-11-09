import { describe, expect, it } from "vitest";
import { createIdGenerator, isoNow, last4 } from "../src/ledger/ids.js";

describe("ids", () => {
  it("matches the action id format", () => {
    expect(createIdGenerator().newActionId()).toMatch(/^act_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("generates distinct ids", () => {
    const g = createIdGenerator();
    expect(g.newActionId()).not.toBe(g.newActionId());
  });

  it("is deterministic with injected now/random", () => {
    const mk = () =>
      createIdGenerator({ now: () => 1_700_000_000_000, random: (n) => new Uint8Array(n).fill(7) });
    expect(mk().newActionId()).toBe(mk().newActionId());
  });

  it("encodes timestamp 0 with zero random as all zeros", () => {
    const g = createIdGenerator({ now: () => 0, random: (n) => new Uint8Array(n) });
    expect(g.newActionId()).toBe("act_" + "0".repeat(26));
  });

  it("sorts ascending with increasing timestamps", () => {
    let t = 1_700_000_000_000;
    const g = createIdGenerator({ now: () => t++ });
    const ids = Array.from({ length: 20 }, () => g.newActionId());
    expect([...ids].sort()).toEqual(ids);
  });

  it("last4 returns the final 4 chars uppercased", () => {
    expect(last4("act_01JC3Z8K4V7Q2W9X5R6T1N0BHM")).toBe("0BHM");
    expect(last4("act_abcdefgh")).toBe("EFGH");
  });

  it("isoNow gives ISO UTC with ms and Z", () => {
    expect(isoNow(() => new Date(Date.UTC(2026, 10, 9, 1, 2, 3, 4)))).toBe(
      "2026-11-09T01:02:03.004Z",
    );
  });
});
