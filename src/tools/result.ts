import type { ErrorCode } from "../ledger/contract.js";

/**
 * Tool result convention (docs/tools-contract.md, "Result convention").
 *
 * Errors carry NO structuredContent: the SDK 1.32.2 client validates
 * structuredContent against a tool's output schema even on isError results,
 * so the machine-readable error lives in `_meta.deskhand` instead. The ledger
 * transport reads error_code and action_id only from there.
 */

export interface DeskhandMeta {
  [key: string]: unknown;
  error_code?: ErrorCode;
  action_id?: string;
}

export interface ToolOkResult<T extends object> {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: T;
  _meta?: { [key: string]: unknown; deskhand: DeskhandMeta };
}

export interface ToolErrorResult {
  [key: string]: unknown;
  isError: true;
  content: { type: "text"; text: string }[];
  _meta: { [key: string]: unknown; deskhand: DeskhandMeta & { error_code: ErrorCode } };
}

/**
 * Success: the output object as structuredContent and as one JSON text block.
 * `extra.action_id` names the action the result concerns (logged on the
 * tool_call row when it exists).
 */
export function toolOk<T extends object>(structured: T, extra?: { action_id?: string }): ToolOkResult<T> {
  const result: ToolOkResult<T> = {
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
  if (extra?.action_id !== undefined) result._meta = { deskhand: { action_id: extra.action_id } };
  return result;
}

/** Failure: `isError`, text `<CODE>: <message>`, `_meta.deskhand = { error_code, action_id? }`. */
export function toolError(
  code: ErrorCode,
  message: string,
  extra?: { action_id?: string },
): ToolErrorResult {
  const deskhand: DeskhandMeta & { error_code: ErrorCode } = { error_code: code };
  if (extra?.action_id !== undefined) deskhand.action_id = extra.action_id;
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
    _meta: { deskhand },
  };
}
