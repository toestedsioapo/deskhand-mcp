import type { AppContext } from "../app-context.js";
import { canonicalJson, planHash } from "../ledger/canonical.js";
import type { ActionStatus, ErrorCode, EventOutcome } from "../ledger/contract.js";
import { appendEvent } from "../ledger/events.js";
import { idempotencyKey, isoNow } from "../ledger/ids.js";
import { redactInput, scrubSecrets } from "../ledger/redact.js";
import { AuthRequiredError, ProviderError } from "../providers/errors.js";
import type { Providers } from "../providers/types.js";
import { getPlanKind, type AnyPlanKind, type ApplyOutputResult, type Lookup } from "./plan-kinds.js";
import { claimStillValid, hasLiveClaim, takeWriteClaim } from "./write-claim.js";

/**
 * The apply engine: the ONLY place a plan kind's write is executed (a
 * structural test enforces it). Gate order is fixed by docs/ledger-contract.md
 * ("Apply gate order"): writes flag, provider configured, exists, applied-replay, approved, hash (and the kind's
 * integrity hook), recovery, expiry, the kind's writable hook (7a), re-check, write claim (8b, kinds that need one),
 * write.
 */

/** `output` is the plan kind's `action_apply` result, built from `result_json` (the first apply and a replay alike). */
export type ApplyResult =
  | { ok: true; replayed: boolean; output: ApplyOutputResult }
  | { ok: false; errorCode: ErrorCode; message: string };

const TOOL = "action_apply";

/** Lowercase hex SHA-256 of the action id (ledger contract, "Idempotency key"); defined in src/ledger/ids.ts. */
export { idempotencyKey };

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

function preview(actionId: string, existing: boolean, note: string | null, output: unknown = null): unknown {
  const p: Record<string, unknown> = { v: 1, input: { action_id: actionId }, output, note };
  if (existing) p["action_id"] = actionId;
  return p;
}

/**
 * Refusal: an apply_refused row in its own transaction; `actions` untouched. `releasedClaim` is passed only by an exit
 * known to have sent no POST: the row then also releases that write claim (and no other).
 */
function refuse(
  ctx: AppContext,
  actionId: string,
  existing: boolean,
  code: ErrorCode,
  message: string,
  releasedClaim?: number,
): ApplyResult {
  ctx.db.transaction(() => {
    appendEvent(ctx.db, {
      ts: isoNow(ctx.clock),
      actionId: existing ? actionId : null,
      tool: TOOL,
      kind: "apply_refused",
      outcome: outcomeFor(code),
      errorCode: code,
      preview: preview(actionId, existing, message, releasedClaim === undefined ? null : { releasedClaim }),
    });
  }, "immediate");
  return { ok: false, errorCode: code, message };
}

/** A provider call failed during apply: AUTH_REQUIRED for a sign-in problem, else PROVIDER_ERROR. Status unchanged. */
function refuseProvider(ctx: AppContext, actionId: string, e: unknown, what: string, releasedClaim?: number): ApplyResult {
  if (e instanceof AuthRequiredError) return refuse(ctx, actionId, true, "AUTH_REQUIRED", errText(e), releasedClaim);
  return refuse(ctx, actionId, true, "PROVIDER_ERROR", `${what}: ${errText(e)}`, releasedClaim);
}

/** The registered kind a raw stored plan names, if any. */
function kindOf(plan: unknown): AnyPlanKind | undefined {
  const name = typeof plan === "object" && plan !== null ? (plan as { kind?: unknown }).kind : undefined;
  return typeof name === "string" ? getPlanKind(name) : undefined;
}

/** The stored plan with its kind, or undefined when plan_json does not parse, names no known kind or is invalid. */
function parseStored(planJson: string): { kind: AnyPlanKind; plan: unknown } | undefined {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson) as unknown;
  } catch {
    return undefined;
  }
  const kind = kindOf(plan);
  const parsed = kind?.schema.safeParse(plan);
  return kind && parsed?.success ? { kind, plan: parsed.data } : undefined;
}

