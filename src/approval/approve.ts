import type { AppContext } from "../app-context.js";
import { DEFAULT_COLUMNS, oneLine, writeRows, type CliIo } from "../util/sanitize.js";
import { getAction } from "../ledger/actions.js";
import { canonicalJson, hashPrefix, planHash } from "../ledger/canonical.js";
import type { ActionStatus, ErrorCode, RejectionMethod } from "../ledger/contract.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow, last4 } from "../ledger/ids.js";
import { getPlanKind, renderDiff } from "./plan-kinds.js";
import { untrustedRuntimeFlag } from "./runtime-guard.js";

/**
 * Out-of-band approval lifecycle (CLI only, never an MCP tool). This file is
 * the only one allowed to move a plan out of `planned`, and the only one that
 * sets status `approved` or writes the approval columns (a structural test
 * enforces it).
 */

// ---------------------------------------------------------------- approve

export type ApproveResult = { ok: true } | { ok: false; errorCode: ErrorCode; message: string };

const APPROVE_TOOL = "cli:approve";
/** Longest form of a caller-supplied id that is echoed or stored (real ids are 30 characters). */
const ID_DISPLAY_MAX = 64;

interface StoredPlan {
  id: string;
  tool: string;
  plan_json: string;
  plan_hash: string;
  expires_at: string;
  status: ActionStatus;
}

function loadPlan(ctx: AppContext, id: string): StoredPlan | undefined {
  return ctx.db.get<StoredPlan>("SELECT id, tool, plan_json, plan_hash, expires_at, status FROM actions WHERE id = ?", [
    id,
  ]);
}

/** sha256 of the canonical stored plan, or undefined when plan_json does not parse. */
function recomputeHash(planJson: string): string | undefined {
  try {
    return planHash(JSON.parse(planJson) as unknown);
  } catch {
    return undefined;
  }
}

type Refusal = { code: ErrorCode; message: string };

/**
 * Check 5b: the stored plan (hash already verified) has a known kind and
 * passes that kind's schema. Unreachable through the plan tools, which
 * validate; refusing here (INTERNAL, as apply does) means a human is never
 * asked to approve something the diff cannot render faithfully.
 */
function storedPlanValid(planJson: string): boolean {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson) as unknown;
  } catch {
    return false;
  }
  const k = typeof plan === "object" && plan !== null ? (plan as { kind?: unknown }).kind : undefined;
  const pk = typeof k === "string" ? getPlanKind(k) : undefined;
  // plan_json must be exactly the canonical form that was hashed: duplicate keys or other spellings would let the
  // ledger's readers (SQLite json_extract) see a different plan from the one shown and applied.
  return pk !== undefined && pk.schema.safeParse(plan).success && canonicalJson(plan) === planJson;
}

/** INTERNAL is outcome `error`; every approve-specific refusal code is `rejected` (ledger-contract.md). */
const refusalOutcome = (r: Refusal): "rejected" | "error" => (r.code === "INTERNAL" ? "error" : "rejected");

/** ASCII-only uppercase: a-z become A-Z and nothing else changes, so no non-ASCII input can fold into a match. */
const asciiUpper = (s: string): string => s.replace(/[a-z]/g, (c) => c.toUpperCase());

/**
 * Steps 3-5 of the contract's approve order (status, expiry, hash) for a row
 * that exists. Used before the prompt and again when the CAS changes no row.
 * Expiry fails closed: now >= expires_at, or an unparseable value, is expired.
 */
function stateRefusal(row: StoredPlan, nowMs: number, shown: string): Refusal | undefined {
  if (row.status === "approved") return { code: "ALREADY_APPROVED", message: `Action ${shown} is already approved.` };
  if (row.status !== "planned") return { code: "NOT_PENDING", message: `Action ${shown} is ${row.status}, not pending.` };
  if (!(nowMs < Date.parse(row.expires_at))) {
    return { code: "PLAN_EXPIRED", message: `Action ${shown} expired at ${oneLine(row.expires_at, 40)}.` };
  }
  if (recomputeHash(row.plan_json) !== row.plan_hash) {
    return { code: "PLAN_MODIFIED", message: `The stored plan for ${shown} no longer matches its hash; it was not approved.` };
  }
  return undefined;
}

function approvePreview(shown: string, existingId: string | null, note: string | null): unknown {
  const p: Record<string, unknown> = { v: 1, input: { action_id: shown }, output: null, note };
  if (existingId !== null) p["action_id"] = existingId;
  return p;
}

/**
 * The single `cli_command` row of an approve invocation, written as its own
 * statement after the lifecycle row (ledger-contract.md, "Row sequences").
 */
function logApproveCommand(ctx: AppContext, shown: string, existingId: string | null, refusal: Refusal | null): void {
  appendEvent(ctx.db, {
    ts: isoNow(ctx.clock),
    actionId: existingId,
    tool: APPROVE_TOOL,
    kind: "cli_command",
    outcome: refusal ? refusalOutcome(refusal) : "ok",
    errorCode: refusal?.code ?? null,
    preview: approvePreview(shown, existingId, refusal?.message ?? null),
  });
}

