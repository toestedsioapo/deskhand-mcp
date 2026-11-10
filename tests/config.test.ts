import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveActor } from "../src/config/actor.js";
import { loadConfig, ConfigError } from "../src/config/env.js";
import { ensureDirs, resolvePaths } from "../src/config/paths.js";

describe("resolveActor", () => {
  const throwing = () => {
    throw new Error("uv_os_get_passwd returned ENOENT");
  };

  it("uses os.userInfo().username when it works", () => {
    expect(resolveActor({ userInfo: () => ({ username: "marvin" }), env: { USER: "other" } })).toBe("marvin");
  });

  it("falls back to USER, then USERNAME, when userInfo throws", () => {
    expect(resolveActor({ userInfo: throwing, env: { USER: "u1", USERNAME: "u2" } })).toBe("u1");
    expect(resolveActor({ userInfo: throwing, env: { USERNAME: "u2" } })).toBe("u2");
  });

  it("falls back to USER/USERNAME when userInfo returns an empty name", () => {
    expect(resolveActor({ userInfo: () => ({ username: "" }), env: { USERNAME: "u2" } })).toBe("u2");
  });

  it("is 'unknown' when nothing is available (empty env values ignored)", () => {
    expect(resolveActor({ userInfo: throwing, env: {} })).toBe("unknown");
    expect(resolveActor({ userInfo: throwing, env: { USER: "", USERNAME: "" } })).toBe("unknown");
  });

  it("defaults to the real os.userInfo and process.env without throwing", () => {
    expect(typeof resolveActor()).toBe("string");
    expect(resolveActor().length).toBeGreaterThan(0);
  });
});

describe("resolvePaths", () => {
  it("DESKHAND_HOME wins and data === config", () => {
    const p = resolvePaths(
      { DESKHAND_HOME: "/x/h", LOCALAPPDATA: String.raw`C:\L` },
      "linux",
      "/home/u",
    );
    expect(p.dataDir).toBe("/x/h");
    expect(p.configDir).toBe("/x/h");
    expect(p.ledgerPath).toBe("/x/h/ledger.db");
  });

  it("win32 uses LOCALAPPDATA, never APPDATA", () => {
    const p = resolvePaths(
      { LOCALAPPDATA: String.raw`C:\Users\u\AppData\Local`, APPDATA: String.raw`C:\Roaming` },
      "win32",
      String.raw`C:\Users\u`,
    );
    expect(p.dataDir).toBe(String.raw`C:\Users\u\AppData\Local\deskhand`);
    expect(p.configDir).toBe(p.dataDir);
    expect(p.ledgerPath).toBe(String.raw`C:\Users\u\AppData\Local\deskhand\ledger.db`);
    expect(p.ledgerPath).not.toContain("Roaming");
  });

  it("linux defaults with differing data and config dirs", () => {
    const p = resolvePaths({}, "linux", "/home/u");
    expect(p.dataDir).toBe("/home/u/.local/share/deskhand");
    expect(p.configDir).toBe("/home/u/.config/deskhand");
    expect(p.ledgerPath).toBe("/home/u/.local/share/deskhand/ledger.db");
  });

  it("linux honours XDG overrides", () => {
    const p = resolvePaths(
      { XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c" },
      "linux",
      "/home/u",
    );
    expect(p.dataDir).toBe("/d/deskhand");
    expect(p.configDir).toBe("/c/deskhand");
  });

  it("win32 falls back to <home>\\AppData\\Local when LOCALAPPDATA is unset", () => {
    const p = resolvePaths({}, "win32", String.raw`C:\Users\u`);
    expect(p.dataDir).toBe(String.raw`C:\Users\u\AppData\Local\deskhand`);
  });

  it("DESKHAND_HOME wins on win32 and darwin too", () => {
    for (const plat of ["win32", "darwin"] as const) {
      const p = resolvePaths({ DESKHAND_HOME: "/x/h" }, plat, "/home/u");
      expect(p.dataDir).toBe("/x/h");
      expect(p.configDir).toBe("/x/h");
    }
  });

  it("darwin uses Application Support", () => {
    const p = resolvePaths({}, "darwin", "/Users/u");
    expect(p.dataDir).toBe("/Users/u/Library/Application Support/deskhand");
    expect(p.configDir).toBe(p.dataDir);
  });
});

describe("loadConfig", () => {
  const base = { DESKHAND_HOME: "/x/h" };

  it("defaults", () => {
    const c = loadConfig(base);
    expect(c.writesEnabled).toBe(false);
    expect(c.planTtlHours).toBe(24);
    expect(c.busyTimeoutMs).toBe(5000);
    expect(c.fixturePath).toBeUndefined();
    expect(c.paths.dataDir).toBe("/x/h");
  });

  it("writes enabled only for exactly '1'", () => {
    expect(loadConfig({ ...base, DESKHAND_ALLOW_WRITES: "1" }).writesEnabled).toBe(true);
    for (const v of ["true", "yes", "0", " 1", ""]) {
      expect(loadConfig({ ...base, DESKHAND_ALLOW_WRITES: v }).writesEnabled).toBe(false);
    }
  });

  it("plan TTL accepts 1..168 integers", () => {
    for (const v of ["1", "24", "168"]) {
      expect(loadConfig({ ...base, DESKHAND_PLAN_TTL_HOURS: v }).planTtlHours).toBe(Number(v));
    }
  });

  it("plan TTL rejects bad values naming the variable", () => {
    for (const v of ["0", "169", "1.5", "abc", "", "07", "007", "0000000000001", " 5", "5 ", "1e2", "0x10", "+5", "-1", "5\n"]) {
      expect(() => loadConfig({ ...base, DESKHAND_PLAN_TTL_HOURS: v })).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, DESKHAND_PLAN_TTL_HOURS: v })).toThrow(
        /DESKHAND_PLAN_TTL_HOURS/,
      );
    }
  });

  it("fixture path maps from DESKHAND_FIXTURE, empty is undefined", () => {
    expect(loadConfig({ ...base, DESKHAND_FIXTURE: "/f.json" }).fixturePath).toBe("/f.json");
    expect(loadConfig({ ...base, DESKHAND_FIXTURE: "" }).fixturePath).toBeUndefined();
  });
});

describe("ensureDirs", () => {
  it("creates nested dirs, mode 0700 on POSIX", () => {
    const root = mkdtempSync(join(tmpdir(), "deskhand-dirs-"));
    try {
      const dataDir = join(root, "a", "b", "data");
      const configDir = join(root, "c", "cfg");
      ensureDirs({ dataDir, configDir, ledgerPath: join(dataDir, "ledger.db") });
      expect(statSync(dataDir).isDirectory()).toBe(true);
      expect(statSync(configDir).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(dataDir).mode & 0o777).toBe(0o700);
        expect(statSync(configDir).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
