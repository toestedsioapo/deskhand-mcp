import { resolvePaths, type DataPaths } from "./paths.js";

export interface Config {
  writesEnabled: boolean;
  planTtlHours: number;
  busyTimeoutMs: number;
  /** Explicit provider choice (ADR 0008). null: none configured. M3b widens this to add "google". */
  provider: "fixture" | null;
  fixturePath: string | undefined;
  paths: DataPaths;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_TTL_HOURS = 24;
const BUSY_TIMEOUT_MS = 5000;

function parseTtl(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TTL_HOURS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ConfigError(`DESKHAND_PLAN_TTL_HOURS must be an integer from 1 to 168, got "${raw}"`);
  }
  const n = Number(raw);
  if (n < 1 || n > 168) {
    throw new ConfigError(`DESKHAND_PLAN_TTL_HOURS must be an integer from 1 to 168, got "${raw}"`);
  }
  return n;
}

function parseProvider(raw: string | undefined): "fixture" | null {
  if (raw === undefined) return null;
  if (raw === "fixture") return "fixture";
  throw new ConfigError(`DESKHAND_PROVIDER must be "fixture" (or unset for no provider), got "${raw}"`);
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  homedir?: string,
): Config {
  const provider = parseProvider(env["DESKHAND_PROVIDER"]);
  const fixturePath = env["DESKHAND_FIXTURE"] || undefined;
  if (fixturePath !== undefined && provider !== "fixture") {
    throw new ConfigError("DESKHAND_FIXTURE is set but no provider is selected; set DESKHAND_PROVIDER=fixture to use it");
  }
  return {
    writesEnabled: env["DESKHAND_ALLOW_WRITES"] === "1",
    planTtlHours: parseTtl(env["DESKHAND_PLAN_TTL_HOURS"]),
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    provider,
    fixturePath,
    paths: resolvePaths(env, platform, homedir),
  };
}
