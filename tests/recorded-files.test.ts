import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("recorded responses", () => {
  it("no recording file matches the gitignored secret patterns (it would silently go untracked)", () => {
    const dir = fileURLToPath(new URL("./recorded/google/", import.meta.url));
    const bad = readdirSync(dir).filter((f) => /^(token|client_secret|credentials).*\.json$/i.test(f) || /^\.env/.test(f));
    expect(bad).toEqual([]);
  });
});
