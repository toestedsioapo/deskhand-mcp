import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE, requestedScopes } from "../src/config/scopes.js";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("requestedScopes", () => {
  it("read only without writes", () => {
    expect(requestedScopes(false)).toEqual([SCOPE_CALENDAR_READ]);
  });
  it("read then write with writes", () => {
    expect(requestedScopes(true)).toEqual([SCOPE_CALENDAR_READ, SCOPE_CALENDAR_WRITE]);
  });
  it("uses the exact scope strings", () => {
    expect(SCOPE_CALENDAR_READ).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(SCOPE_CALENDAR_WRITE).toBe("https://www.googleapis.com/auth/calendar.events");
  });
  it("src/ never mentions gmail.send or gmail.modify", () => {
    const files = walk(join(import.meta.dirname, "..", "src")).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text.includes("gmail.send"), f).toBe(false);
      expect(text.includes("gmail.modify"), f).toBe(false);
    }
  });
});
