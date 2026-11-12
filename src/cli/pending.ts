import type { AppContext } from "../app-context.js";
import { listPending } from "../approval/plans.js";
import { renderDiff } from "../approval/plan-kinds.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow } from "../ledger/ids.js";
import { oneLine, stripControl, type CliIo } from "./io.js";

/** `deskhand pending`: planned actions, oldest first. Writes one `cli_command` row. */
export function pendingCommand(ctx: AppContext, io: CliIo): number {
  const rows = listPending(ctx);
  const nowMs = ctx.clock().getTime();
  if (rows.length === 0) io.out("No pending actions.\n");
  for (const a of rows) {
    // Fails closed like the apply gate: now >= expires_at, or unparseable, is expired.
    const expired = !(nowMs < Date.parse(a.expires_at));
    // Every column is a database value: each is flattened to one line, and the hash is shown only if it is one.
    const hash = /^[0-9a-f]{64}$/.test(a.plan_hash) ? a.plan_hash.slice(0, 8) : "(invalid)";
    io.out(
      `${oneLine(a.id, 64)}  ${oneLine(a.tool, 80)}  expires ${oneLine(a.expires_at, 40)}${expired ? " EXPIRED" : ""}  hash ${hash}\n`,
    );
    // A plan_json that does not parse is shown, never thrown on: the listing must still work.
    const diff = a.plan ? renderDiff(a.plan.value, ctx.config.timeZone) : ["(invalid plan)"];
    for (const line of diff) {
      for (const part of stripControl(line).split("\n")) io.out(`    ${part}\n`);
    }
  }
  appendEvent(ctx.db, {
    ts: isoNow(ctx.clock),
    tool: "cli:pending",
    kind: "cli_command",
    outcome: "ok",
    preview: { v: 1, input: {}, output: { count: rows.length }, note: null },
  });
  return 0;
}