/** A refusal: `approve_refused` in its own transaction, then `cli_command`. `actions` untouched. */
function refuseApprove(ctx: AppContext, shown: string, existingId: string | null, refusal: Refusal): ApproveResult {
  ctx.db.transaction(() => {
    appendEvent(ctx.db, {
      ts: isoNow(ctx.clock),
      actionId: existingId,
      tool: APPROVE_TOOL,
      kind: "approve_refused",
      outcome: refusalOutcome(refusal),
      errorCode: refusal.code,
      preview: approvePreview(shown, existingId, refusal.message),
    });
  }, "immediate");
  logApproveCommand(ctx, shown, existingId, refusal);
  return { ok: false, errorCode: refusal.code, message: refusal.message };
}

/**
 * `deskhand approve <id>`: the human-approval gate. Check order is fixed by
 * docs/ledger-contract.md ("Approve and reject refusals"): TTY on stdin AND
 * stdout (before anything is printed or read), exists, status, expiry, hash,
 * stored plan valid (5b, INTERNAL), last-4 collision, typed confirmation. Then `planned -> approved` by CAS in
 * BEGIN IMMEDIATE, re-checking status, plan bytes, plan_hash and expiry in
 * the WHERE clause; the `approved` row is in the same transaction. Every
 * refusal writes `approve_refused` + `cli_command` and leaves the row as is.
 * The typed confirmation is never stored or echoed.
 */
export async function approveAction(ctx: AppContext, actionId: string, io: CliIo): Promise<ApproveResult> {
  const shown = oneLine(actionId, ID_DISPLAY_MAX);
  const initial = loadPlan(ctx, actionId);
  const existingId = initial ? initial.id : null;

  // 1. TTY on both streams, before anything is printed or read.
  if (!(io.stdinIsTTY && io.stdoutIsTTY)) {
    return refuseApprove(ctx, shown, existingId, {
      code: "NOT_A_TTY",
      message: "approve needs an interactive terminal on both stdin and stdout; run it yourself, not from a pipe or a script.",
    });
  }
  // 1b. No preload, loader or inspector in this process (the trivial fake-TTY one-liner).
  const flag = untrustedRuntimeFlag(io.execArgv ?? [], io.nodeOptions);
  if (flag !== null) {
    return refuseApprove(ctx, shown, existingId, {
      code: "UNTRUSTED_RUNTIME",
      message: `approve refuses to run with ${flag} (execArgv or NODE_OPTIONS): run it in a plain terminal. This is a speed bump, not a boundary; see docs/SECURITY.md.`,
    });
  }
  // 2. Exists.
  if (!initial) return refuseApprove(ctx, shown, null, { code: "UNKNOWN_ACTION", message: `No action with id ${shown}.` });
  // 3-5. Status, expiry, hash.
  const state = stateRefusal(initial, ctx.clock().getTime(), shown);
  if (state) return refuseApprove(ctx, shown, initial.id, state);
  // 5b. Fail closed on a stored plan we cannot render faithfully (unknown kind or invalid shape).
  if (!storedPlanValid(initial.plan_json)) {
    return refuseApprove(ctx, shown, initial.id, {
      code: "INTERNAL",
      message: `The stored plan for ${shown} has an unknown kind or is invalid; it was not approved.`,
    });
  }
  // 6. Defensive: another pending (planned or approved) id with the same last 4.
  const confirm = last4(initial.id);
  const twins = ctx.db
    .all<{ id: string }>("SELECT id FROM actions WHERE status IN ('planned','approved') AND id <> ?", [initial.id])
    .filter((r) => last4(r.id) === confirm);
  if (twins.length > 0) {
    return refuseApprove(ctx, shown, initial.id, {
      code: "ID_COLLISION",
      message: `Another pending action shares the last 4 characters of ${shown}; reject one of them (or let it expire) and re-plan.`,
    });
  }

  // 7. Show exactly what is being approved (sanitised), then read the typed last 4.
  const hash = recomputeHash(initial.plan_json)!; // equals plan_hash: checked in step 5
  // The width the plan is laid out for is watched until the answer: if the terminal gets narrower meanwhile, it has
  // re-wrapped the rows without the continuation marker, so the approval is refused.
  const shownWidth = io.columns ?? DEFAULT_COLUMNS;
  const watch = io.watchWidth?.();
  writeRows(io, "", `Approve ${oneLine(initial.id, 64)} (${oneLine(initial.tool, 80)})`);
  // The CLI wraps long values itself (continuation marker), so terminal wrapping cannot forge a line.
  for (const line of renderDiff(JSON.parse(initial.plan_json) as unknown, ctx.config.timeZone)) writeRows(io, "    ", line);
  writeRows(io, "", `plan hash ${hashPrefix(hash)}`);
  writeRows(io, "", `expires   ${oneLine(initial.expires_at, 40)}`);
  let typed: string;
  let narrowest: number | undefined;
  try {
    typed = await io.readLine("Type the last 4 characters of the action id to approve: ");
  } catch {
    typed = "";
  } finally {
    narrowest = watch?.narrowest();
    watch?.stop();
  }
  if (narrowest !== undefined && narrowest < shownWidth) {
    return refuseApprove(ctx, shown, initial.id, {
      code: "CONFIRMATION_MISMATCH",
      message: `The terminal got narrower (${shownWidth} to ${narrowest} columns) while the plan for ${shown} was shown, so it may have been re-wrapped; nothing was approved. Run deskhand approve again.`,
    });
  }
  if (asciiUpper(typed.trim()) !== confirm) {
    return refuseApprove(ctx, shown, initial.id, {
      code: "CONFIRMATION_MISMATCH",
      message: `The typed confirmation did not match the last 4 characters of ${shown}; nothing was approved.`,
    });
  }

  // 8. CAS planned -> approved on exactly the plan bytes and hash that were shown,
  // unexpired. The row is re-read inside the transaction first (the human may
  // have taken minutes), so a change gives the matching code; the WHERE clause
  // re-checks the same conditions as the last word.
  const decision = ctx.db.transaction((): Refusal | null => {
    const ts = isoNow(ctx.clock);
    const cur = loadPlan(ctx, initial.id);
    if (!cur) return { code: "NOT_PENDING", message: `Action ${shown} is no longer pending.` };
    const changed = stateRefusal(cur, ctx.clock().getTime(), shown);
    if (changed) return changed;
    if (cur.plan_json !== initial.plan_json || cur.plan_hash !== hash) {
      return { code: "PLAN_MODIFIED", message: `The plan for ${shown} changed while waiting for confirmation; it was not approved.` };
    }
    const r = ctx.db.run(
      `UPDATE actions SET status = 'approved', approved_by = ?, approved_at = ?, approval_method = 'cli_tty',
         approved_plan_hash = ?
       WHERE id = ? AND status = 'planned' AND plan_json = ? AND plan_hash = ? AND expires_at > ?`,
      [ctx.actor, ts, hash, initial.id, initial.plan_json, hash, ts],
    );
    if (r.changes !== 1) return { code: "NOT_PENDING", message: `Action ${shown} is no longer pending.` };
    appendEvent(ctx.db, {
      ts,
      actionId: initial.id,
      tool: APPROVE_TOOL,
      kind: "approved",
      outcome: "ok",
      preview: approvePreview(shown, initial.id, null),
    });
    return null;
  }, "immediate");
  if (decision) return refuseApprove(ctx, shown, initial.id, decision);
  logApproveCommand(ctx, shown, initial.id, null);
  return { ok: true };
}

