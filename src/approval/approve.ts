import type { AppContext } from "../app-context.js";
import { getAction } from "../ledger/actions.js";
import type { ErrorCode, RejectionMethod } from "../ledger/contract.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow } from "../ledger/ids.js";

/**
 * Out-of-band approval lifecycle (CLI only, never an MCP tool). Task 5 adds
 * approveAction here; this file is the only one allowed to move a plan out of
 * `planned`.
 */

export type RejectResult = { ok: true } | { ok: false; errorCode: ErrorCode; message: string };

const TOOL = "cli:reject";

function cliPreview(actionId: string, reason: string | undefined, note: string | null, existing: boolean): unknown {
  const p: Record<string, unknown> = {
    v: 1,
    input: reason === undefined ? { action_id: actionId } : { action_id: actionId, reason },
    output: null,
    note,
  };
  if (existing) p["action_id"] = actionId;
  return p;
}

type Decision = { ok: true } | { ok: false; existing: boolean; code: ErrorCode; message: string };

/**
 * `planned` -> `rejected` by compare-and-set inside BEGIN IMMEDIATE, with the
 * `rejected` lifecycle row in the same transaction. The `cli_command` row is a
 * separate statement written right after (ledger-contract.md, "Row sequences").
 * Refusals write only the `cli_command` row (outcome `rejected`). The caller
 * passes a reason already stripped of control characters.
 */
export function rejectAction(
  ctx: AppContext,
  actionId: string,
  reason: string | undefined,
  method: RejectionMethod,
): RejectResult {
  const decision = ctx.db.transaction((): Decision => {
    const row = getAction(ctx.db, actionId);
    if (!row) return { ok: false, existing: false, code: "UNKNOWN_ACTION", message: `No action with id ${actionId}.` };
    if (row.status === "approved") {
      return {
        ok: false,
        existing: true,
        code: "ALREADY_APPROVED",
        message: `Action ${actionId} is already approved; let it expire to withdraw it.`,
      };
    }
    if (row.status !== "planned") {
      return { ok: false, existing: true, code: "NOT_PENDING", message: `Action ${actionId} is ${row.status}, not pending.` };
    }
    const ts = isoNow(ctx.clock);
    const r = ctx.db.run(
      `UPDATE actions SET status = 'rejected', rejected_at = ?, rejected_reason = ?, rejection_method = ?
       WHERE id = ? AND status = 'planned'`,
      [ts, reason ?? null, method, actionId],
    );
    if (r.changes !== 1) {
      return { ok: false, existing: true, code: "NOT_PENDING", message: `Action ${actionId} is no longer pending.` };
    }
    appendEvent(ctx.db, {
      ts,
      actionId,
      tool: TOOL,
      kind: "rejected",
      outcome: "ok",
      preview: cliPreview(actionId, reason, null, true),
    });
    return { ok: true };
  }, "immediate");

  const existing = decision.ok || decision.existing;
  appendEvent(ctx.db, {
    ts: isoNow(ctx.clock),
    actionId: existing ? actionId : null,
    tool: TOOL,
    kind: "cli_command",
    outcome: decision.ok ? "ok" : "rejected",
    errorCode: decision.ok ? null : decision.code,
    preview: cliPreview(actionId, reason, decision.ok ? null : decision.message, existing),
  });
  return decision.ok ? { ok: true } : { ok: false, errorCode: decision.code, message: decision.message };
}
