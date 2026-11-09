import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CancelledNotificationSchema,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { toolError } from "../tools/result.js";
import { actionExists } from "./actions.js";
import { ERROR_CODES, type ErrorCode, type EventOutcome } from "./contract.js";
import type { LedgerDb } from "./db.js";
import { appendEvent } from "./events.js";
import { isoNow, type Clock } from "./ids.js";

export interface LoggingTransportDeps {
  db: LedgerDb;
  clock: Clock;
  /** Where a failed ledger write is reported (one line). Defaults to process.stderr. */
  stderr?: (line: string) => void;
}

interface PendingCall {
  tool: string;
  input: unknown;
}

/** `tools/call` outcome mapping (docs/ledger-contract.md, "Row sequences"). */
const GATE_REFUSALS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "WRITES_DISABLED",
  "UNKNOWN_ACTION",
  "PLAN_EXPIRED",
  "NOT_APPROVED",
]);

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(ERROR_CODES);

// Texts of the isError results that @modelcontextprotocol/sdk 1.32.2 builds
// itself (McpServer.createToolError) before or around a handler. Pinned by
// tests/logging-transport.test.ts.
const SDK_INVALID_INPUT = /^MCP error -32602: (Input validation error: )?Invalid arguments for tool /;
const SDK_UNKNOWN_TOOL = /^MCP error -32602: Tool (.*) not found$/;

const JSONRPC_INVALID_PARAMS = -32602;

/** events.tool is stored capped; the response path is unchanged. */
const MAX_TOOL_NAME = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstText(result: Record<string, unknown>): string | undefined {
  const content = result["content"];
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (isRecord(first) && first["type"] === "text" && typeof first["text"] === "string") {
    return first["text"];
  }
  return undefined;
}

function outcomeOf(code: ErrorCode): EventOutcome {
  return GATE_REFUSALS.has(code) ? "rejected" : "error";
}

/**
 * The strictly validated `_meta.deskhand` of a result (set by toolOk/toolError).
 * `present` is true when the key exists at all; `valid` only when error_code
 * (if any) is a known code and action_id (if any) is a string. This is the ONLY
 * source of error_code and action_id: structuredContent and text are never read
 * for them, so untrusted content cannot spoof a code or an action.
 */
function deskhandMeta(result: Record<string, unknown>): {
  present: boolean;
  valid: boolean;
  errorCode: ErrorCode | undefined;
  actionId: string | undefined;
} {
  const meta = result["_meta"];
  const d = isRecord(meta) ? meta["deskhand"] : undefined;
  if (d === undefined) return { present: false, valid: false, errorCode: undefined, actionId: undefined };
  if (!isRecord(d)) return { present: true, valid: false, errorCode: undefined, actionId: undefined };
  const code = d["error_code"];
  const action = d["action_id"];
  const codeOk = code === undefined || (typeof code === "string" && KNOWN_CODES.has(code));
  const actionOk = action === undefined || typeof action === "string";
  if (!codeOk || !actionOk) return { present: true, valid: false, errorCode: undefined, actionId: undefined };
  return {
    present: true,
    valid: true,
    errorCode: code as ErrorCode | undefined,
    actionId: action as string | undefined,
  };
}

/**
 * Maps one `tools/call` response to the event outcome and error code.
 * `error` is a JSON-RPC error object, `result` a JSON-RPC result; exactly one is set.
 */
export function classifyResponse(
  tool: string,
  error: { code: number; message: string } | undefined,
  result: Record<string, unknown> | undefined,
): { outcome: EventOutcome; errorCode: ErrorCode | null } {
  if (error) {
    const code: ErrorCode = error.code === JSONRPC_INVALID_PARAMS ? "INVALID_INPUT" : "INTERNAL";
    return { outcome: "error", errorCode: code };
  }
  if (!result || result["isError"] !== true) return { outcome: "ok", errorCode: null };

  const meta = deskhandMeta(result);
  if (meta.present) {
    // Our own error result: trust only a valid known code, never the text.
    const code: ErrorCode = meta.valid && meta.errorCode ? meta.errorCode : "INTERNAL";
    return { outcome: outcomeOf(code), errorCode: code };
  }
  // No _meta.deskhand: an SDK-built error ("MCP error -32602: ...") or a thrown
  // handler error. Only these exact SDK prefixes are recognised.
  const text = firstText(result) ?? "";
  if (SDK_UNKNOWN_TOOL.exec(text)?.[1] === tool) return { outcome: "error", errorCode: "UNKNOWN_TOOL" };
  if (SDK_INVALID_INPUT.test(text)) return { outcome: "error", errorCode: "INVALID_INPUT" };
  return { outcome: "error", errorCode: "INTERNAL" };
}

/**
 * Wraps the server transport and writes exactly one `tool_call` event per
 * `tools/call` request. The row is written synchronously when the response is
 * produced, before it is forwarded to the client, so lifecycle rows written by
 * the handler precede it. If the write fails the response is replaced by an
 * INTERNAL error result. Other traffic passes through untouched.
 */
