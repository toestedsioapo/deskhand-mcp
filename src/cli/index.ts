import { assertSupportedNode } from "../config/node-check.js";
import { PACKAGE_VERSION } from "../config/version.js";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const PLANNED: Record<string, string> = {
  pending: "M2",
  approve: "M2",
  reject: "M2",
  export: "M5",
  auth: "M3",
};

const HELP = `deskhand ${PACKAGE_VERSION}

Usage: deskhand <command> [options]

Commands (not implemented yet, planned for M2/M3/M5):
  pending     list planned actions awaiting approval (M2)
  approve     approve a planned action (M2)
  reject      reject a planned action (M2)
  export      export ledger data, e.g. expenses (M5)
  auth        Google OAuth: login | status | upgrade (M3)

Options:
  -h, --help     show this help
  --version      print the version
`;

/** Runs the CLI and returns the process exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  if (command === "--version") {
    io.out(`${PACKAGE_VERSION}\n`);
    return 0;
  }
  const milestone = Object.hasOwn(PLANNED, command)
    ? PLANNED[command]
    : undefined;
  if (milestone) {
    io.err(`deskhand: '${command}' is not implemented yet (${milestone}).\n`);
    return 2;
  }
  io.err(`deskhand: unknown command '${command}'. Try 'deskhand --help'.\n`);
  return 2;
}

export function main(): void {
  assertSupportedNode(process.versions.node);
  process.exitCode = runCli(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
