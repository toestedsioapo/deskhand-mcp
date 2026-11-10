#!/usr/bin/env node
import { main } from "./cli/index.js";

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`deskhand: ${message.replace(/\s+/g, " ").trim()}\n`);
  process.exitCode = 1;
});
