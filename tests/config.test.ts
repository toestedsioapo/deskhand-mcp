import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveActor } from "../src/config/actor.js";
import { loadConfig, ConfigError, resolveTimeZone } from "../src/config/env.js";
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
    const fx = { ...base, DESKHAND_PROVIDER: "fixture" };
    expect(loadConfig({ ...fx, DESKHAND_FIXTURE: "/f.json" }).fixturePath).toBe("/f.json");
    expect(loadConfig({ ...fx, DESKHAND_FIXTURE: "" }).fixturePath).toBeUndefined();
  });

  it("DESKHAND_PROVIDER unset is no provider; fixture is the only accepted value", () => {
    expect(loadConfig(base).provider).toBeNull();
    expect(loadConfig({ ...base, DESKHAND_PROVIDER: "fixture" }).provider).toBe("fixture");
  });

  it('DESKHAND_PROVIDER rejects every other value, naming the variable', () => {
    for (const v of ["Fixture", "google", "", "none"]) {
      expect(() => loadConfig({ ...base, DESKHAND_PROVIDER: v })).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, DESKHAND_PROVIDER: v })).toThrow(/DESKHAND_PROVIDER must be "fixture"/);
    }
  });

  it("DESKHAND_FIXTURE without DESKHAND_PROVIDER=fixture is a startup error", () => {
    expect(() => loadConfig({ ...base, DESKHAND_FIXTURE: "/x.json" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DESKHAND_FIXTURE: "/x.json" })).toThrow(/set DESKHAND_PROVIDER=fixture/);
  });

  it("DESKHAND_PROVIDER=fixture without DESKHAND_FIXTURE is allowed (empty world)", () => {
    const c = loadConfig({ ...base, DESKHAND_PROVIDER: "fixture" });
    expect(c.provider).toBe("fixture");
    expect(c.fixturePath).toBeUndefined();
  });
});

describe("loadConfig shutdownTimeoutMs", () => {
  const base = { DESKHAND_HOME: "/x/h" };

  it("defaults to 30000", () => {
    expect(loadConfig(base).shutdownTimeoutMs).toBe(30000);
  });

  it("accepts integers from 1000 to 120000", () => {
    for (const v of ["1000", "30000", "120000"]) {
      expect(loadConfig({ ...base, DESKHAND_SHUTDOWN_TIMEOUT_MS: v }).shutdownTimeoutMs).toBe(Number(v));
    }
  });

  it("rejects anything else, naming the variable", () => {
    for (const v of ["999", "120001", "10s", "", "0", "1000.5", " 5000", "5000 ", "1e4", "+5000", "-5000", "05000", "5000\n"]) {
      expect(() => loadConfig({ ...base, DESKHAND_SHUTDOWN_TIMEOUT_MS: v }), v).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, DESKHAND_SHUTDOWN_TIMEOUT_MS: v }), v).toThrow(/DESKHAND_SHUTDOWN_TIMEOUT_MS/);
    }
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

describe("loadConfig timeZone and rulesPath", () => {
  const base = { DESKHAND_HOME: "/x/h" };

  it("timeZone defaults to the system zone, DESKHAND_TIMEZONE overrides it", () => {
    expect(loadConfig(base).timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(loadConfig({ ...base, DESKHAND_TIMEZONE: "Europe/Berlin" }).timeZone).toBe("Europe/Berlin");
  });

  it("an invalid DESKHAND_TIMEZONE is a ConfigError naming the variable", () => {
    for (const v of ["+01:00", "EST5EDT", "Mars/Olympus", ""]) {
      expect(() => loadConfig({ ...base, DESKHAND_TIMEZONE: v })).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, DESKHAND_TIMEZONE: v })).toThrow(/DESKHAND_TIMEZONE/);
    }
  });

  it("resolveTimeZone: DESKHAND_TIMEZONE wins; else the system zone when it is an IANA name", () => {
    expect(resolveTimeZone("Europe/Berlin", "Asia/Manila")).toBe("Europe/Berlin");
    expect(resolveTimeZone(undefined, "Asia/Manila")).toBe("Asia/Manila");
    expect(resolveTimeZone(undefined, "UTC")).toBe("UTC");
    expect(resolveTimeZone("Europe/Berlin", "EST5EDT")).toBe("Europe/Berlin");
  });

  it("resolveTimeZone: a system zone that is not an IANA name is a ConfigError telling you to set DESKHAND_TIMEZONE", () => {
    for (const sys of ["EST5EDT", "+00:00", ""]) {
      expect(() => resolveTimeZone(undefined, sys), sys).toThrow(ConfigError);
      expect(() => resolveTimeZone(undefined, sys), sys).toThrow(/set DESKHAND_TIMEZONE/);
    }
  });

  it("rulesPath defaults to <configDir>/rules.json, DESKHAND_RULES overrides it", () => {
    const c = loadConfig(base);
    expect(c.rulesPath).toBe(join(c.paths.configDir, "rules.json"));
    expect(loadConfig({ ...base, DESKHAND_RULES: "/r/mine.json" }).rulesPath).toBe("/r/mine.json");
  });
});
