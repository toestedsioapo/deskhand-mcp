import type { CliIo } from "../util/sanitize.js";

// The sanitisers and the CliIo shape live in src/util/sanitize.ts (so
// src/approval need not import from src/cli/); re-exported for CLI callers.
export { oneLine, stripControl, type CliIo } from "../util/sanitize.js";

/**
 * The process's real streams. The TTY flags are read from the streams
 * themselves (never from an env var or flag), and readLine refuses to read
 * unless both stdin and stdout are TTYs, so piped input is never consumed.
 */
export function realCliIo(): CliIo {
  const stdinIsTTY = process.stdin.isTTY === true;
  const stdoutIsTTY = process.stdout.isTTY === true;
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    stdinIsTTY,
    stdoutIsTTY,
    async readLine(prompt) {
      if (!stdinIsTTY || !stdoutIsTTY) throw new Error("refusing to read: stdin and stdout must both be a TTY");
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        // EOF (stdin closed) rejects instead of leaving the question pending forever.
        return await new Promise<string>((resolve, reject) => {
          rl.once("close", () => reject(new Error("input closed before a line was read")));
          rl.question(prompt).then(resolve, reject);
        });
      } finally {
        rl.close();
      }
    },
  };
}
