import { describe, expect, it } from "vitest";
import { isIanaTimeZone } from "../src/util/local-time.js";

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
