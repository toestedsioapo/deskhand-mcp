import { createHash } from "node:crypto";
import type { AppContext } from "../app-context.js";
import { canonicalJson, planHash } from "../ledger/canonical.js";
import type { ActionStatus, ErrorCode, EventOutcome } from "../ledger/contract.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow } from "../ledger/ids.js";
import { redactInput, scrubSecrets } from "../ledger/redact.js";
import { AuthRequiredError, EVENT_DELETED, ProviderError } from "../providers/errors.js";
import type { EventLookup, EventRef } from "../providers/types.js";
import { EVENT_DIFFERS, getPlanKind, type PlanKind } from "./plan-kinds.js";

/**
 * The apply engine: the ONLY place a plan kind's write is executed (a
 * structural test enforces it). Gate order is fixed by docs/ledger-contract.md
 * ("Apply gate order"): writes flag, provider configured, exists, applied-replay, approved, hash,
 * recovery, expiry, re-check, write.
 */

/** `calendarId` is the plan's calendar (where `result` lives), so the tool can label the event's text by its source. */
export type ApplyResult =
  | { ok: true; replayed: boolean; result: EventRef; calendarId: string }
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

const GATE_REFUSALS: readonly ErrorCode[] = [
  "WRITES_DISABLED",
  "PROVIDER_NOT_CONFIGURED",
  "UNKNOWN_ACTION",
  "PLAN_EXPIRED",
  "NOT_APPROVED",
  "AUTH_REQUIRED",
];
const outcomeFor = (code: ErrorCode): EventOutcome => (GATE_REFUSALS.includes(code) ? "rejected" : "error");

/** Provider error text, through the ledger redactor (long strings are cut and hashed). */
const errText = (e: unknown): string => String(redactInput(scrubSecrets(e instanceof Error ? e.message : String(e))));

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

/** A provider call failed during apply: AUTH_REQUIRED for a sign-in problem, else PROVIDER_ERROR. Status unchanged. */
function refuseProvider(ctx: AppContext, actionId: string, e: unknown, what: string): ApplyResult {
  if (e instanceof AuthRequiredError) return refuse(ctx, actionId, true, "AUTH_REQUIRED", errText(e));
  return refuse(ctx, actionId, true, "PROVIDER_ERROR", `${what}: ${errText(e)}`);
}

/** The stored plan's calendar id; "unknown" for a plan that does not name one (unreachable through the plan tools). */
function calendarIdOf(row: RawAction): string {
  try {
    const id = (JSON.parse(row.plan_json) as { event?: { calendarId?: unknown } } | null)?.event?.calendarId;
    return typeof id === "string" ? id : "unknown";
  } catch {
    return "unknown";
  }
}

/** Replay of a stored result (status already `applied`). */
function replay(row: RawAction): ApplyResult {
  const result = JSON.parse(row.result_json ?? "null") as EventRef;
  return { ok: true, replayed: true, result, calendarId: calendarIdOf(row) };
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
  opts: { replayed: boolean; note: string | null; calendarId: string; beforeCommit?: () => void },
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
  return won ? { ok: true, replayed: opts.replayed, result, calendarId: opts.calendarId } : afterLostCas(ctx, actionId);
}

