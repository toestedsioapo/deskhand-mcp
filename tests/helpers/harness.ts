import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/config/env.js";
import { LedgerDb } from "../../src/ledger/db.js";
import { LoggingTransport } from "../../src/ledger/logging-transport.js";
import { createServer } from "../../src/server.js";
import type { AppContext } from "../../src/app-context.js";
import { createIdGenerator } from "../../src/ledger/ids.js";
import { createFixtureProvider } from "../../src/providers/fixture/provider.js";
import { makeTempHome } from "./home.js";
import { makeWorld } from "./seed.js";

export const NOW = "2026-11-10T09:30:00.123Z";

export interface RawRow {
  id: number;
  ts: string;
  action_id: string | null;
  tool: string;
  kind: string;
  outcome: string;
  error_code: string | null;
  preview_json: string;
}

/**
 * A real server + real SDK client over an in-memory pair, logging through the
 * LoggingTransport into a temp ledger. The client has listed tools, so output
 * schemas are known and enforced client-side.
 */
export async function setupHarness(opts: { env?: NodeJS.ProcessEnv } = {}) {
  const home = makeTempHome();
  const db = LedgerDb.open(join(home.home, "ledger.db"));
  const clock = () => new Date(NOW);
  const provider = createFixtureProvider(makeWorld());
  const ctx: AppContext = {
    config: loadConfig({ ...home.env, ...opts.env }),
    db,
    clock,
    ids: createIdGenerator(),
    provider,
    actor: "tester",
  };
  const server = createServer(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const logging = new LoggingTransport(serverSide, { db, clock, stderr: () => undefined });
  await server.connect(logging);
  const client = new Client({ name: "deskhand-test", version: "0.0.0" });
  await client.connect(clientSide);
  await client.listTools();
  return {
    db,
    ctx,
    provider,
    client,
    logging,
    rows: () => db.all<RawRow>("SELECT * FROM events ORDER BY id"),
    async close() {
      await client.close();
      await server.close();
      await logging.whenIdle();
      db.close();
      home.cleanup();
    },
  };
}

export function insertAction(db: LedgerDb, id: string, plan: unknown = {}, status = "planned"): void {
  db.run(
    "INSERT INTO actions (id, created_at, tool, input_json, plan_json, plan_hash, expires_at, status) VALUES (?,?,?,?,?,?,?,?)",
    [id, NOW, "calendar_plan", "{}", JSON.stringify(plan), "hash1", "2026-11-11T09:30:00.123Z", status],
  );
}
