import { resolvePaths, type DataPaths } from "./paths.js";

export interface Config {
  writesEnabled: boolean;
  planTtlHours: number;
  busyTimeoutMs: number;
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

export function loadConfig(
  env: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
  homedir?: string,
): Config {
  return {
    writesEnabled: env["DESKHAND_ALLOW_WRITES"] === "1",
    planTtlHours: parseTtl(env["DESKHAND_PLAN_TTL_HOURS"]),
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    fixturePath: env["DESKHAND_FIXTURE"] || undefined,
    paths: resolvePaths(env, platform, homedir),
  };
}
