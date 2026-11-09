import { describe, expect, it } from "vitest";
import { assertSupportedNode } from "../src/config/node-check.js";

describe("assertSupportedNode", () => {
  it.each(["24.15.0", "24.22.2", "26.13.0"])("accepts %s", (v) => {
    expect(() => assertSupportedNode(v)).not.toThrow();
  });
  it.each(["24.11.1", "24.14.9", "22.20.0"])("rejects %s", (v) => {
    expect(() => assertSupportedNode(v)).toThrow(/requires Node >=24\.15/);
  });
});
