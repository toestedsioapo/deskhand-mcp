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

/** A provider call failed. The message never holds a response body or headers. Maps to `PROVIDER_ERROR`. */
export class ProviderError extends Error {
  constructor(provider: string, op: string, detail: { status?: number; reason?: string; phrase?: string }) {
    let text: string;
    if (detail.status !== undefined) {
      const reason = detail.reason !== undefined && REASON.test(detail.reason) ? ` ${detail.reason}` : "";
      text = `HTTP ${detail.status}${reason}`;
    } else {
      text = detail.phrase ?? "unexpected failure";
    }
    super(`${provider} ${op} failed: ${text}`);
    this.name = "ProviderError";
  }
}
