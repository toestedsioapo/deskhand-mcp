#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertSupportedNode } from "./config/node-check.js";
import { PACKAGE_VERSION } from "./config/version.js";
import {
  PING_DESCRIPTION,
  pingHandler,
  pingInputSchema,
  pingOutputSchema,
} from "./tools/ping.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "deskhand-mcp",
    version: PACKAGE_VERSION,
  });

  // NOTE: `ping` writes no ledger row only because the ledger arrives in M2
  // (ROADMAP M1 gap). M2 must wrap every tool, `ping` included, in ledger
  // logging (CLAUDE.md: every tool call writes to the ledger).
  server.registerTool(
    "ping",
    {
      description: PING_DESCRIPTION,
      inputSchema: pingInputSchema,
      outputSchema: pingOutputSchema,
      annotations: { readOnlyHint: true },
    },
    () => {
      const result = pingHandler();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

export async function main(): Promise<void> {
  assertSupportedNode(process.versions.node);
  const server = createServer();
  const transport = new StdioServerTransport();
  // stdin closing means the client went away: exit cleanly.
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("close", () => process.exit(0));
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
    process.stderr.write(`deskhand-mcp: fatal: ${message}\n`);
    process.exit(1);
  });
}
