#!/usr/bin/env node
// Red-team sandbox for Deskhand (M2b, plan shape updated in M3a). Run after `pnpm build`.
// Creates a throwaway DESKHAND_HOME with a fixture world (settings.write_log) and five
// seeded actions, then prints ONE JSON object on stdout and nothing else.
// Uses only the built dist/ modules (no devDependencies, nothing from tests/).
// Goal for the reviewer: get a line into `writeLog`, or any of P1-P5 to become `applied`,
// without a valid human approval. Cleanup: delete the `home` directory printed below.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = (p) => pathToFileURL(fileURLToPath(new URL(`../dist/${p}`, import.meta.url))).href;
const distPath = (p) => fileURLToPath(new URL(`../dist/${p}`, import.meta.url));

const NOW = "2026-11-10T09:00:00.000Z";

const home = mkdtempSync(join(tmpdir(), "deskhand-redteam-"));
const fixturePath = join(home, "fixture.json");
const writeLog = join(home, "writes.jsonl");

writeFileSync(
  fixturePath,
  JSON.stringify(
    {
      fixture_version: 1,
      now: NOW,
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
      settings: { latency_ms: 0, write_log: writeLog },
    },
    null,
    2,
  ),
);
writeFileSync(writeLog, ""); // exists and empty; the provider appends one line per write

const env = {
  DESKHAND_HOME: home,
  DESKHAND_FIXTURE: fixturePath,
  DESKHAND_ALLOW_WRITES: "1",
  DESKHAND_PROVIDER: "fixture",
};

const { createAppContext } = await import(dist("composition.js"));
const { createPlan } = await import(dist("approval/plans.js"));
const { rejectAction } = await import(dist("approval/approve.js"));

// `zone` gives the M3a plan shape (event.timeZone plus a third attendee) so the
// approve diff shows the `event zone:` line and every address.
function plan(title, day, zone) {
  return {
    kind: "calendar.create_event",
    rationale: `Red-team sandbox plan ${title}`,
    event: {
      title,
      start: `2026-11-${day}T10:00:00.000Z`,
      end: `2026-11-${day}T10:30:00.000Z`,
      attendees: zone ? ["a@example.com", "b@example.com", "c@example.com"] : ["a@example.com", "b@example.com"],
      sendUpdates: "all",
      calendarId: "primary",
      ...(zone ? { timeZone: zone } : {}),
    },
    observed: { slotFree: true, etags: { evt_standup: "e1" } },
  };
}

const ctx = createAppContext(env);
const actions = {};
try {
  const make = (title, day, zone) =>
    createPlan(ctx, { tool: "calendar_propose_event", input: { title }, plan: plan(title, day, zone) });

  actions.P1 = make("P1 planned", "12", "Europe/Berlin").actionId;

  actions.P2 = make("P2 rejected", "13").actionId;
  const rej = rejectAction(ctx, actions.P2, "sandbox seed", "cli_no_tty");
  if (!rej.ok) throw new Error(`could not seed P2: ${rej.message}`);

  // P3: approved (as the real approve path writes it) but already expired.
  const p3 = make("P3 approved but expired", "14");
  actions.P3 = p3.actionId;
  ctx.db.run(
    `UPDATE actions SET status = 'approved', approved_by = ?, approved_at = ?, approval_method = 'cli_tty',
       approved_plan_hash = plan_hash, expires_at = ? WHERE id = ?`,
    [ctx.actor, "2026-11-09T08:00:00.000Z", "2026-11-09T09:00:00.000Z", actions.P3],
  );

  // P4: failed after approval.
  actions.P4 = make("P4 failed", "15").actionId;
  ctx.db.run(
    `UPDATE actions SET status = 'failed', approved_by = ?, approved_at = ?, approval_method = 'cli_tty',
       approved_plan_hash = plan_hash, error = 'sandbox seeded failure' WHERE id = ?`,
    [ctx.actor, NOW, actions.P4],
  );

  // P5: still planned, but plan_json was edited after planning (hash no longer matches).
  const p5 = make("P5 planned then tampered", "16");
  actions.P5 = p5.actionId;
  const row = ctx.db.get("SELECT plan_json FROM actions WHERE id = ?", [actions.P5]);
  const edited = JSON.parse(row.plan_json);
  edited.event.title = "P5 TAMPERED title";
  ctx.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [JSON.stringify(edited), actions.P5]);
} finally {
  ctx.db.close();
}

process.stdout.write(
  `${JSON.stringify({
    home,
    env,
    serverCommand: process.execPath,
    serverArgs: [distPath("server.js")],
    cliCommand: [process.execPath, distPath("cli.js")],
    writeLog,
    actions,
  })}\n`,
);
