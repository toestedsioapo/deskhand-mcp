import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../../config/env.js";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

const GUIDE = "docs/google-oauth-setup.md";

/** Reads <configDir>/client_secret.json (Desktop-app shape only). Error messages never include file content. */
export function loadOAuthClient(configDir: string): OAuthClient {
  const file = join(configDir, "client_secret.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(`OAuth client file not found at ${file}; follow ${GUIDE} to create one`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${file} is not valid JSON; download the client file again (see ${GUIDE})`);
  }
  const obj = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (obj.type === "service_account") {
    throw new ConfigError(`${file} is a service-account key; create a "Desktop app" OAuth client instead (see ${GUIDE})`);
  }
  if ("web" in obj && !("installed" in obj)) {
    throw new ConfigError(`${file} is a "Web application" client; create a "Desktop app" client instead (see ${GUIDE})`);
  }
  const inst = obj.installed;
  if (inst === null || typeof inst !== "object") {
    throw new ConfigError(`${file} is not a Desktop-app client file; create a "Desktop app" client (see ${GUIDE})`);
  }
  const { client_id, client_secret } = inst as Record<string, unknown>;
  if (typeof client_id !== "string" || client_id === "" || typeof client_secret !== "string" || client_secret === "") {
    throw new ConfigError(`${file} lacks client_id or client_secret; download the client file again (see ${GUIDE})`);
  }
  return { clientId: client_id, clientSecret: client_secret };
}
