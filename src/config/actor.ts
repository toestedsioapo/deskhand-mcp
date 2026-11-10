import { userInfo as osUserInfo } from "node:os";

export interface ActorDeps {
  userInfo: () => { username: string };
  env: NodeJS.ProcessEnv;
}

/**
 * The OS username recorded as `approved_by`. os.userInfo() throws when the
 * user has no passwd entry (for example some containers), so fall back to
 * USER, then USERNAME, then "unknown" instead of failing startup.
 */
export function resolveActor(deps: ActorDeps = { userInfo: osUserInfo, env: process.env }): string {
  try {
    const name = deps.userInfo().username;
    if (name) return name;
  } catch {
    // fall through to the environment
  }
  return deps.env["USER"] || deps.env["USERNAME"] || "unknown";
}
