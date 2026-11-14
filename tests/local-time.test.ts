import { describe, expect, it } from "vitest";
import { canonicalTimeZone, formatLocalRange, isIanaTimeZone } from "../src/util/local-time.js";
import { TZ_NAMES, TZ_NAMES_RELEASE } from "../src/util/tz-names.js";

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

describe("canonicalTimeZone", () => {
  // Exact strings from the pinned tzdata list: the same on every Node and ICU version.
  const cases: [string, string][] = [
    ["europe/berlin", "Europe/Berlin"],
    ["EUROPE/BERLIN", "Europe/Berlin"],
    ["asia/manila", "Asia/Manila"],
    ["america/argentina/buenos_aires", "America/Argentina/Buenos_Aires"],
    ["america/port-au-prince", "America/Port-au-Prince"],
    ["america/knox_in", "America/Knox_IN"],
    ["etc/utc", "Etc/UTC"],
    ["ETC/UTC", "Etc/UTC"],
    ["etc/gmt+5", "Etc/GMT+5"],
    ["Asia/kolkata", "Asia/Kolkata"],
    ["asia/calcutta", "Asia/Calcutta"],
    ["europe/Kyiv", "Europe/Kyiv"],
    ["US/pacific", "US/Pacific"],
    ["us/pacific", "US/Pacific"],
    ["brazil/denoronha", "Brazil/DeNoronha"],
    ["utc", "UTC"],
    ["UTC", "UTC"],
    ["Europe/Berlin", "Europe/Berlin"],
  ];
  for (const [input, want] of cases) it(`${input} is ${want}`, () => expect(canonicalTimeZone(input)).toBe(want));

  it("keeps aliases under their own name, never resolving them", () => {
    for (const tz of ["Asia/Calcutta", "Asia/Kolkata", "US/Pacific", "Etc/UTC", "America/Argentina/ComodRivadavia"]) {
      expect(canonicalTimeZone(tz), tz).toBe(tz);
    }
  });

  it("is null for anything isIanaTimeZone rejects", () => {
    for (const tz of ["+01:00", "EST5EDT", "Mars/Olympus", ""]) expect(canonicalTimeZone(tz), tz).toBeNull();
  });
});

describe("TZ_NAMES", () => {
  it("is pinned to one release, sorted and without duplicates", () => {
    expect(TZ_NAMES_RELEASE).toBe("2026e");
    expect(new Set(TZ_NAMES).size).toBe(TZ_NAMES.length);
    expect([...TZ_NAMES].sort()).toEqual([...TZ_NAMES]);
  });

  // Not every name: a runtime's tz data may be older than the pin. Only long-standing names are checked against Intl.
  it("lists a sample of long-standing names, each valid for this runtime", () => {
    for (const n of ["Europe/Berlin", "Asia/Kolkata", "Asia/Calcutta", "America/Knox_IN", "Etc/UTC", "US/Pacific"]) {
      expect(TZ_NAMES, n).toContain(n);
      expect(isIanaTimeZone(n), n).toBe(true);
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
