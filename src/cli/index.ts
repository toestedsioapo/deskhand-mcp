import type { AppContext } from "../app-context.js";
import { assertSupportedNode } from "../config/node-check.js";
import { PACKAGE_VERSION } from "../config/version.js";
import { createCliContext } from "./context.js";
import { realCliIo, stripControl, type CliIo } from "./io.js";
import { pendingCommand } from "./pending.js";
import { rejectCommand } from "./reject.js";

export type { CliIo } from "./io.js";

/** Commands that are still stubs, with the milestone that implements them. */
const PLANNED: Record<string, string> = {
  approve: "M2",
  export: "M5",
  auth: "M3",
};

const HELP = `deskhand ${PACKAGE_VERSION}

Usage: deskhand <command> [options]

Commands:
  pending     list planned actions awaiting approval
  reject      reject a planned action: reject <action_id> [reason]
  approve     approve a planned action (not implemented yet, M2)
  export      export ledger data, e.g. expenses (not implemented yet, M5)
  auth        Google OAuth: login | status | upgrade (not implemented yet, M3)

Options:
  -h, --help     show this help
  --version      print the version
`;

const errMessage = (e: unknown): string =>
  stripControl(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();

/**
 * Runs the CLI and returns the process exit code. The context (and so the
 * ledger) is created only for commands that need it, and its database is
 * closed when the command ends. Help, --version and no args never call
 * `ctxFactory`.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  ctxFactory: () => AppContext = createCliContext,
): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  if (command === "--version") {
    io.out(`${PACKAGE_VERSION}\n`);
    return 0;
  }
  if (command === "pending" || command === "reject") {
    if (command === "reject" && (args[0] ?? "") === "") {
      io.err("deskhand: usage: deskhand reject <action_id> [reason]\n");
      return 2;
    }
    let ctx: AppContext | undefined;
    try {
      ctx = ctxFactory();
      return command === "pending" ? pendingCommand(ctx, io) : rejectCommand(ctx, io, args);
    } catch (error) {
      io.err(`deskhand: ${errMessage(error)}\n`);
      return 1;
    } finally {
      ctx?.db.close();
    }
  }
  const milestone = Object.hasOwn(PLANNED, command) ? PLANNED[command] : undefined;
  if (milestone) {
    io.err(`deskhand: '${command}' is not implemented yet (${milestone}).\n`);
    return 2;
  }
  io.err(`deskhand: unknown command '${stripControl(command)}'. Try 'deskhand --help'.\n`);
  return 2;
}

/** Node check + CLI run; reports an unsupported Node as a one-line error. */
export async function runMain(
  nodeVersion: string,
  argv: readonly string[],
  io: CliIo,
  ctxFactory?: () => AppContext,
): Promise<number> {
  try {
    assertSupportedNode(nodeVersion);
  } catch (error) {
    io.err(`deskhand: ${errMessage(error)}\n`);
    return 1;
  }
  return runCli(argv, io, ctxFactory);
}

export async function main(): Promise<void> {
  process.exitCode = await runMain(process.versions.node, process.argv.slice(2), realCliIo());
}
