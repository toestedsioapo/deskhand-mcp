import { ProviderError } from "../errors.js";
import type { MailProvider } from "../types.js";

/**
 * Gmail is not wired yet (M4b): every call refuses with a fixed, non-retryable ProviderError and makes no request.
 * It exists so that `selectProvider` sets both providers or neither. No send method, by design.
 */
export function createGoogleMailProvider(): MailProvider {
  const refuse = (op: string): Promise<never> =>
    Promise.reject(new ProviderError("google mail", op, { phrase: "mail is not available for this provider yet" }));
  return {
    profile: () => refuse("profile"),
    searchThreads: () => refuse("searchThreads"),
    getThread: () => refuse("getThread"),
    threadMessageIds: () => refuse("threadMessageIds"),
    lookupDraft: () => refuse("lookupDraft"),
    createDraft: () => refuse("createDraft"),
  };
}
