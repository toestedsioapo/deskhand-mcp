import type { AppContext } from "../../src/app-context.js";
import { createIdGenerator } from "../../src/ledger/ids.js";
import { createFixtureProvider } from "../../src/providers/fixture/provider.js";
import type { FixtureWorld } from "../../src/providers/fixture/world.js";

export const SEED_NOW = "2026-11-10T09:00:00.000Z";

/** A small deterministic fixture world: one calendar with one event. */
export function makeWorld(overrides: Partial<FixtureWorld> = {}): FixtureWorld {
  return {
    fixture_version: 1,
    now: SEED_NOW,
    calendars: {
      primary: {
        events: [
          {
            id: "evt_standup",
            title: "Team standup",
            start: "2026-11-10T09:30:00.000Z",
            end: "2026-11-10T09:45:00.000Z",
            attendees: ["ana@example.com", "ben@example.com"],
            etag: "e1",
          },
        ],
      },
    },
    settings: { latency_ms: 0 },
    ...overrides,
  };
}

/** The non-ledger parts of an AppContext for tests that only need the old ServerDeps. */
export function makeProviderDeps(): Pick<AppContext, "ids" | "provider" | "actor"> {
  return {
    ids: createIdGenerator(),
    provider: createFixtureProvider(makeWorld()),
    actor: "tester",
  };
}
