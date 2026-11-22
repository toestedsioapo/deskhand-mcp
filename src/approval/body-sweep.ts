import type { AppContext } from "../app-context.js";
import { canonicalJson, planHash } from "../ledger/canonical.js";

/**
 * Body retention (ADR 0010, point 3; ledger contract, "The sweep and `bodyRemoved`"). A drafted body lives in
 * `actions.plan_json` only while the action can still be written. This removes it from every
 * `mail.create_draft_reply` row that still has `draft.body` and whose status is `applied`, `rejected` or `failed`,
 * or `planned` / `approved` with `now >= expires_at` (an unparseable `expires_at` counts as expired, as at gate 7).
 * The row's plan_json becomes the canonical JSON of the plan with `body` deleted and `bodyRemoved: true`; no other
 * column changes and no event row is written. `planHash` leaves `body` and `bodyRemoved` out, so the hash of the new
 * plan equals the hash of the old one by construction (checked per row; a row where it would not is left alone).
 *
 * Runs in one BEGIN IMMEDIATE and returns the number of rows rewritten. It then always runs
 * `PRAGMA wal_checkpoint(TRUNCATE)` so an old page leaves the WAL; a busy result (or a checkpoint error, e.g.
 * inside an outer transaction) is retried by the next sweep. Throws only when the ledger itself fails; the call sites use
 * `sweepDraftBodiesQuietly`. `now` defaults to one read of `ctx.clock` (createPlan passes its own single read).
 */
export function sweepDraftBodies(ctx: AppContext, now: Date = ctx.clock()): number {
  const nowMs = now.getTime();
  const count = ctx.db.transaction(() => {
    // Canonical plan_json spells the key exactly `"body":`; anything else is not a row a plan tool wrote and can
    // never pass the apply or approve canonical-text check.
    const rows = ctx.db.all<{ id: string; plan_json: string; status: string; expires_at: string }>(
      `SELECT id, plan_json, status, expires_at FROM actions
       WHERE status IN ('applied','rejected','failed','planned','approved') AND instr(plan_json, '"body":') > 0`,
    );
    let n = 0;
    for (const r of rows) {
      const ended = r.status === "applied" || r.status === "rejected" || r.status === "failed";
      // Fails closed like gate 7: now >= expires_at, or an unparseable expires_at, is expired.
      if (!ended && nowMs < Date.parse(r.expires_at)) continue;
      const next = withoutBody(r.plan_json);
      if (next === undefined) continue;
      ctx.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [next, r.id]);
      n++;
    }
    return n;
  }, "immediate");
  // Every sweep, even one that removed nothing: an earlier sweep's checkpoint may have been busy, and its removed body
  // stays in the WAL until a checkpoint succeeds.
  checkpointWithoutWaiting(ctx);
  return count;
}

/**
 * `wal_checkpoint(TRUNCATE)` with busy_timeout 0, because sweeps run inside ordinary calls and must not stall behind
 * another connection's reader. Best effort: the rows are committed, and the next sweep (or the last connection
 * closing) checkpoints the WAL.
 */
function checkpointWithoutWaiting(ctx: AppContext): void {
  let timeout: number | undefined;
  try {
    timeout = ctx.db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout;
    ctx.db.exec("PRAGMA busy_timeout = 0");
    ctx.db.get("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // Busy, or inside an outer transaction.
  } finally {
    if (timeout !== undefined) {
      try {
        ctx.db.exec(`PRAGMA busy_timeout = ${Math.trunc(timeout)}`);
      } catch {
        // The connection is failing; its next statement reports that.
      }
    }
  }
}

/**
 * Best-effort sweep for the triggers (server start, after action_apply, after deskhand reject, start of pending and
 * of createPlan). A sweep never guards a write: an expired or ended plan is refused by approve and apply on its own
 * (expiry, status, gate 7a). So a failing sweep must not fail the operation that triggered it; the body is removed
 * at the next trigger. Returns the count, or 0 when the sweep failed.
 */
export function sweepDraftBodiesQuietly(ctx: AppContext, now?: Date): number {
  try {
    return sweepDraftBodies(ctx, now ?? ctx.clock());
  } catch {
    return 0;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The canonical plan_json without the body, or undefined when the row is not a draft plan with a body. */
function withoutBody(planJson: string): string | undefined {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson) as unknown;
  } catch {
    return undefined;
  }
  if (!isObject(plan) || plan["kind"] !== "mail.create_draft_reply") return undefined;
  const draft = plan["draft"];
  if (!isObject(draft) || !Object.hasOwn(draft, "body")) return undefined;
  const { body: _body, ...rest } = draft;
  const next = { ...plan, draft: { ...rest, bodyRemoved: true } };
  try {
    // Decision 2: removing the body never changes the hash. If it somehow would, leave the row as it is.
    if (planHash(next) !== planHash(plan)) return undefined;
    return canonicalJson(next);
  } catch {
    return undefined;
  }
}
