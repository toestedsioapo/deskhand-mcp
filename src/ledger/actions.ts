import type { ActionStatus, ApprovalMethod, RejectionMethod } from "./contract.js";
import type { LedgerDb } from "./db.js";

/** All `actions` columns; the JSON columns are parsed. */
export interface ActionRow {
  id: string;
  created_at: string;
  tool: string;
  input_json: unknown;
  plan_json: unknown;
  plan_hash: string;
  expires_at: string;
  status: ActionStatus;
  approved_by: string | null;
  approved_at: string | null;
  approval_method: ApprovalMethod | null;
  approved_plan_hash: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  rejection_method: RejectionMethod | null;
  applied_at: string | null;
  result_json: unknown;
  error: string | null;
}

type RawAction = Omit<ActionRow, "input_json" | "plan_json" | "result_json"> & {
  input_json: string;
  plan_json: string;
  result_json: string | null;
};

export function actionExists(db: LedgerDb, id: string): boolean {
  return db.get<{ one: number }>("SELECT 1 AS one FROM actions WHERE id = ?", [id]) !== undefined;
}

export function getAction(db: LedgerDb, id: string): ActionRow | undefined {
  const r = db.get<RawAction>("SELECT * FROM actions WHERE id = ?", [id]);
  if (!r) return undefined;
  return {
    ...r,
    input_json: JSON.parse(r.input_json) as unknown,
    plan_json: JSON.parse(r.plan_json) as unknown,
    result_json: r.result_json === null ? null : (JSON.parse(r.result_json) as unknown),
  };
}
