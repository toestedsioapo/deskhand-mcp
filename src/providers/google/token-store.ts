import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../../config/env.js";

export interface StoredToken {
  version: 1;
  client_id: string;
  scopes: string[];
  refresh_token: string;
  access_token: string;
  /** Access token expiry, ISO UTC. */
  expires_at: string;
  /** When the refresh token was issued (login or upgrade). */
  obtained_at: string;
}

export function tokenPath(configDir: string): string {
  return join(configDir, "token.json");
}

function isStoredToken(v: unknown): v is StoredToken {
  if (v === null || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  const str = (k: string) => typeof t[k] === "string" && t[k] !== "";
  return (
    t.version === 1 &&
    str("client_id") &&
    str("refresh_token") &&
    str("access_token") &&
    str("expires_at") &&
    str("obtained_at") &&
    Array.isArray(t.scopes) &&
    t.scopes.every((s) => typeof s === "string")
  );
}

/** null when missing; ConfigError when unreadable or malformed (content is never echoed). */
export function readToken(configDir: string): StoredToken | null {
  const file = tokenPath(configDir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`cannot read ${file}; run \`deskhand auth login\``);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${file} is malformed; run \`deskhand auth login\``);
  }
  if (!isStoredToken(parsed)) throw new ConfigError(`${file} is malformed; run \`deskhand auth login\``);
  return parsed;
}

/** Temp file then rename, so a failure leaves the previous file intact. Mode 0600 on POSIX. */
export function writeToken(configDir: string, token: StoredToken): void {
  const file = tokenPath(configDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(token, null, 2) + "\n";
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
