import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { applyAction } from "../approval/apply.js";
import { toolError, toolOk, type ToolErrorResult, type ToolOkResult } from "./result.js";

export const actionApplyInputSchema = z.object({ action_id: z.string().max(64) }).strict();

export const actionApplyOutputSchema = z.object({
  action_id: z.string(),
  status: z.literal("applied"),
  replayed: z.boolean(),
  result: z.unknown(),
});

export const ACTION_APPLY_DESCRIPTION =
  "Apply a planned action that a human has already approved out of band with the `deskhand approve` CLI. " +
  "Refuses unless writes are enabled (DESKHAND_ALLOW_WRITES=1) and the plan exists, is approved, unexpired, " +
  "unmodified since approval and still valid against the calendar. Idempotent: repeating it returns the stored result. " +
  "This tool cannot approve anything.";

type Output = z.infer<typeof actionApplyOutputSchema>;

export async function actionApplyHandler(
  ctx: AppContext,
  input: z.infer<typeof actionApplyInputSchema>,
): Promise<ToolOkResult<Output> | ToolErrorResult> {
  const r = await applyAction(ctx, input.action_id);
  if (!r.ok) return toolError(r.errorCode, r.message, { action_id: input.action_id });
  return toolOk(
    { action_id: input.action_id, status: "applied", replayed: r.replayed, result: r.result },
    { action_id: input.action_id },
  );
}
