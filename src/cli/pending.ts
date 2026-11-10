import type { AppContext } from "../app-context.js";
import { listPending } from "../approval/plans.js";
import { renderDiff } from "../approval/plan-kinds.js";
import { appendEvent } from "../ledger/events.js";
import { isoNow } from "../ledger/ids.js";
import { stripControl, type CliIo } from "./io.js";

/** `deskhand pending`: planned actions, oldest first. Writes one `cli_command` row. */
export function pendingCommand(ctx: AppContext, io: CliIo): number {
  const rows = listPending(ctx);
  const nowMs = ctx.clock().getTime();
  if (rows.length === 0) io.out("No pending actions.\n");
  for (const a of rows) {
    // Fails closed like the apply gate: now >= expires_at, or unparseable, is expired.
    const expired = !(nowMs < Date.parse(a.expires_at));
    io.out(
      `${stripControl(a.id)}  ${stripControl(a.tool)}  expires ${stripControl(a.expires_at)}${expired ? " EXPIRED" : ""}  hash ${a.plan_hash.slice(0, 8)}\n`,
    );
    // A plan_json that does not parse is shown, never thrown on: the listing must still work.
    const diff = a.plan ? renderDiff(a.plan.value) : ["(invalid plan)"];
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
