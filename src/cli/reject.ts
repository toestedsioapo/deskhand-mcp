import type { AppContext } from "../app-context.js";
import { rejectAction } from "../approval/approve.js";
import { stripControl, type CliIo } from "./io.js";

/**
 * `deskhand reject <id> [reason...]`. rejectAction writes the command's single
 * `cli_command` row (after its own transaction); this layer writes none.
 */
export function rejectCommand(ctx: AppContext, io: CliIo, args: readonly string[]): number {
  const [rawId, ...rest] = args;
  if (rawId === undefined || rawId === "") {
    io.err("deskhand: usage: deskhand reject <action_id> [reason]\n");
    return 2;
  }
  const reason = stripControl(rest.join(" ")).trim();
  const method = io.stdinIsTTY && io.stdoutIsTTY ? "cli_tty" : "cli_no_tty";
  const r = rejectAction(ctx, rawId, reason === "" ? undefined : reason, method);
  if (r.ok) {
    io.out(`Rejected ${stripControl(rawId)}.\n`);
    return 0;
  }
  io.err(`deskhand: ${r.errorCode}: ${stripControl(r.message)}\n`);
  return 1;
}
