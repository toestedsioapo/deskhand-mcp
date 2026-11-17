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
 * Runs in one BEGIN IMMEDIATE and returns the number of rows rewritten. When that is above 0 it runs
 * `PRAGMA wal_checkpoint(TRUNCATE)` so the old page leaves the WAL; a busy result (or a checkpoint error, e.g.
 * inside an outer transaction) is ignored. Throws only when the ledger itself fails; the call sites use
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
  if (count > 0) {
    try {
      ctx.db.get("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Best effort: the rows are committed; the WAL is checkpointed later (by the next sweep or on close).
    }
  }
  return count;
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
