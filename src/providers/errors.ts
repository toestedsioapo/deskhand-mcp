/**
 * Errors a calendar provider may throw. Adapters throw only these two; the
 * apply engine and the calendar tools map them to ledger error codes and never
 * show any other error's text.
 */

/** The user must sign in (again). Maps to `AUTH_REQUIRED`. */
export class AuthRequiredError extends Error {
  /** `message` is a fixed sentence naming the command to run; it must never carry response text. */
  constructor(message = "Google sign-in is required. Run: deskhand auth login") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

const REASON = /^[A-Za-z]{1,40}$/;

/** Fixed phrase: an event under the action's id existed and was deleted (Google keeps it as `status: cancelled`). */
export const EVENT_DELETED = "an event with this action's id was created and later deleted";

/** A provider call failed. The message never holds a response body or headers. Maps to `PROVIDER_ERROR`. */
export class ProviderError extends Error {
  /**
   * True when the provider may not have seen or finished the request, so its outcome is unknown and trying again
   * is safe and may succeed: a timeout, a network error, HTTP 429 or any 5xx. False for a definite answer (any other
   * status, or a fixed phrase not marked retryable). The apply engine keeps a plan `approved` after a retryable
   * write failure and marks it `failed` only after a definite one.
   */
  readonly retryable: boolean;

  constructor(
    provider: string,
    op: string,
    detail: { status?: number; reason?: string; phrase?: string; retryable?: boolean },
  ) {
    let text: string;
    if (detail.status !== undefined) {
      const reason = detail.reason !== undefined && REASON.test(detail.reason) ? ` ${detail.reason}` : "";
      text = `HTTP ${detail.status}${reason}`;
    } else {
      text = detail.phrase ?? "unexpected failure";
    }
    super(`${provider} ${op} failed: ${text}`);
    this.name = "ProviderError";
    const status = detail.status;
    this.retryable = detail.retryable ?? (status !== undefined && (status === 429 || status >= 500));
  }
}