export async function applyAction(ctx: AppContext, actionId: string): Promise<ApplyResult> {
  const row = load(ctx, actionId);

  // 1. Writes flag.
  if (!ctx.config.writesEnabled) {
    return refuse(ctx, actionId, row !== undefined, "WRITES_DISABLED", "Writes are disabled (set DESKHAND_ALLOW_WRITES=1).");
  }
  // 1b. A provider is configured (ADR 0008); without one nothing can be applied.
  const provider = ctx.provider;
  if (provider === null) {
    return refuse(
      ctx,
      actionId,
      row !== undefined,
      "PROVIDER_NOT_CONFIGURED",
      "No provider is configured (set DESKHAND_PROVIDER=fixture).",
    );
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
  // plan_json must also be exactly the canonical text that was hashed (no duplicate keys or other spellings).
  if (
    hash === undefined ||
    hash !== row.plan_hash ||
    hash !== row.approved_plan_hash ||
    canonicalJson(plan) !== row.plan_json
  ) {
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
  const calendarId = calendarIdOf(row);

  // What the provider holds under the idempotency key. A read error is retryable: refuse, status unchanged.
  type Lookup = { found: EventLookup } | { refused: ApplyResult };
  const lookup = async (when: string): Promise<Lookup> => {
    try {
      return { found: await kind.lookupExisting(validPlan, key, provider) };
    } catch (e) {
      return { refused: refuseProvider(ctx, actionId, e, `Provider lookup ${when} failed`) };
    }
  };
  /**
   * An event under our key counts as this action's write only when it is the approved one. Every place an existing
   * event is accepted goes through here: the recovery lookup, the re-lookups and an event `execute` returned.
   * Cancelled (deleted after an earlier write) and differing events end the plan `failed`, never re-written.
   */
  const accept = (ev: EventRef, opts: { replayed: boolean; note: string | null; beforeCommit?: () => void }): ApplyResult =>
    kind.matches(validPlan, key, ev)
      ? finalize(ctx, actionId, ev, { ...opts, calendarId })
      : fail(ctx, actionId, "STALE_PLAN", EVENT_DIFFERS);
  /** A lookup that found something decides the apply; `undefined` means nothing is there. */
  const settle = (found: EventLookup): ApplyResult | undefined => {
    if (found.state === "absent") return undefined;
    if (found.state === "cancelled") return fail(ctx, actionId, "STALE_PLAN", EVENT_DELETED);
    return accept(found.event, { replayed: true, note: "recovered" });
  };

  // 6. Recovery: our own earlier write that crashed before the ledger commit.
  const first = await lookup("for recovery");
  if ("refused" in first) return first.refused;
  const recovered = settle(first.found);
  if (recovered) return recovered;

  // 7. Expiry. Fails closed: an unparseable expires_at counts as expired.
  if (!(ctx.clock().getTime() < Date.parse(row.expires_at))) {
    return refuse(ctx, actionId, true, "PLAN_EXPIRED", `Action ${actionId} expired at ${row.expires_at}.`);
  }
  // 8. Re-check against the real world. A read error is retryable (status unchanged).
  let check: Awaited<ReturnType<typeof kind.recheck>>;
  try {
    check = await kind.recheck(validPlan, provider);
  } catch (e) {
    return refuseProvider(ctx, actionId, e, "Provider re-check failed");
  }
  if (!check.ok) {
    // The slot may be taken by OUR event (a concurrent apply of this action
    // wrote it after our recovery lookup): look again before failing.
    const again = await lookup("after a failed re-check");
    if ("refused" in again) return again.refused;
    return settle(again.found) ?? fail(ctx, actionId, "STALE_PLAN", `The world changed since planning: ${check.reason}.`);
  }
  // 9. Write with the idempotency key, then commit.
  let result: EventRef;
  try {
    result = await kind.execute(validPlan, key, provider);
  } catch (e) {
    // The write may have happened anyway (e.g. a timeout after the provider accepted it): look for our event.
    const after = await lookup("after a failed write");
    if ("refused" in after) return after.refused;
    const settled = settle(after.found);
    if (settled) return settled;
    // Nothing there. An auth failure means the write was not attempted or not authorised: never terminal.
    if (e instanceof AuthRequiredError) return refuse(ctx, actionId, true, "AUTH_REQUIRED", errText(e));
    const msg = `Provider write failed: ${errText(e)}`;
    // Ambiguous (timeout, network, 429, 5xx): it may still land, and a retry with the same key cannot duplicate
    // it (recovery or the provider's existing-id path finds it). Stay approved. Only a definite rejection fails.
    if (e instanceof ProviderError && e.retryable) return refuse(ctx, actionId, true, "PROVIDER_ERROR", msg);
    return fail(ctx, actionId, "PROVIDER_ERROR", msg);
  }
  // `execute` may return an event that already existed under our key (a concurrent apply, or the provider's
  // existing-id path): it is accepted only when it is the approved one.
  return accept(result, { replayed: false, note: null, beforeCommit: ctx.hooks?.beforeCommit });
}
