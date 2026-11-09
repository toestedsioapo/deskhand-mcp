#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config/env.js";
import { assertSupportedNode } from "./config/node-check.js";
import { ensureDirs } from "./config/paths.js";
import { PACKAGE_VERSION } from "./config/version.js";
import { LedgerDb } from "./ledger/db.js";
import type { Clock } from "./ledger/ids.js";
import { LoggingTransport } from "./ledger/logging-transport.js";
import {
  PING_DESCRIPTION,
  pingHandler,
  pingInputSchema,
  pingOutputSchema,
} from "./tools/ping.js";
import { toolOk } from "./tools/result.js";

export interface ServerDeps {
  config: Config;
  db: LedgerDb;
  clock: Clock;
}

/**
 * Registers the tools. Ledger logging of every `tools/call` is done by the
 * LoggingTransport the server is connected through (see main()).
 */
export function createServer(_deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: "deskhand-mcp",
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    "ping",
    {
      description: PING_DESCRIPTION,
      inputSchema: pingInputSchema,
      outputSchema: pingOutputSchema,
      annotations: { readOnlyHint: true },
    },
    () => toolOk(pingHandler()),
  );

  return server;
}

export async function main(): Promise<void> {
  assertSupportedNode(process.versions.node);
  // Fail closed: bad config or an unopenable ledger stops startup (the catch
  // below prints one line and exits 1); no tool ever runs without a ledger.
  const config = loadConfig(process.env);
  ensureDirs(config.paths);
  const db = LedgerDb.open(config.paths.ledgerPath, { busyTimeoutMs: config.busyTimeoutMs });
  const clock: Clock = () => new Date();
  const server = createServer({ config, db, clock });
  const transport = new LoggingTransport(new StdioServerTransport(), { db, clock });
  // stdin closing means the client went away: exit cleanly (M2b adds a drain).
  const exit = (): void => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.stdin.once("end", exit);
  process.stdin.once("close", exit);
  await server.connect(transport);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`deskhand-mcp: ${message.replace(/\s+/g, " ").trim()}\n`);
    process.exit(1);
  });
}
