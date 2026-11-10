#!/usr/bin/env node
import { main } from "./cli/index.js";
import { oneLine } from "./cli/io.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`deskhand: ${oneLine(message, 500)}\n`);
  process.exitCode = 1;
});
