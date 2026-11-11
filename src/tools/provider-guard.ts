import type { AppContext } from "../app-context.js";
import type { CalendarProvider } from "../providers/types.js";
import { toolError, type ToolErrorResult } from "./result.js";

/** The configured provider, or the PROVIDER_NOT_CONFIGURED tool error to return as-is. */
export function requireProvider(ctx: AppContext): CalendarProvider | ToolErrorResult {
  if (ctx.provider === null) {
    return toolError("PROVIDER_NOT_CONFIGURED", "No calendar provider is configured (set DESKHAND_PROVIDER).");
  }
  return ctx.provider;
}
