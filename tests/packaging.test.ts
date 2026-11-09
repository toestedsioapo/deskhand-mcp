import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

describe("packaging contract", () => {
  it("declares the bin, engines, module type and license", () => {
    expect(pkg.bin).toEqual({
      "deskhand-mcp": "dist/server.js",
      deskhand: "dist/cli.js",
    });
    expect(pkg.engines.node).toBe(">=24.15");
    expect(pkg.type).toBe("module");
    expect(pkg.license).toBe("MIT");
  });

  it.each(["dist/server.js", "dist/cli.js"])("%s starts with a node shebang", (file) => {
    const text = readFileSync(resolve(root, file), "utf8");
    expect(text.split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});
