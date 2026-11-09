import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { LedgerDb } from "../src/ledger/db.js";
import { createServer } from "../src/server.js";
import { makeTempHome } from "./helpers/home.js";

let home: ReturnType<typeof makeTempHome>;
let db: LedgerDb;
beforeEach(() => {
  home = makeTempHome();
  db = LedgerDb.open(join(home.home, "ledger.db"));
});
afterEach(() => {
  db.close();
  home.cleanup();
});

describe("createServer with a ledger", () => {
  it("lists exactly ping, with the M1 tools/list JSON unchanged", async () => {
    const server = createServer({ config: loadConfig(home.env), db, clock: () => new Date() });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "deskhand-test", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(["ping", "ledger_query", "action_explain"]);
      // Snapshot first recorded against the M1 createServer: ping's listing must not change.
      expect({ ...list, tools: list.tools.filter((t) => t.name === "ping") }).toMatchSnapshot();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
