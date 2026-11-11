import { Writable } from "node:stream";

export interface StdinShutdownOptions {
  stdin: NodeJS.EventEmitter;
  /** Resolves when no tool call is in flight: handlers finished AND responses flushed. */
  transport: { whenIdle(): Promise<void> };
  closeDb: () => void;
  exit: (code: number) => void;
  /** Upper bound on the drain; default 30 000 ms. The server passes `Config.shutdownTimeoutMs`. */
  timeoutMs?: number;
  /** One line per failure; defaults to process.stderr. */
  log?: (s: string) => void;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

const oneLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();

/**
 * Stdin closing means the client went away. On the first `end` or `close`:
 * wait for the transport to be idle (bounded by `timeoutMs`), close the
 * ledger, exit 0. A timeout or a failed drain logs one line and exits 1
 * without closing the ledger under a still-running handler; a throw from
 * `closeDb` logs one line and exits 1. Later events are ignored.
 */
export function installStdinShutdown(opts: StdinShutdownOptions): void {
  const log = opts.log ?? ((s: string) => void process.stderr.write(s));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let started = false;
  let finished = false;
  const finish = (code: number, line?: string): void => {
    if (finished) return;
    finished = true;
    if (line !== undefined) log(`deskhand-mcp: ${line}\n`);
    opts.exit(code);
  };

  const onEnd = (): void => {
    if (started) return;
    started = true;
    const timer = setTimeout(
      () => finish(1, `shutdown timed out after ${timeoutMs} ms waiting for in-flight tool calls`),
      timeoutMs,
    );
    opts.transport.whenIdle().then(
      () => {
        clearTimeout(timer);
        if (finished) return;
        try {
          opts.closeDb();
        } catch (e) {
          finish(1, `ledger close failed: ${oneLine(e)}`);
          return;
        }
        finish(0);
      },
      (e: unknown) => {
        clearTimeout(timer);
        finish(1, `shutdown drain failed: ${oneLine(e)}`);
      },
    );
  };
  opts.stdin.once("end", onEnd);
  opts.stdin.once("close", onEnd);
}

/** Write errors that mean the client closed its end of our stdout. */
const CLIENT_GONE: ReadonlySet<string> = new Set([
  "EPIPE",
  "EOF",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);

export interface ClientStdoutTarget extends NodeJS.EventEmitter {
  write(chunk: Uint8Array | string, cb: (err?: Error | null) => void): boolean;
}

export interface ClientStdout {
  /** What the stdio transport writes to. It never errors and never stalls once the client is gone. */
  stream: Writable;
  /** True after a stdout error that is not "client gone". */
  failed(): boolean;
  /**
   * Exits once every earlier write has been handed to stdout (or dropped
   * because the client is gone). Exit code 0 becomes 1 if stdout failed. Falls
   * back to exiting after `fallbackMs` if stdout never drains (client alive
   * but not reading); the fallback keeps the requested code.
   */
  flushThenExit(code: number): void;
}

/**
 * Guards the server's stdout. A client that exits usually closes both pipes,
 * so the drain's last response can hit a dead pipe (EPIPE). That is treated
 * as "client gone": the write counts as done, later writes are dropped, and
 * nothing is logged, so the drain still closes the ledger and exits 0. Any
 * other stdout error is logged once and turns exit 0 into exit 1.
 */
export function createClientStdout(
  stdout: ClientStdoutTarget,
  opts: { log?: (s: string) => void; exit?: (code: number) => void; fallbackMs?: number } = {},
): ClientStdout {
  const log = opts.log ?? ((s: string) => void process.stderr.write(s));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let gone = false;
  let failed = false;
  const onError = (err: unknown): void => {
    if (gone || failed) return;
    if (CLIENT_GONE.has(String(codeOf(err)))) {
      gone = true;
      return;
    }
    failed = true;
    log(`deskhand-mcp: stdout write failed: ${oneLine(err)}\n`);
  };
  // Without a listener, a failed write is an unhandled 'error' event (crash with a stack trace).
  stdout.on("error", onError);

  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (gone) return cb();
      try {
        stdout.write(chunk, (err) => {
          if (err) onError(err);
          cb();
        });
      } catch (err) {
        onError(err);
        cb();
      }
    },
  });

  let exiting = false;
  return {
    stream,
    failed: () => failed,
    flushThenExit(code) {
      if (exiting) return;
      exiting = true;
      const timer = setTimeout(() => exit(code), opts.fallbackMs ?? 2_000);
      stream.end(() => {
        clearTimeout(timer);
        exit(code === 0 && failed ? 1 : code);
      });
    },
  };
}
