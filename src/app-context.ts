import type { Config } from "./config/env.js";
import type { LedgerDb } from "./ledger/db.js";
import type { Clock } from "./ledger/ids.js";
import type { CalendarProvider } from "./providers/types.js";

/** Everything a tool, the plan store or the apply engine needs, injected once. */
export interface AppContext {
  config: Config;
  db: LedgerDb;
  clock: Clock;
  ids: { newActionId(): string };
  provider: CalendarProvider;
  actor: string;
  /** Test seam, used only by the crash-retry test. */
  hooks?: { beforeCommit?: () => void };
}
