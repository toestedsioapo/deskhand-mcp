import type { AppContext } from "../app-context.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow } from "../ledger/ids.js";

/**
 * The write claim (M4b decision 8; docs/ledger-contract.md, gate 8b). A provider with no unique key on a write (Gmail
 * and a draft's Message-ID) cannot refuse a duplicate, so the ledger serialises the write: a `write_claimed` row is
 * taken in `BEGIN IMMEDIATE` before the POST.
 *
 * The POST starts within 30 s of the claim, and a token refresh and the POST are each capped at 10 s, so the holder's
 * request has ended by 50 s. The last 10 s of the hold are margin for the write to become readable. This bound relies
 * on the draft POST using the Google HTTP layer's `singleSend`: without it, a 401 would refresh and send again, and a
 * request could still be running at about 70 s, after the hold.
 */
export const WRITE_CLAIM_HOLD_MS = 60_000;
export const WRITE_CLAIM_START_LIMIT_MS = 30_000;

export type WriteClaim = { ok: true; claimId: number } | { ok: false; reason: "held" | "not_approved" };

interface ClaimRow {
  id: number;
  ts: string;
}

const newestClaim = (ctx: AppContext, actionId: string): ClaimRow | undefined =>
  ctx.db.get<ClaimRow>(
    "SELECT id, ts FROM events WHERE action_id = ? AND kind = 'write_claimed' ORDER BY id DESC LIMIT 1",
    [actionId],
  );

const isApproved = (ctx: AppContext, actionId: string): boolean =>
  ctx.db.get<{ status: string }>("SELECT status FROM actions WHERE id = ?", [actionId])?.status === "approved";

/** True when an `apply_refused` row of this action names exactly this claim in `preview.output.releasedClaim`. */
function isReleased(ctx: AppContext, actionId: string, claimId: number): boolean {
  const rows = ctx.db.all<{ preview_json: string }>(
    "SELECT preview_json FROM events WHERE action_id = ? AND id > ? AND kind = 'apply_refused' AND tool = 'action_apply'",
    [actionId, claimId],
  );
  return rows.some((r) => {
    try {
      const p = JSON.parse(r.preview_json) as { output?: { releasedClaim?: unknown } | null } | null;
      return p?.output?.releasedClaim === claimId;
    } catch {
      return false;
    }
  });
}

/** Milliseconds since the claim; NaN when its `ts` does not parse. */
const ageOf = (ctx: AppContext, claim: ClaimRow): number => ctx.clock().getTime() - Date.parse(claim.ts);

/** Unreleased and not yet `WRITE_CLAIM_HOLD_MS` old. Fails closed: an unparseable `ts` (NaN age) counts as held. */
function isHeld(ctx: AppContext, actionId: string, claim: ClaimRow): boolean {
  return !isReleased(ctx, actionId, claim.id) && !(ageOf(ctx, claim) >= WRITE_CLAIM_HOLD_MS);
}

/** Gate 8b: inserts a `write_claimed` row unless the plan is no longer approved or another claim is held. */
export function takeWriteClaim(ctx: AppContext, actionId: string): WriteClaim {
  return ctx.db.transaction((): WriteClaim => {
    if (!isApproved(ctx, actionId)) return { ok: false, reason: "not_approved" };
    const newest = newestClaim(ctx, actionId);
    if (newest && isHeld(ctx, actionId, newest)) return { ok: false, reason: "held" };
    const claimId = appendEvent(ctx.db, {
      ts: isoNow(ctx.clock),
      actionId,
      tool: "action_apply",
      kind: "write_claimed",
      outcome: "ok",
      preview: { v: 1, input: { action_id: actionId }, output: null, note: null, action_id: actionId },
    });
    return { ok: true, claimId };
  }, "immediate");
}

/**
 * The last check before the POST: the plan is still approved and this claim is still the newest, unreleased and
 * younger than `WRITE_CLAIM_START_LIMIT_MS`. Fails closed on an unparseable `ts` or a clock behind the claim.
 */
export function claimStillValid(ctx: AppContext, actionId: string, claimId: number): boolean {
  return ctx.db.transaction(() => {
    if (!isApproved(ctx, actionId)) return false;
    const newest = newestClaim(ctx, actionId);
    if (newest?.id !== claimId || isReleased(ctx, actionId, claimId)) return false;
    const age = ageOf(ctx, newest);
    return age >= 0 && age < WRITE_CLAIM_START_LIMIT_MS;
  }, "immediate");
}

/** True while this action's newest claim is unreleased and younger than the hold: a write may still be landing. */
export function hasLiveClaim(ctx: AppContext, actionId: string): boolean {
  const newest = newestClaim(ctx, actionId);
  return newest !== undefined && isHeld(ctx, actionId, newest);
}
