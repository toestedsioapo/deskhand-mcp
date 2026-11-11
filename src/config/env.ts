import { join } from "node:path";
import { isIanaTimeZone } from "../util/local-time.js";
import { resolvePaths, type DataPaths } from "./paths.js";

export interface Config {
  writesEnabled: boolean;
  planTtlHours: number;
  busyTimeoutMs: number;
  /** Explicit provider choice (ADR 0008). null: none configured. M3b widens this to add "google". */
  provider: "fixture" | null;
  fixturePath: string | undefined;
  /** IANA zone used when a tool call names none: `DESKHAND_TIMEZONE`, else the system zone. */
  timeZone: string;
  /** The caller's working-hours rules file: `DESKHAND_RULES`, else `<configDir>/rules.json`. */
  rulesPath: string;
  /** Upper bound on the shutdown drain: `DESKHAND_SHUTDOWN_TIMEOUT_MS` (1000 to 120000), else 30000. */
  shutdownTimeoutMs: number;
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

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function parseShutdownTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const n = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1000 && n <= 120_000)) {
    throw new ConfigError(`DESKHAND_SHUTDOWN_TIMEOUT_MS must be an integer from 1000 to 120000, got "${raw}"`);
  }
  return n;
}

function parseProvider(raw: string | undefined): "fixture" | null {
  if (raw === undefined) return null;
  if (raw === "fixture") return "fixture";
  throw new ConfigError(`DESKHAND_PROVIDER must be "fixture" (or unset for no provider), got "${raw}"`);
}

function parseTimeZone(raw: string | undefined): string {
  if (raw === undefined) return Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!isIanaTimeZone(raw)) {
    throw new ConfigError(`DESKHAND_TIMEZONE must be an IANA time zone name such as "Europe/Berlin", got "${raw}"`);
  }
  return raw;
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
  const paths = resolvePaths(env, platform, homedir);
  return {
    writesEnabled: env["DESKHAND_ALLOW_WRITES"] === "1",
    planTtlHours: parseTtl(env["DESKHAND_PLAN_TTL_HOURS"]),
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    provider,
    fixturePath,
    timeZone: parseTimeZone(env["DESKHAND_TIMEZONE"]),
    rulesPath: env["DESKHAND_RULES"] || join(paths.configDir, "rules.json"),
    shutdownTimeoutMs: parseShutdownTimeout(env["DESKHAND_SHUTDOWN_TIMEOUT_MS"]),
    paths,
  };
}