/** The kind's `action_apply` result from the canonical text that is (or was just) stored as result_json. */
const outputFrom = (kind: AnyPlanKind, plan: unknown, resultJson: string): ApplyOutputResult =>
  kind.output(plan, JSON.parse(resultJson) as unknown);

/** Prefix of the refusal note for an ambiguous (retryable) write failure; `hadAmbiguousWrite` looks for it. */
const WRITE_FAILED = "Provider write failed: ";
/** Fixed note: a failed re-check after an earlier ambiguous write attempt (ledger contract, gate 8). */
const STILL_LANDING = "an earlier write attempt may still be landing; retry later";
/** Fixed note: the write claim is held by another apply, or ours can no longer start a POST (ledger contract, gate 8b). */
const CLAIM_HELD = "another apply of this action is in progress or may still be landing; retry in a minute";

/**
 * True when this action's own ledger rows show an earlier write attempt whose outcome was unknown. Gate 9 writes
 * every ambiguous attempt as an `apply_refused` row (PROVIDER_ERROR, or AUTH_REQUIRED when the lookup after it
 * needed a sign-in) whose note starts with the fixed WRITE_FAILED prefix, whatever the follow-up lookup did; no
 * other row carries that prefix, and the preview redactor always keeps the note's start. Read from the ledger, so
 * it holds across processes and restarts.
 */
function hadAmbiguousWrite(ctx: AppContext, actionId: string): boolean {
  const rows = ctx.db.all<{ preview_json: string }>(
    "SELECT preview_json FROM events WHERE action_id = ? AND kind = 'apply_refused' AND error_code IN ('PROVIDER_ERROR', 'AUTH_REQUIRED')",
    [actionId],
  );
  return rows.some((r) => {
    try {
      const note = (JSON.parse(r.preview_json) as { note?: unknown } | null)?.note;
      return typeof note === "string" && note.startsWith(WRITE_FAILED);
    } catch {
      return false;
    }
  });
}

/**
 * Replay of a stored result (status already `applied`): the kind rebuilds the result from result_json. An applied
 * row whose plan no longer parses is unreachable through the plan tools; it is refused (INTERNAL), status unchanged.
 */
function replay(ctx: AppContext, row: RawAction): ApplyResult {
  const stored = parseStored(row.plan_json);
  if (!stored) return refuse(ctx, row.id, true, "INTERNAL", "The stored plan has an unknown kind or is invalid.");
  return { ok: true, replayed: true, output: outputFrom(stored.kind, stored.plan, row.result_json ?? "null") };
}

/**
 * Called when a CAS found the plan no longer `approved` (a concurrent apply won,
 * or something else moved it). Applied: return the stored result as a replay.
 * Otherwise: a NOT_APPROVED refusal.
 */
