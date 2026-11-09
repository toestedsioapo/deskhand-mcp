import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeTempHome } from "./home.js";

export const BIN_PATH = fileURLToPath(
  new URL("../../dist/server.js", import.meta.url),
);

/**
 * Environment for a spawned bin. With no `env`, a fresh temp DESKHAND_HOME is
 * created (and removed by `cleanup`) so a test never touches the real data dir.
 */
function resolveEnv(env: NodeJS.ProcessEnv | undefined): {
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  if (env) return { env, cleanup: () => {} };
  const home = makeTempHome();
  return { env: home.env, cleanup: home.cleanup };
}

/** Spawns the built server and connects an SDK client; collects stderr. */
export async function spawnBin(env?: NodeJS.ProcessEnv): Promise<{
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}> {
  const resolved = resolveEnv(env);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN_PATH],
    env: resolved.env as Record<string, string>,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "deskhand-test", version: "0.0.0" });
  try {
    await client.connect(transport);
  } catch (err) {
    resolved.cleanup();
    throw err;
  }
  return {
    client,
    stderr: () => stderr,
    close: async () => {
      try {
        await client.close();
      } finally {
        resolved.cleanup();
      }
    },
  };
}

/** Raw child process for tests that need direct control of stdin/stdout. */
export function spawnRaw(env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const resolved = resolveEnv(env);
  const child = spawn(process.execPath, [BIN_PATH], { stdio: "pipe", env: resolved.env });
  child.once("close", () => resolved.cleanup());
  return child;
}

/** Runs the built server to completion with empty stdin (startup-failure tests). */
export function runServerBin(env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync(process.execPath, [BIN_PATH], { encoding: "utf8", env, input: "" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const CLI_PATH = fileURLToPath(
  new URL("../../dist/cli.js", import.meta.url),
);

/** Runs the built `deskhand` CLI to completion and captures its output. */
export function runCliBin(
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const resolved = resolveEnv(env);
  try {
    const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      env: resolved.env,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    resolved.cleanup();
  }
}
