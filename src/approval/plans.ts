import type { AppContext } from "../app-context.js";
import { canonicalJson, planHash } from "../ledger/canonical.js";
import { getAction } from "../ledger/actions.js";
import { appendEvent } from "../ledger/events.js";
import { last4 } from "../ledger/ids.js";
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
  // One clock read, so expires_at is exactly created_at + ttl.
  const now = ctx.clock();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ctx.config.planTtlHours * 3_600_000).toISOString();
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

/** A planned action as `deskhand pending` shows it; `plan` is undefined when plan_json does not parse. */
export interface PendingRow {
  id: string;
  created_at: string;
  tool: string;
  plan_hash: string;
  expires_at: string;
  plan: { value: unknown } | undefined;
}

/**
 * Planned actions, oldest first, expired ones included. Reads raw rows, so a
 * corrupt plan_json never throws here (it shows as an invalid plan).
 */
export function listPending(ctx: AppContext): PendingRow[] {
  const rows = ctx.db.all<Omit<PendingRow, "plan"> & { plan_json: string }>(
    "SELECT id, created_at, tool, plan_hash, expires_at, plan_json FROM actions WHERE status = 'planned' ORDER BY created_at ASC, id ASC",
  );
  return rows.map(({ plan_json, ...r }) => {
    let plan: PendingRow["plan"];
    try {
      plan = { value: JSON.parse(plan_json) as unknown };
    } catch {
      plan = undefined;
    }
    return { ...r, plan };
  });
}
