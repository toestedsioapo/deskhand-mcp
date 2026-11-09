#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { userInfo } from "node:os";
import type { AppContext } from "./app-context.js";
import { loadConfig } from "./config/env.js";
import { assertSupportedNode } from "./config/node-check.js";
import { ensureDirs } from "./config/paths.js";
import { PACKAGE_VERSION } from "./config/version.js";
import { LedgerDb } from "./ledger/db.js";
import { createIdGenerator, type Clock } from "./ledger/ids.js";
import { LoggingTransport } from "./ledger/logging-transport.js";
import {
  ACTION_APPLY_DESCRIPTION,
  actionApplyHandler,
  actionApplyInputSchema,
  actionApplyOutputSchema,
} from "./tools/action-apply.js";
import {
  ACTION_EXPLAIN_DESCRIPTION,
  actionExplainHandler,
  actionExplainInputSchema,
  actionExplainOutputSchema,
} from "./tools/action-explain.js";
import {
  LEDGER_QUERY_DESCRIPTION,
  ledgerQueryHandler,
  ledgerQueryInputSchema,
  ledgerQueryOutputSchema,
} from "./tools/ledger-query.js";
import {
  PING_DESCRIPTION,
  pingHandler,
  pingInputSchema,
  pingOutputSchema,
} from "./tools/ping.js";
import { createFixtureProvider, loadFixtureWorld } from "./providers/fixture/index.js";
import { toolOk } from "./tools/result.js";

/** Kept as an alias so existing call sites and tests keep compiling. */
export type ServerDeps = AppContext;

/**
 * Registers the tools. Ledger logging of every `tools/call` is done by the
 * LoggingTransport the server is connected through (see main()).
 */
export function createServer(deps: ServerDeps): McpServer {
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

  server.registerTool(
    "ledger_query",
    {
      description: LEDGER_QUERY_DESCRIPTION,
      inputSchema: ledgerQueryInputSchema,
      outputSchema: ledgerQueryOutputSchema,
      annotations: { readOnlyHint: true },
    },
    (input) => toolOk(ledgerQueryHandler(deps.db, input)),
  );

  server.registerTool(
    "action_explain",
    {
      description: ACTION_EXPLAIN_DESCRIPTION,
      inputSchema: actionExplainInputSchema,
      outputSchema: actionExplainOutputSchema,
      annotations: { readOnlyHint: true },
    },
    (input) => actionExplainHandler(deps.db, input),
  );

  // The only MCP tool that can cause a provider write (through the apply engine).
  server.registerTool(
    "action_apply",
    {
      description: ACTION_APPLY_DESCRIPTION,
      inputSchema: actionApplyInputSchema,
      outputSchema: actionApplyOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (input) => actionApplyHandler(deps, input),
  );

  return server;
}

export async function main(): Promise<void> {
  assertSupportedNode(process.versions.node);
  // Fail closed: bad config or an unopenable ledger stops startup (the catch
  // below prints one line and exits 1); no tool ever runs without a ledger.
  const config = loadConfig(process.env);
  ensureDirs(config.paths);
  // A bad fixture file is a startup config error too (loadFixtureWorld throws ConfigError).
  const world = loadFixtureWorld(config.fixturePath);
  const db = LedgerDb.open(config.paths.ledgerPath, { busyTimeoutMs: config.busyTimeoutMs });
  // With a fixture loaded, time is the fixture's fixed `now`; otherwise real time.
  const clock: Clock = config.fixturePath ? () => new Date(world.now) : () => new Date();
  const provider = createFixtureProvider(world);
  const ids = createIdGenerator();
  const server = createServer({ config, db, clock, ids, provider, actor: userInfo().username });
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
