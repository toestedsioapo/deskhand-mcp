import type { AppContext } from "../app-context.js";
import { AuthRequiredError, ProviderError } from "../providers/errors.js";
import type { CalendarProvider } from "../providers/types.js";
import { toolError, type ToolErrorResult } from "./result.js";

/** The configured provider, or the PROVIDER_NOT_CONFIGURED tool error to return as-is. */
export function requireProvider(ctx: AppContext): CalendarProvider | ToolErrorResult {
  if (ctx.provider === null) {
    return toolError("PROVIDER_NOT_CONFIGURED", "No calendar provider is configured (set DESKHAND_PROVIDER).");
  }
  return ctx.provider;
}

/**
 * Maps whatever a provider call threw to a tool error. Only the two provider
 * error types contribute their message; any other error's text is never shown.
 */
export function providerFailure(e: unknown, extra?: { action_id?: string }): ToolErrorResult {
  if (e instanceof AuthRequiredError) return toolError("AUTH_REQUIRED", e.message, extra);
  if (e instanceof ProviderError) return toolError("PROVIDER_ERROR", e.message, extra);
  return toolError("PROVIDER_ERROR", "Calendar provider call failed.", extra);
}
