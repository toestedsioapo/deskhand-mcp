import { mkdirSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { posix, win32 } from "node:path";

export interface DataPaths {
  dataDir: string;
  configDir: string;
  ledgerPath: string;
}

/**
 * Resolves data/config dirs (ADR 0005). Pure: everything comes from parameters.
 * Order: DESKHAND_HOME, then per-platform defaults.
 */
export function resolvePaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  homedir: string = osHomedir(),
): DataPaths {
  const p = platform === "win32" ? win32 : posix;
  const home = env["DESKHAND_HOME"];
  let dataDir: string;
  let configDir: string;
  if (home) {
    dataDir = configDir = home;
  } else if (platform === "win32") {
    const local = env["LOCALAPPDATA"] || p.join(homedir, "AppData", "Local");
    dataDir = configDir = p.join(local, "deskhand");
  } else if (platform === "darwin") {
    dataDir = configDir = p.join(homedir, "Library", "Application Support", "deskhand");
  } else {
    dataDir = p.join(env["XDG_DATA_HOME"] || p.join(homedir, ".local", "share"), "deskhand");
    configDir = p.join(env["XDG_CONFIG_HOME"] || p.join(homedir, ".config"), "deskhand");
  }
  return { dataDir, configDir, ledgerPath: p.join(dataDir, "ledger.db") };
}

/** Creates both directories recursively; mode 0700 on POSIX. */
export function ensureDirs(paths: DataPaths): void {
  const opts = process.platform === "win32" ? { recursive: true } : { recursive: true, mode: 0o700 };
  mkdirSync(paths.dataDir, opts);
  mkdirSync(paths.configDir, opts);
}
