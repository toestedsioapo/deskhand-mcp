import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Builds dist/ once before the suite so stdio tests run the real bin. */
export default function setup(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const tsc = fileURLToPath(
    new URL("../node_modules/typescript/bin/tsc", import.meta.url),
  );
  const result = spawnSync(process.execPath, [tsc, "-p", "."], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tsc build failed:\n${result.stdout}\n${result.stderr}`);
  }
}