export class LoggingTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

  private readonly pending = new Map<RequestId, PendingCall[]>();
  private pendingCount = 0;
  private flushing = 0;
  private idleWaiters: (() => void)[] = [];
  private readonly writeStderr: (line: string) => void;

  constructor(
    private readonly inner: Transport,
    private readonly deps: LoggingTransportDeps,
  ) {
    this.writeStderr = deps.stderr ?? ((line) => void process.stderr.write(line));
    inner.onmessage = (message, extra) => {
      this.observeInbound(message);
      this.onmessage?.(message, extra);
    };
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  /** `tools/call` requests awaiting their response (including its flush). */
  inFlight(): number {
    return this.pendingCount + this.flushing;
  }

  /** Resolves once inFlight() is 0. */
  whenIdle(): Promise<void> {
    if (this.inFlight() === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const isResponse = "result" in message || "error" in message;
    const id = isResponse && "id" in message ? message.id : undefined;
    const call = typeof id === "string" || typeof id === "number" ? this.take(id) : undefined;
    if (id === undefined || !call) return this.inner.send(message, options);

    this.flushing++;
    try {
      let out: JSONRPCMessage = message;
      const error = "error" in message ? message.error : undefined;
      const result = "result" in message ? (message.result as Record<string, unknown>) : undefined;
      try {
        try {
          this.log(call, error, result, false);
        } catch {
          // Building/writing the full row failed: retry once with a minimal row.
          this.log(call, error, result, true);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.writeStderr(`deskhand-mcp: ledger write failed: ${reason.replace(/\s+/g, " ")}\n`);
        out = {
          jsonrpc: "2.0",
          id,
          result: toolError("INTERNAL", "internal error: the audit ledger could not be written"),
        } as JSONRPCMessage;
      }
      await this.inner.send(out, options);
    } finally {
      this.flushing--;
      this.notifyIfIdle();
    }
  }

  private observeInbound(message: JSONRPCMessage): void {
    if (!("method" in message)) return;
    if ("id" in message && message.method === "tools/call") {
      const params = isRecord(message.params) ? message.params : {};
      const name = params["name"];
      const call: PendingCall = {
        tool: typeof name === "string" ? name : "",
        input: params["arguments"] ?? null,
      };
      const queue = this.pending.get(message.id) ?? [];
      queue.push(call);
      this.pending.set(message.id, queue);
      this.pendingCount++;
      return;
    }
    if (message.method === "notifications/cancelled") {
      // A cancelled request gets no response from the SDK; log it now so every
      // tools/call still has exactly one row. Mirror the SDK's own guards
      // (1.32.2: the notification must parse, and Protocol._oncancel ignores a
      // falsy requestId), otherwise the SDK ignores the cancel and the real
      // response must be the one that is logged.
      const parsed = CancelledNotificationSchema.safeParse(message);
      if (!parsed.success) return;
      const id = parsed.data.params.requestId;
      if (!id) return;
      const call = this.take(id);
      if (!call) return;
      try {
        this.writeRow(call, "error", "INTERNAL", null, null, "cancelled");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.writeStderr(`deskhand-mcp: ledger write failed: ${reason.replace(/\s+/g, " ")}\n`);
      }
      this.notifyIfIdle();
    }
  }

  private take(id: RequestId): PendingCall | undefined {
    const queue = this.pending.get(id);
    const call = queue?.shift();
    if (!call) return undefined;
    if (queue?.length === 0) this.pending.delete(id);
    this.pendingCount--;
    return call;
  }

  private log(
    call: PendingCall,
    error: { code: number; message: string } | undefined,
    result: Record<string, unknown> | undefined,
    minimal: boolean,
  ): void {
    const { outcome, errorCode } = classifyResponse(call.tool, error, result);
    // action_id comes only from a valid _meta.deskhand, and must name an existing action (FK).
    const meta = result ? deskhandMeta(result) : undefined;
    const named = meta?.valid ? meta.actionId : undefined;
    const actionId = named !== undefined && actionExists(this.deps.db, named) ? named : null;
    if (minimal) {
      this.writeRow({ tool: call.tool, input: "[omitted]" }, outcome, errorCode, "[omitted]", actionId, "preview failed");
      return;
    }
    // Error rows store no output; ok rows store the structured result.
    const structured = outcome === "ok" ? result?.["structuredContent"] : undefined;
    const output = isRecord(structured) ? structured : null;
    // Error rows keep the message in preview.note (redacted by appendEvent).
    let note: string | null = null;
    if (outcome !== "ok") {
      note = error ? String(error.message) : result ? (firstText(result) ?? null) : null;
    }
    this.writeRow(call, outcome, errorCode, output, actionId, note);
  }

  private writeRow(
    call: PendingCall,
    outcome: EventOutcome,
    errorCode: ErrorCode | null,
    output: unknown,
    actionId: string | null,
    note: string | null,
  ): void {
    appendEvent(this.deps.db, {
      ts: isoNow(this.deps.clock),
      actionId,
      tool: call.tool.slice(0, MAX_TOOL_NAME),
      kind: "tool_call",
      outcome,
      errorCode,
      preview: { v: 1, input: call.input, output, note },
    });
  }

  private notifyIfIdle(): void {
    if (this.inFlight() !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
