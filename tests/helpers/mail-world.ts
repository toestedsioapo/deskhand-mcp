import { createFixtureMailProvider } from "../../src/providers/fixture/index.js";
import type { FixtureMessage, FixtureWorld } from "../../src/providers/fixture/world.js";
import type { setupHarness } from "./harness.js";
import { makeWorld } from "./seed.js";

export const msg = (id: string, date: string, over: Partial<FixtureMessage> = {}): FixtureMessage => ({
  id,
  date,
  from: { address: "ana@example.com", name: "Ana Lopez" },
  to: [{ address: "me@example.com" }],
  subject: "Q4 budget",
  body_text: "Please review the numbers",
  ...over,
});

export interface Thread {
  id: string;
  messages: FixtureMessage[];
}

export function mailWorld(threads: Thread[]): FixtureWorld {
  return makeWorld({ fixture_version: 2, mail: { owner: "me@example.com", threads } });
}

/** Swaps the harness's mailbox for one built from `threads` (the server reads ctx.mail on every call). */
export function useMail(h: Awaited<ReturnType<typeof setupHarness>>, threads: Thread[]): void {
  h.ctx.mail = createFixtureMailProvider(mailWorld(threads));
}
