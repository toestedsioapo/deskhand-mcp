import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temp DESKHAND_HOME so tests never touch the real user data dir. */
export function makeTempHome(): {
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "deskhand-test-"));
  const env: NodeJS.ProcessEnv = { ...process.env, DESKHAND_HOME: home };
  for (const k of Object.keys(env)) {
    if (k.startsWith("DESKHAND_")) delete env[k];
  }
  env["DESKHAND_HOME"] = home;
  // Diffs render in the viewer's zone: pin it so results do not depend on the machine (or CI runner) zone.
  env["DESKHAND_TIMEZONE"] = "UTC";
  return {
    home,
    env,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
