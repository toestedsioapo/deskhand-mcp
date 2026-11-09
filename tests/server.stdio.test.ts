import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/config/version.js";
import { spawnBin, spawnRaw } from "./helpers/spawn.js";

const expected = { ok: true, server: "deskhand-mcp", version: PACKAGE_VERSION };

describe("stdio server (built bin)", () => {
  it("lists exactly ping, calls it, survives bad input, stays silent on stderr", async () => {
    const { client, stderr, close } = await spawnBin();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ping"]);

      const ok = await client.callTool({ name: "ping" });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toEqual(expected);

      let rejected = false;
      try {
        const bad = await client.callTool({ name: "ping", arguments: { x: 1 } });
        rejected = bad.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      const again = await client.callTool({ name: "ping" });
      expect(again.structuredContent).toEqual(expected);
    } finally {
      await close();
    }
    expect(stderr()).toBe("");
  });

  it("exits 0 with empty stderr when stdin closes immediately", async () => {
    const child = spawnRaw();
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.stdin.end();
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(0);
    expect(stderr).toBe("");
  });
});