function afterLostCas(ctx: AppContext, actionId: string): ApplyResult {
  const now = load(ctx, actionId);
  if (now?.status === "applied") return replay(ctx, now);
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
  resultJson: string,
  opts: { replayed: boolean; note: string | null; output: () => ApplyOutputResult; beforeCommit?: () => void },
): ApplyResult {
  const won = ctx.db.transaction(() => {
    const ts = isoNow(ctx.clock);
    const r = ctx.db.run(
      "UPDATE actions SET status = 'applied', applied_at = ?, result_json = ? WHERE id = ? AND status = 'approved'",
      [ts, resultJson, actionId],
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
  return won ? { ok: true, replayed: opts.replayed, output: opts.output() } : afterLostCas(ctx, actionId);
}

export async function applyAction(ctx: AppContext, actionId: string): Promise<ApplyResult> {
  const row = load(ctx, actionId);

  // 1. Writes flag.
  if (!ctx.config.writesEnabled) {
    return refuse(ctx, actionId, row !== undefined, "WRITES_DISABLED", "Writes are disabled (set DESKHAND_ALLOW_WRITES=1).");
  }
  // 1b. Providers are configured (ADR 0008): calendar and mail are set together; without them nothing is applied.
  if (ctx.provider === null || ctx.mail === null) {
    return refuse(
      ctx,
      actionId,
      row !== undefined,
      "PROVIDER_NOT_CONFIGURED",
      "No provider is configured (set DESKHAND_PROVIDER).",
    );
  }
  // 2. Exists.
  if (!row) return refuse(ctx, actionId, false, "UNKNOWN_ACTION", `No action with id ${actionId}.`);
  // 3. Applied replay: stored result, no lifecycle row, no provider call.
  if (row.status === "applied") return replay(ctx, row);
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
  // 5, the kind's integrity hook: an edit the hash does not cover (a drafted body that no longer matches its stored
  // length and hash) is PLAN_MODIFIED too, checked before the schema so it is never the schema's INTERNAL.
  if (kindOf(plan)?.tampered?.(plan)) {
    return fail(ctx, actionId, "PLAN_MODIFIED", "The plan changed after approval; re-plan and approve again.");
  }
  const stored = parseStored(row.plan_json);
  if (!stored) {
    // Unreachable through createPlan (it validates); refuse without touching status.
    return refuse(ctx, actionId, true, "INTERNAL", "The stored plan has an unknown kind or is invalid.");
  }
  const { kind, plan: validPlan } = stored;
  const providers: Providers = { calendar: ctx.provider, mail: ctx.mail };
  const key = idempotencyKey(actionId);

  // What the provider holds under the idempotency key. A read error is retryable: refuse, status unchanged.
  type Found = { found: Lookup<unknown> } | { failed: unknown };
  const lookup = async (): Promise<Found> => {
    try {
      return { found: await kind.lookupExisting(validPlan, key, providers) };
    } catch (e) {
      return { failed: e };
    }
  };
  /**
   * A write under our key counts as this action's only when it is the approved one. Every place an existing write is
   * accepted goes through here: the recovery lookup, the re-lookups and a value `execute` returned. Cancelled
   * (deleted after an earlier write) and differing writes end the plan `failed`, never re-written. result_json is
   * the canonical text of the kind's `store` form, and the result is rebuilt from that same text.
   */
  const accept = (r: unknown, opts: { replayed: boolean; note: string | null; beforeCommit?: () => void }): ApplyResult => {
    if (!kind.matches(validPlan, key, r)) return fail(ctx, actionId, "STALE_PLAN", kind.phrases.differs);
    const resultJson = canonicalJson(kind.store(r));
    return finalize(ctx, actionId, resultJson, { ...opts, output: () => outputFrom(kind, validPlan, resultJson) });
  };
  /** A lookup that found something decides the apply; `undefined` means nothing is there. */
  const settle = (found: Lookup<unknown>): ApplyResult | undefined => {
    if (found.state === "absent") return undefined;
    if (found.state === "cancelled") return fail(ctx, actionId, "STALE_PLAN", kind.phrases.deleted);
    return accept(found.value, { replayed: true, note: "recovered" });
  };

  // 6. Recovery: our own earlier write that crashed before the ledger commit.
  const first = await lookup();
  if ("failed" in first) return refuseProvider(ctx, actionId, first.failed, "Provider lookup for recovery failed");
  const recovered = settle(first.found);
  if (recovered) return recovered;

  // 7. Expiry. Fails closed: an unparseable expires_at counts as expired.
  if (!(ctx.clock().getTime() < Date.parse(row.expires_at))) {
    return refuse(ctx, actionId, true, "PLAN_EXPIRED", `Action ${actionId} expired at ${row.expires_at}.`);
  }
  // 7a. A plan that can no longer be written (a draft whose body was swept) fails here, after recovery and expiry,
  // so the provider is never asked to write it.
  if (kind.writable && !kind.writable(validPlan)) {
    return fail(ctx, actionId, "PLAN_MODIFIED", "The plan's content was removed after the action ended; it can no longer be written.");
  }
  // 8. Re-check against the real world. A read error is retryable (status unchanged).
  let check: Awaited<ReturnType<typeof kind.recheck>>;
  try {
    check = await kind.recheck(validPlan, providers);
  } catch (e) {
    return refuseProvider(ctx, actionId, e, "Provider re-check failed");
  }
  if (!check.ok) {
    // The slot may be taken by OUR event (a concurrent apply of this action
    // wrote it after our recovery lookup): look again before failing.
    const again = await lookup();
    if ("failed" in again) return refuseProvider(ctx, actionId, again.failed, "Provider lookup after a failed re-check failed");
    const settled = settle(again.found);
    if (settled) return settled;
    // An earlier attempt of this action may have written the event that now makes the slot busy, while the
    // provider cannot read it back yet. Not terminal: refuse, status unchanged; a later apply recovers it.
    // The same holds while another apply's unreleased claim is live: its write may be in flight.
    if (hadAmbiguousWrite(ctx, actionId) || hasLiveClaim(ctx, actionId)) {
      return refuse(ctx, actionId, true, "PROVIDER_ERROR", STILL_LANDING);
    }
    return fail(ctx, actionId, "STALE_PLAN", `The world changed since planning: ${check.reason}.`);
  }
  // 8b. Write claim, for a kind whose provider cannot refuse a second write. Only an exit known to have sent no POST
  // releases it; a crash, timeout, network error, 429, 5xx or unreadable 2xx leaves it to age out.
  let claimId: number | undefined;
  if (kind.needsWriteClaim) {
    const claim = takeWriteClaim(ctx, actionId);
    if (!claim.ok) {
      return claim.reason === "held" ? refuse(ctx, actionId, true, "PROVIDER_ERROR", CLAIM_HELD) : afterLostCas(ctx, actionId);
    }
    claimId = claim.claimId;
    const underClaim = await lookup();
    if ("failed" in underClaim) {
      return refuseProvider(ctx, actionId, underClaim.failed, "Provider lookup under the write claim failed", claimId);
    }
    const settled = settle(underClaim.found);
    if (settled) return settled;
    if (!claimStillValid(ctx, actionId, claimId)) return refuse(ctx, actionId, true, "PROVIDER_ERROR", CLAIM_HELD, claimId);
  }
  // 9. Write with the idempotency key, then commit.
  let result: unknown;
  try {
    result = await kind.execute(validPlan, key, providers);
  } catch (e) {
    // The write may have happened anyway (e.g. a timeout after the provider accepted it): look for our event.
    const ambiguous = e instanceof ProviderError && e.retryable;
    const after = await lookup();
    if ("failed" in after) {
      if (!ambiguous) {
        // An auth failure means no draft was written, so its claim is released; any other failure keeps it.
        const release = e instanceof AuthRequiredError ? claimId : undefined;
        return refuseProvider(ctx, actionId, after.failed, "Provider lookup after a failed write failed", release);
      }
      // Record the ambiguous attempt even though the lookup failed (the note starts with WRITE_FAILED), so a later
      // busy re-check is not terminal. Status unchanged either way.
      const code = after.failed instanceof AuthRequiredError ? "AUTH_REQUIRED" : "PROVIDER_ERROR";
      return refuse(ctx, actionId, true, code, `${WRITE_FAILED}${errText(e)}; the lookup after it failed: ${errText(after.failed)}`);
    }
    const settled = settle(after.found);
    if (settled) return settled;
    // Nothing there. An auth failure means the write was not attempted or not authorised: never terminal.
    if (e instanceof AuthRequiredError) return refuse(ctx, actionId, true, "AUTH_REQUIRED", errText(e), claimId);
    const msg = `${WRITE_FAILED}${errText(e)}`;
    // Ambiguous (timeout, network, 429, 5xx): it may still land. Stay approved; only a definite rejection fails. A
    // retry finds it by recovery or the provider's fixed id. A kind with a write claim keeps it (not released here), so
    // a retry may write again only after the hold and a lookup that finds nothing (residual risk in SECURITY.md).
    if (ambiguous) return refuse(ctx, actionId, true, "PROVIDER_ERROR", msg);
    return fail(ctx, actionId, "PROVIDER_ERROR", msg);
  }
  // `execute` may return an event that already existed under our key (a concurrent apply, or the provider's
  // existing-id path): it is accepted only when it is the approved one.
  return accept(result, { replayed: false, note: null, beforeCommit: ctx.hooks?.beforeCommit });
}
