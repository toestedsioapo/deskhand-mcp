import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import { ConfigError } from "../config/env.js";
import { SCOPE_CALENDAR_WRITE, requestedScopes } from "../config/scopes.js";
import type { ErrorCode } from "../ledger/contract.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow } from "../ledger/ids.js";
import { loadOAuthClient } from "../providers/google/client-file.js";
import { GOOGLE_ENDPOINTS, OAuthError, runLoopbackLogin, type OAuthDeps } from "../providers/google/oauth.js";
import { readToken, tokenPath, writeToken } from "../providers/google/token-store.js";
import { oneLine, type CliIo } from "./io.js";

export const AUTH_USAGE = "deskhand: usage: deskhand auth login | status | upgrade\n";

const SUBCOMMANDS = ["login", "status", "upgrade"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** Google's Testing-mode refresh tokens last about 7 days. */
const TESTING_TOKEN_DAYS = 7;
const DAY_MS = 86_400_000;

export function authArgsValid(args: readonly string[]): boolean {
  return args.length === 1 && (SUBCOMMANDS as readonly string[]).includes(args[0] ?? "");
}

interface Failure {
  code: ErrorCode;
  message: string;
}

/** Explicit mapping, never string matching: ConfigError is input, OAuthError carries its own code. */
function classify(e: unknown): Failure {
  if (e instanceof ConfigError) return { code: "INVALID_INPUT", message: oneLine(e.message, 500) };
  if (e instanceof OAuthError) return { code: e.code, message: oneLine(e.message, 500) };
  // Anything else (disk errors, bugs): a fixed sentence, never the raw message.
  return { code: "PROVIDER_ERROR", message: "Google sign-in failed unexpectedly." };
}

/** `deskhand auth login | status | upgrade`. Writes one `cli_command` row per run. */
export async function authCommand(
  ctx: AppContext,
  io: CliIo,
  args: readonly string[],
  deps?: Partial<OAuthDeps>,
): Promise<number> {
  const sub: Subcommand | undefined = authArgsValid(args) ? (args[0] as Subcommand) : undefined;
  let scopes: string[] | null = null;
  let note: string | null = null;
  let failure: Failure | null = null;
  let code = 0;
  try {
    if (sub === undefined) {
      failure = { code: "INVALID_INPUT", message: AUTH_USAGE.replace(/^deskhand: /, "").trim() };
      io.err(AUTH_USAGE);
      code = 2;
    } else if (sub === "status") {
      ({ code, scopes } = status(ctx, io));
      if (code !== 0) failure = { code: "AUTH_REQUIRED", message: "no token" };
    } else {
      scopes = await signIn(ctx, io, sub, deps);
    }
  } catch (e) {
    failure = classify(e);
    io.err(`deskhand: ${failure.message}\n`);
    code = 1;
  }
  if (failure !== null) note = failure.message;
  appendEvent(ctx.db, {
    ts: isoNow(ctx.clock),
    tool: "cli:auth",
    kind: "cli_command",
    outcome: failure ? "error" : "ok",
    errorCode: failure ? failure.code : null,
    preview: { v: 1, input: { subcommand: sub ?? null }, output: scopes ? { scopes } : null, note },
  });
  return code;
}

async function signIn(
  ctx: AppContext,
  io: CliIo,
  sub: "login" | "upgrade",
  deps: Partial<OAuthDeps> | undefined,
): Promise<string[]> {
  const { configDir } = ctx.config.paths;
  if (sub === "upgrade") {
    if (!ctx.config.writesEnabled) throw new ConfigError("auth upgrade needs DESKHAND_ALLOW_WRITES=1");
    if (readToken(configDir) === null) throw new OAuthError("no Google sign-in found; run deskhand auth login first");
  }
  const client = loadOAuthClient(configDir);
  const oauthDeps: OAuthDeps = {
    fetch: (input, init) => globalThis.fetch(input, init),
    endpoints: GOOGLE_ENDPOINTS,
    now: ctx.clock,
    ...deps,
  };
  const token = await runLoopbackLogin(client, requestedScopes(sub === "upgrade"), oauthDeps, (url) => {
    io.out(`Open this link in your browser to sign in:\n${url}\n`);
  });
  mkdirSync(configDir, { recursive: true });
  writeToken(configDir, token);
  const scopes = token.scopes.map((s) => oneLine(s, 200));
  io.out(`Granted scopes:\n${scopes.map((s) => `  ${s}\n`).join("")}`);
  io.out("Sign-in saved. In Testing mode Google expires it after about 7 days.\n");
  return scopes;
}

/** No network: reads the two files only. Exit 0 when a token exists, else 1. */
function status(ctx: AppContext, io: CliIo): { code: number; scopes: string[] | null } {
  const { configDir } = ctx.config.paths;
  const hasClient = existsSync(join(configDir, "client_secret.json"));
  io.out(`client_secret.json: ${hasClient ? "found" : "missing"}\n`);
  const token = readToken(configDir);
  if (token === null) {
    io.out(`token.json: missing (${tokenPath(configDir)})\n`);
    io.out("Not signed in. Run: deskhand auth login\n");
    return { code: 1, scopes: null };
  }
  const scopes = token.scopes.map((s) => oneLine(s, 200));
  io.out("token.json: found\n");
  io.out(`Granted scopes:\n${scopes.map((s) => `  ${s}\n`).join("")}`);
  io.out(`Write access: ${token.scopes.includes(SCOPE_CALENDAR_WRITE) ? "yes" : "no (run: deskhand auth upgrade)"}\n`);
  io.out(`Signed in at: ${oneLine(token.obtained_at, 40)}\n`);
  const left = Date.parse(token.obtained_at) + TESTING_TOKEN_DAYS * DAY_MS - ctx.clock().getTime();
  io.out(
    left > 0 && Number.isFinite(left)
      ? `Testing-mode expiry: about ${Math.ceil(left / DAY_MS)} days left\n`
      : "Testing-mode expiry: probably expired; run: deskhand auth login\n",
  );
  return { code: 0, scopes };
}