// ---------------------------------------------------------------- reject

export type RejectResult = { ok: true } | { ok: false; errorCode: ErrorCode; message: string };

const TOOL = "cli:reject";

function cliPreview(shown: string, reason: string | undefined, note: string | null, existing: string | null): unknown {
  const p: Record<string, unknown> = {
    v: 1,
    input: reason === undefined ? { action_id: shown } : { action_id: shown, reason },
    output: null,
    note,
  };
  if (existing) p["action_id"] = existing;
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
  const shown = oneLine(actionId, ID_DISPLAY_MAX);
  const decision = ctx.db.transaction((): Decision => {
    const row = getAction(ctx.db, actionId);
    if (!row) return { ok: false, existing: false, code: "UNKNOWN_ACTION", message: `No action with id ${shown}.` };
    if (row.status === "approved") {
      return {
        ok: false,
        existing: true,
        code: "ALREADY_APPROVED",
        message: `Action ${shown} is already approved; let it expire to withdraw it.`,
      };
    }
    if (row.status !== "planned") {
      return { ok: false, existing: true, code: "NOT_PENDING", message: `Action ${shown} is ${row.status}, not pending.` };
    }
    const ts = isoNow(ctx.clock);
    const r = ctx.db.run(
      `UPDATE actions SET status = 'rejected', rejected_at = ?, rejected_reason = ?, rejection_method = ?
       WHERE id = ? AND status = 'planned'`,
      [ts, reason ?? null, method, actionId],
    );
    if (r.changes !== 1) {
      return { ok: false, existing: true, code: "NOT_PENDING", message: `Action ${shown} is no longer pending.` };
    }
    appendEvent(ctx.db, {
      ts,
      actionId,
      tool: TOOL,
      kind: "rejected",
      outcome: "ok",
      preview: cliPreview(shown, reason, null, actionId),
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
    preview: cliPreview(shown, reason, decision.ok ? null : decision.message, existing ? actionId : null),
  });
  return decision.ok ? { ok: true } : { ok: false, errorCode: decision.code, message: decision.message };
}
