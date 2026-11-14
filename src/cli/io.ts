import type { CliIo } from "../util/sanitize.js";

// The sanitisers and the CliIo shape live in src/util/sanitize.ts (so
// src/approval need not import from src/cli/); re-exported for CLI callers.
export { oneLine, stripControl, writeRows, type CliIo } from "../util/sanitize.js";

interface Stream {
  isTTY?: boolean;
  columns?: number;
}

/**
 * Width to lay rows out for: stdout's when it is a terminal, else stderr's when that is one (`deskhand pending |
 * more` is still read in that terminal), else unknown (80 is used).
 */
export function pickColumns(stdout: Stream, stderr: Stream): number | undefined {
  const tty = stdout.isTTY === true ? stdout : stderr.isTTY === true ? stderr : undefined;
  return tty && typeof tty.columns === "number" && tty.columns > 0 ? tty.columns : undefined;
}

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
    execArgv: process.execArgv,
    nodeOptions: process.env["NODE_OPTIONS"] ?? "",
    ...(() => {
      const columns = pickColumns(process.stdout, process.stderr);
      return columns === undefined ? {} : { columns };
    })(),
    watchWidth() {
      let narrowest = pickColumns(process.stdout, process.stderr);
      const seen = () => {
        const c = pickColumns(process.stdout, process.stderr);
        if (c !== undefined && (narrowest === undefined || c < narrowest)) narrowest = c;
      };
      process.stdout.on("resize", seen);
      return {
        narrowest: () => (seen(), narrowest),
        stop: () => void process.stdout.off("resize", seen),
      };
    },
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
