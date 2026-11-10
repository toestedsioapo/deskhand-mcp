import { createHash } from "node:crypto";
import type { AppContext } from "../app-context.js";
import { canonicalJson, planHash } from "../ledger/canonical.js";
import type { ActionStatus, ErrorCode, EventOutcome } from "../ledger/contract.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow } from "../ledger/ids.js";
import { redactInput } from "../ledger/redact.js";
import type { EventRef } from "../providers/types.js";
import { getPlanKind, type PlanKind } from "./plan-kinds.js";

/**
 * The apply engine: the ONLY place a plan kind's write is executed (a
 * structural test enforces it). Gate order is fixed by docs/ledger-contract.md
 * ("Apply gate order"): writes flag, exists, applied-replay, approved, hash,
 * recovery, expiry, re-check, write.
 */

export type ApplyResult =
  | { ok: true; replayed: boolean; result: EventRef }
  | { ok: false; errorCode: ErrorCode; message: string };

const TOOL = "action_apply";

/** Lowercase hex SHA-256 of the action id (ledger contract, "Idempotency key"). */
export function idempotencyKey(actionId: string): string {
  return createHash("sha256").update(actionId, "utf8").digest("hex");
}

interface RawAction {
  id: string;
  plan_json: string;
  plan_hash: string;
  approved_plan_hash: string | null;
  expires_at: string;
  status: ActionStatus;
  result_json: string | null;
}

function load(ctx: AppContext, id: string): RawAction | undefined {
  return ctx.db.get<RawAction>(
    "SELECT id, plan_json, plan_hash, approved_plan_hash, expires_at, status, result_json FROM actions WHERE id = ?",
    [id],
  );
}

const GATE_REFUSALS: readonly ErrorCode[] = ["WRITES_DISABLED", "UNKNOWN_ACTION", "PLAN_EXPIRED", "NOT_APPROVED"];
const outcomeFor = (code: ErrorCode): EventOutcome => (GATE_REFUSALS.includes(code) ? "rejected" : "error");

/** Provider error text, through the ledger redactor (long strings are cut and hashed). */
const errText = (e: unknown): string => String(redactInput(e instanceof Error ? e.message : String(e)));

function preview(actionId: string, existing: boolean, note: string | null): unknown {
  const p: Record<string, unknown> = { v: 1, input: { action_id: actionId }, output: null, note };
  if (existing) p["action_id"] = actionId;
  return p;
}

/** Refusal: an apply_refused row in its own transaction; `actions` untouched. */
function refuse(ctx: AppContext, actionId: string, existing: boolean, code: ErrorCode, message: string): ApplyResult {
  ctx.db.transaction(() => {
    appendEvent(ctx.db, {
      ts: isoNow(ctx.clock),
      actionId: existing ? actionId : null,
      tool: TOOL,
      kind: "apply_refused",
      outcome: outcomeFor(code),
      errorCode: code,
      preview: preview(actionId, existing, message),
    });
  }, "immediate");
  return { ok: false, errorCode: code, message };
}

/** Replay of a stored result (status already `applied`). */
function replay(row: RawAction): ApplyResult {
  return { ok: true, replayed: true, result: JSON.parse(row.result_json ?? "null") as EventRef };
}

/**
 * Called when a CAS found the plan no longer `approved` (a concurrent apply won,
 * or something else moved it). Applied: return the stored result as a replay.
 * Otherwise: a NOT_APPROVED refusal.
 */
function afterLostCas(ctx: AppContext, actionId: string): ApplyResult {
  const now = load(ctx, actionId);
  if (now?.status === "applied") return replay(now);
  return refuse(ctx, actionId, now !== undefined, "NOT_APPROVED", `Action ${actionId} is ${now?.status ?? "gone"}, not approved.`);
}

/** approved -> failed by CAS, with an apply_failed row in the same transaction. */
function fail(ctx: AppContext, actionId: string, code: ErrorCode, message: string): ApplyResult {
  const won = ctx.db.transaction(() => {
    const r = ctx.db.run("UPDATE actions SET status = 'failed', error = ? WHERE id = ? AND status = 'approved'", [
      `${code}: ${message}`,
      actionId,
    ]);
    if (r.changes !== 1) return false;
    appendEvent(ctx.db, {
      ts: isoNow(ctx.clock),
      actionId,
      tool: TOOL,
      kind: "apply_failed",
      outcome: "error",
      errorCode: code,
      preview: preview(actionId, true, message),
    });
    return true;
  }, "immediate");
  return won ? { ok: false, errorCode: code, message } : afterLostCas(ctx, actionId);
}

/**
 * approved -> applied by CAS, with the applied row in the same transaction.
 * `beforeCommit` (test seam) runs after both statements and before COMMIT, so
 * a throw rolls everything back and propagates unchanged.
 */
