import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PACKAGE_VERSION } from "../src/config/version.js";
import {
  pingHandler,
  pingInputSchema,
  pingOutputSchema,
} from "../src/tools/ping.js";

describe("ping", () => {
  it("returns ok with server name and package version", () => {
    expect(pingHandler()).toEqual({
      ok: true,
      server: "deskhand-mcp",
      version: PACKAGE_VERSION,
    });
  });

  it("rejects unknown input keys", () => {
    expect(pingInputSchema.safeParse({ x: 1 }).success).toBe(false);
    expect(pingInputSchema.safeParse({}).success).toBe(true);
  });

  it("has a stable input schema (contract)", () => {
    expect(z.toJSONSchema(pingInputSchema)).toMatchSnapshot();
  });

  it("has a stable output schema (contract)", () => {
    expect(z.toJSONSchema(pingOutputSchema)).toMatchSnapshot();
  });
});
