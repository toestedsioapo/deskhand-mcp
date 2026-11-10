import type { AppContext } from "../app-context.js";
import { approveAction } from "../approval/approve.js";
import { oneLine, type CliIo } from "./io.js";

export const APPROVE_USAGE = "deskhand: usage: deskhand approve <action_id>\n";

/** True when argv after `approve` is exactly one non-empty id (there are no options, and no bypass flag). */
export function approveArgsValid(args: readonly string[]): boolean {
  return args.length === 1 && args[0] !== "";
}

/**
 * `deskhand approve <id>`. approveAction does the TTY gate, all checks, the
 * prompt and the single `cli_command` row; this layer only reports.
 * Exit codes: 0 approved, 1 refused, 2 usage.
 */
export async function approveCommand(ctx: AppContext, io: CliIo, args: readonly string[]): Promise<number> {
  if (!approveArgsValid(args)) {
    io.err(APPROVE_USAGE);
    return 2;
  }
  const id = args[0]!;
  const r = await approveAction(ctx, id, io);
  if (r.ok) {
    io.out(`Approved ${oneLine(id, 64)}.\n`);
    return 0;
  }
  io.err(`deskhand: ${r.errorCode}: ${oneLine(r.message, 500)}\n`);
  return 1;
}
