import { ProviderError } from "../errors.js";
import type { MailProvider } from "../types.js";

/**
 * The fixture world's mailbox. Worlds have no mail yet (fixture format v2 adds it), so every call refuses with a
 * fixed, non-retryable ProviderError. No send method, by design.
 */
export function createFixtureMailProvider(): MailProvider {
  const refuse = (op: string): Promise<never> =>
    Promise.reject(new ProviderError("fixture mail", op, { phrase: "no mailbox in this world" }));
  return {
    profile: () => refuse("profile"),
    searchThreads: () => refuse("searchThreads"),
    getThread: () => refuse("getThread"),
    lookupDraft: () => refuse("lookupDraft"),
    createDraft: () => refuse("createDraft"),
  };
}
