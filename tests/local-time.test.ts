import { describe, expect, it } from "vitest";
import { formatLocalRange, isIanaTimeZone } from "../src/util/local-time.js";

describe("isIanaTimeZone", () => {
  it("accepts IANA region names and UTC", () => {
    for (const tz of ["Europe/Berlin", "America/Argentina/Buenos_Aires", "UTC"]) {
      expect(isIanaTimeZone(tz), tz).toBe(true);
    }
  });

  it("rejects offsets, POSIX names, unknown zones and the empty string", () => {
    for (const tz of ["+01:00", "EST5EDT", "Mars/Olympus", ""]) {
      expect(isIanaTimeZone(tz), tz).toBe(false);
    }
  });
});

describe("formatLocalRange", () => {
  const cases: [string, string, string, string][] = [
    ["2026-11-12T10:00:00.000Z", "2026-11-12T10:30:00.000Z", "Europe/Berlin", "Thu 12 Nov 2026, 11:00 to 11:30 CET (Europe/Berlin)"],
    ["2026-11-12T10:00:00.000Z", "2026-11-12T10:30:00.000Z", "Asia/Kolkata", "Thu 12 Nov 2026, 15:30 to 16:00 GMT+5:30 (Asia/Kolkata)"],
    ["2026-11-12T10:00:00.000Z", "2026-11-12T10:30:00.000Z", "Asia/Manila", "Thu 12 Nov 2026, 18:00 to 18:30 GMT+8 (Asia/Manila)"],
    ["2026-11-12T22:30:00.000Z", "2026-11-12T23:30:00.000Z", "Europe/Berlin", "Thu 12 Nov 2026, 23:30 CET to Fri 13 Nov 2026, 00:30 CET (Europe/Berlin)"],
    ["2026-03-28T22:30:00.000Z", "2026-03-29T01:30:00.000Z", "Europe/Berlin", "Sat 28 Mar 2026, 23:30 CET to Sun 29 Mar 2026, 03:30 CEST (Europe/Berlin)"],
    ["2026-11-12T10:00:00.000Z", "2026-11-12T10:30:00.000Z", "UTC", "Thu 12 Nov 2026, 10:00 to 10:30 UTC (UTC)"],
  ];
  for (const [start, end, tz, want] of cases) {
    it(`${tz}: ${want}`, () => expect(formatLocalRange(start, end, tz)).toBe(want));
  }
});
