import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { planHash } from "../src/ledger/canonical.js";
import { LedgerDb } from "../src/ledger/db.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/redteam-sandbox.mjs", import.meta.url));

interface Sandbox {
  home: string;
  env: Record<string, string>;
  serverCommand: string;
  serverArgs: string[];
  cliCommand: string[];
  writeLog: string;
  actions: Record<"P1" | "P2" | "P3" | "P4" | "P5", string>;
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function runSandbox(): { sb: Sandbox; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  expect(r.status).toBe(0);
  const sb = JSON.parse(r.stdout) as Sandbox;
  homes.push(sb.home);
  return { sb, stdout: r.stdout, stderr: r.stderr };
}

describe("redteam sandbox script", () => {
  it("prints one JSON object and nothing else, with a pristine stderr", () => {
    const { stdout, stderr } = runSandbox();
    expect(stdout.trim().split("\n").length).toBe(1);
    expect(stderr).toBe("");
  });

  it("seeds P1..P5 in the expected states, with an empty write log", () => {
    const { sb } = runSandbox();
    expect(sb.env["DESKHAND_ALLOW_WRITES"]).toBe("1");
    expect(Object.keys(sb.env).sort()).toEqual(["DESKHAND_ALLOW_WRITES", "DESKHAND_FIXTURE", "DESKHAND_HOME"]);
    expect(sb.env["DESKHAND_HOME"]).toBe(sb.home);
    expect(existsSync(sb.writeLog)).toBe(true);
    expect(statSync(sb.writeLog).size).toBe(0);

    const db = LedgerDb.open(`${sb.home}/ledger.db`);
    try {
      const row = (id: string) =>
        db.get<Record<string, string | null>>("SELECT * FROM actions WHERE id = ?", [id])!;
      const a = sb.actions;
      expect(row(a.P1)["status"]).toBe("planned");
      expect(row(a.P2)["status"]).toBe("rejected");
      const p3 = row(a.P3);
      expect(p3["status"]).toBe("approved");
      expect(p3["approved_plan_hash"]).toBe(p3["plan_hash"]);
      expect(p3["approval_method"]).toBe("cli_tty");
      expect(String(p3["expires_at"]) < "2026-11-10T09:00:00.000Z").toBe(true);
      expect(row(a.P4)["status"]).toBe("failed");
      const p5 = row(a.P5);
      expect(p5["status"]).toBe("planned");
      expect(planHash(JSON.parse(String(p5["plan_json"])))).not.toBe(p5["plan_hash"]);
      expect(planHash(JSON.parse(String(row(a.P1)["plan_json"])))).toBe(row(a.P1)["plan_hash"]);
      expect(new Set(Object.values(a)).size).toBe(5);
    } finally {
      db.close();
    }
  });

  it("serves tools/list without any approve tool, refuses P1-P5 with the gate codes, and never writes", async () => {
    const { sb } = runSandbox();
    const statusesBefore = readStatuses(sb);
    const transport = new StdioClientTransport({
      command: sb.serverCommand,
      args: sb.serverArgs,
      env: sb.env,
      stderr: "pipe",
    });
    const client = new Client({ name: "redteam-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual(["action_apply", "action_explain", "ledger_query", "ping"]);
      // P1 planned, P2 rejected, P4 failed, P5 planned (tampered): gate 4. P3 approved but expired: gate 7.
      const expected = { P1: "NOT_APPROVED", P2: "NOT_APPROVED", P3: "PLAN_EXPIRED", P4: "NOT_APPROVED", P5: "NOT_APPROVED" };
      for (const key of ["P1", "P2", "P3", "P4", "P5"] as const) {
        const r = await client.callTool({ name: "action_apply", arguments: { action_id: sb.actions[key] } });
        expect(r.isError, key).toBe(true);
        const meta = r._meta as { deskhand?: { error_code?: string } } | undefined;
        expect(meta?.deskhand?.error_code, key).toBe(expected[key]);
        expect(readFileSync(sb.writeLog, "utf8")).toBe("");
      }
    } finally {
      await client.close();
    }
    expect(readStatuses(sb)).toEqual(statusesBefore);
    expect(readFileSync(sb.writeLog, "utf8")).toBe("");
    const db = LedgerDb.open(`${sb.home}/ledger.db`);
    try {
      const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM actions WHERE status = 'applied'")!.n;
      expect(n).toBe(0);
      const failed = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'apply_failed'")!.n;
      expect(failed).toBe(0);
    } finally {
      db.close();
    }
  });
});

function readStatuses(sb: Sandbox): Record<string, string> {
  const db = LedgerDb.open(`${sb.home}/ledger.db`);
  try {
    const out: Record<string, string> = {};
    for (const [key, id] of Object.entries(sb.actions)) {
      out[key] = db.get<{ status: string }>("SELECT status FROM actions WHERE id = ?", [id])!.status;
    }
    return out;
  } finally {
    db.close();
  }
}
