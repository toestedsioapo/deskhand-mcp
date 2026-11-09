import type { AppContext } from "../app-context.js";
import { canonicalJson, planHash } from "../ledger/canonical.js";
import { getAction, type ActionRow } from "../ledger/actions.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow, last4 } from "../ledger/ids.js";
import { redactInput } from "../ledger/redact.js";
import { getPlanKind } from "./plan-kinds.js";

const MAX_ID_ATTEMPTS = 50;

function validate(plan: unknown): unknown {
  const k = typeof plan === "object" && plan !== null ? (plan as { kind?: unknown }).kind : undefined;
  const pk = typeof k === "string" ? getPlanKind(k) : undefined;
  if (!pk) throw new Error("unknown plan kind");
  return pk.schema.parse(plan);
}

/** Validates the plan, then writes the `actions` row and `plan_created` event in one transaction. */
export function createPlan(
  ctx: AppContext,
  args: { tool: string; input: unknown; plan: unknown },
): { actionId: string; planHash: string; expiresAt: string } {
  const plan = validate(args.plan);
  const planJson = canonicalJson(plan);
  const hash = planHash(plan);
  const createdAt = isoNow(ctx.clock);
  const expiresAt = new Date(ctx.clock().getTime() + ctx.config.planTtlHours * 3_600_000).toISOString();
  const inputJson = JSON.stringify(redactInput(args.input) ?? null);

  return ctx.db.transaction(() => {
    const live = new Set(
      ctx.db
        .all<{ id: string }>("SELECT id FROM actions WHERE status IN ('planned','approved')")
        .map((r) => last4(r.id)),
    );
    let id: string | undefined;
    for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
      const cand = ctx.ids.newActionId();
      if (!live.has(last4(cand)) && !getAction(ctx.db, cand)) {
        id = cand;
        break;
      }
    }
    if (id === undefined) throw new Error("could not generate a free action id");
    ctx.db.run(
      `INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'planned')`,
      [id, createdAt, args.tool, inputJson, planJson, hash, expiresAt],
    );
    appendEvent(ctx.db, {
      ts: createdAt,
      actionId: id,
      tool: args.tool,
      kind: "plan_created",
      outcome: "ok",
      preview: { v: 1, input: null, output: null, note: null, action_id: id },
    });
    return { actionId: id, planHash: hash, expiresAt };
  }, "immediate");
}

/** Planned actions, oldest first, expired ones included. */
export function listPending(ctx: AppContext): ActionRow[] {
  const ids = ctx.db.all<{ id: string }>(
    "SELECT id FROM actions WHERE status = 'planned' ORDER BY created_at ASC, id ASC",
  );
  return ids.map((r) => getAction(ctx.db, r.id)!);
}