function finalize(
  ctx: AppContext,
  actionId: string,
  result: EventRef,
  opts: { replayed: boolean; note: string | null; beforeCommit?: () => void },
): ApplyResult {
  const won = ctx.db.transaction(() => {
    const ts = isoNow(ctx.clock);
    const r = ctx.db.run(
      "UPDATE actions SET status = 'applied', applied_at = ?, result_json = ? WHERE id = ? AND status = 'approved'",
      [ts, canonicalJson(result), actionId],
    );
    if (r.changes !== 1) return false;
    appendEvent(ctx.db, {
      ts,
      actionId,
      tool: TOOL,
      kind: "applied",
      outcome: "ok",
      preview: preview(actionId, true, opts.note),
    });
    opts.beforeCommit?.();
    return true;
  }, "immediate");
  return won ? { ok: true, replayed: opts.replayed, result } : afterLostCas(ctx, actionId);
}

export async function applyAction(ctx: AppContext, actionId: string): Promise<ApplyResult> {
  const row = load(ctx, actionId);

  // 1. Writes flag.
  if (!ctx.config.writesEnabled) {
    return refuse(ctx, actionId, row !== undefined, "WRITES_DISABLED", "Writes are disabled (set DESKHAND_ALLOW_WRITES=1).");
  }
  // 2. Exists.
  if (!row) return refuse(ctx, actionId, false, "UNKNOWN_ACTION", `No action with id ${actionId}.`);
  // 3. Applied replay: stored result, no lifecycle row, no provider call.
  if (row.status === "applied") return replay(row);
  // 4. Approved.
  if (row.status !== "approved") {
    return refuse(ctx, actionId, true, "NOT_APPROVED", `Action ${actionId} is ${row.status}, not approved.`);
  }
  // 5. Hash: recomputed from the stored plan, equal to plan_hash and approved_plan_hash.
  let plan: unknown;
  let hash: string | undefined;
  try {
    plan = JSON.parse(row.plan_json) as unknown;
    hash = planHash(plan);
  } catch {
    hash = undefined;
  }
  if (hash === undefined || hash !== row.plan_hash || hash !== row.approved_plan_hash) {
    return fail(ctx, actionId, "PLAN_MODIFIED", "The plan changed after approval; re-plan and approve again.");
  }
  const kindName = (plan as { kind?: unknown }).kind;
  const kind: PlanKind<unknown> | undefined = typeof kindName === "string" ? getPlanKind(kindName) : undefined;
  const parsed = kind?.schema.safeParse(plan);
  if (!kind || !parsed?.success) {
    // Unreachable through createPlan (it validates); refuse without touching status.
    return refuse(ctx, actionId, true, "INTERNAL", "The stored plan has an unknown kind or is invalid.");
  }
  const validPlan = parsed.data;
  const key = idempotencyKey(actionId);

  // Our own event under the idempotency key, if the provider already holds it.
  // A read error is retryable: refuse with PROVIDER_ERROR, status unchanged.
  type Lookup = { found: EventRef | null } | { refused: ApplyResult };
  const lookup = async (when: string): Promise<Lookup> => {
    try {
      return { found: await kind.lookupExisting(validPlan, key, ctx.provider) };
    } catch (e) {
      return { refused: refuse(ctx, actionId, true, "PROVIDER_ERROR", `Provider lookup ${when} failed: ${errText(e)}`) };
    }
  };
  const recovered = (ev: EventRef): ApplyResult =>
    finalize(ctx, actionId, ev, { replayed: true, note: "recovered" });

  // 6. Recovery: our own earlier write that crashed before the ledger commit.
  const first = await lookup("for recovery");
  if ("refused" in first) return first.refused;
  if (first.found) return recovered(first.found);

  // 7. Expiry. Fails closed: an unparseable expires_at counts as expired.
  if (!(ctx.clock().getTime() < Date.parse(row.expires_at))) {
    return refuse(ctx, actionId, true, "PLAN_EXPIRED", `Action ${actionId} expired at ${row.expires_at}.`);
  }
  // 8. Re-check against the real world. A read error is retryable (status unchanged).
  let check: Awaited<ReturnType<typeof kind.recheck>>;
  try {
    check = await kind.recheck(validPlan, ctx.provider);
  } catch (e) {
    return refuse(ctx, actionId, true, "PROVIDER_ERROR", `Provider re-check failed: ${errText(e)}`);
  }
  if (!check.ok) {
    // The slot may be taken by OUR event (a concurrent apply of this action
    // wrote it after our recovery lookup): look again before failing.
    const again = await lookup("after a failed re-check");
    if ("refused" in again) return again.refused;
    if (again.found) return recovered(again.found);
    return fail(ctx, actionId, "STALE_PLAN", `The world changed since planning: ${check.reason}.`);
  }
  // 9. Write with the idempotency key, then commit.
  let result: EventRef;
  try {
    result = await kind.execute(validPlan, key, ctx.provider);
  } catch (e) {
    // Ambiguous failure (e.g. a timeout after the provider accepted the write):
    // if our event exists, the write happened. Only a confirmed absence is terminal.
    const msg = `Provider write failed: ${errText(e)}`;
    const after = await lookup("after a failed write");
    if ("refused" in after) return after.refused;
    if (after.found) return recovered(after.found);
    return fail(ctx, actionId, "PROVIDER_ERROR", msg);
  }
  return finalize(ctx, actionId, result, { replayed: false, note: null, beforeCommit: ctx.hooks?.beforeCommit });
}
