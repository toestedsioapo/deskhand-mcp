import { userInfo } from "node:os";
import type { AppContext } from "./app-context.js";
import { loadConfig } from "./config/env.js";
import { ensureDirs } from "./config/paths.js";
import { LedgerDb } from "./ledger/db.js";
import { createIdGenerator, type Clock } from "./ledger/ids.js";
import { createFixtureProvider, loadFixtureWorld } from "./providers/fixture/index.js";

/** Composition root for non-server entry points: builds the AppContext (fixture provider) from the environment. The caller closes `db`. */
export function createAppContext(env: NodeJS.ProcessEnv = process.env): AppContext {
  const config = loadConfig(env);
  ensureDirs(config.paths);
  const world = loadFixtureWorld(config.fixturePath);
  const db = LedgerDb.open(config.paths.ledgerPath, { busyTimeoutMs: config.busyTimeoutMs });
  const clock: Clock = config.fixturePath ? () => new Date(world.now) : () => new Date();
  return {
    config,
    db,
    clock,
    ids: createIdGenerator(),
    provider: createFixtureProvider(world),
    actor: userInfo().username,
  };
}
