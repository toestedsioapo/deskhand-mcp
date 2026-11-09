import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const BIN_PATH = fileURLToPath(
  new URL("../../dist/server.js", import.meta.url),
);

/** Spawns the built server and connects an SDK client; collects stderr. */
export async function spawnBin(): Promise<{
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN_PATH],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "deskhand-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr, close: () => client.close() };
}

/** Raw child process for tests that need direct control of stdin/stdout. */
export function spawnRaw(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN_PATH], { stdio: "pipe" });
}
