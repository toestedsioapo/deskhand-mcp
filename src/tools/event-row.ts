import { z } from "zod";
import { ERROR_CODES, EVENT_KINDS, EVENT_OUTCOMES } from "../ledger/contract.js";

/** Shared output type (docs/tools-contract.md, "EventRow"). `preview` is the stored, redacted preview. */
export const eventRowSchema = z.object({
  id: z.number().int(),
  ts: z.string(),
  action_id: z.string().nullable(),
  tool: z.string(),
  kind: z.enum(EVENT_KINDS),
  outcome: z.enum(EVENT_OUTCOMES),
  error_code: z.enum(ERROR_CODES).nullable(),
  preview: z.unknown(),
});
