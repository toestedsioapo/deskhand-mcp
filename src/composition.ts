import { resolveActor } from "./config/actor.js";
import type { AppContext } from "./app-context.js";
import { loadConfig, type Config } from "./config/env.js";
import { ensureDirs } from "./config/paths.js";
import { LedgerDb } from "./ledger/db.js";
import { createIdGenerator, type Clock } from "./ledger/ids.js";
import { createGoogleCalendarProvider } from "./providers/google/calendar.js";
import { createGmailProvider } from "./providers/google/gmail.js";
import { GOOGLE_ENDPOINTS } from "./providers/google/oauth.js";
import { createFixtureMailProvider, createFixtureProvider, loadFixtureWorld } from "./providers/fixture/index.js";
import type { CalendarProvider, MailProvider } from "./providers/types.js";

/**
 * The one place a provider is chosen (ADR 0008), shared by the server and the
 * CLI. No provider is the default: nothing is wired unless `DESKHAND_PROVIDER`
 * names it. With a fixture world loaded, time is the world's fixed `now`;
 * otherwise real time. A bad fixture file throws a ConfigError here.
 * `provider` and `mail` are both set or both null.
 */
export function selectProvider(config: Config): {
  provider: CalendarProvider | null;
  mail: MailProvider | null;
  clock: Clock;
} {
  if (config.provider === "fixture") {
    const world = loadFixtureWorld(config.fixturePath);
    const clock: Clock = config.fixturePath ? () => new Date(world.now) : () => new Date();
    return { provider: createFixtureProvider(world), mail: createFixtureMailProvider(world), clock };
  }
  if (config.provider === "google") {
    // No token is read here: a missing or expired sign-in surfaces as AUTH_REQUIRED on the first call.
    const now = (): Date => new Date();
    const deps = {
      fetch: globalThis.fetch,
      configDir: config.paths.configDir,
      now,
      oauth: { fetch: globalThis.fetch, endpoints: GOOGLE_ENDPOINTS, now },
    };
    return { provider: createGoogleCalendarProvider(deps), mail: createGmailProvider(deps), clock: now };
  }
  return { provider: null, mail: null, clock: () => new Date() };
}

/** Composition root for non-server entry points: builds the AppContext from the environment. The caller closes `db`. */
export function createAppContext(env: NodeJS.ProcessEnv = process.env): AppContext {
  const config = loadConfig(env);
  ensureDirs(config.paths);
  const { provider, mail, clock } = selectProvider(config);
  const db = LedgerDb.open(config.paths.ledgerPath, { busyTimeoutMs: config.busyTimeoutMs });
  return {
    config,
    db,
    clock,
    ids: createIdGenerator(),
    provider,
    mail,
    actor: resolveActor(),
  };
}
