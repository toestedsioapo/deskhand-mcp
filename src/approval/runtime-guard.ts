/**
 * Node options that let code run inside the `deskhand approve` process before
 * (or around) its own: preloads, loaders and the inspector. A one-line preload
 * can fake a TTY and type the confirmation, so `approve` refuses to run under
 * any of them (UNTRUSTED_RUNTIME).
 *
 * This only stops the trivial one-liner. A program that runs as the same user
 * can still import `dist/approval/approve.js`, drive a real pty, or write the
 * SQLite file; see docs/SECURITY.md ("Limits").
 */
const EXACT = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);

/** The flag name of one token (`--import=x` -> `--import`; `--experimental_loader` -> `--experimental-loader`), or null for a value. */
function flagName(token: string): string | null {
  if (!token.startsWith("-")) return null;
  const name = token.split("=", 1)[0]!;
  // Node treats `_` and `-` alike inside long option names.
  return name.startsWith("--") ? name.replace(/_/g, "-") : name;
}

/**
 * The first untrusted flag found in `execArgv` (`process.execArgv`) or
 * `NODE_OPTIONS` (split on whitespace), or null when the runtime is clean.
 */
export function untrustedRuntimeFlag(execArgv: readonly string[], nodeOptions: string | undefined): string | null {
  const tokens = [...execArgv, ...(nodeOptions ?? "").split(/\s+/)];
  for (const token of tokens) {
    const name = flagName(token);
    if (name === null) continue;
    if (EXACT.has(name)) return name;
    if (name.startsWith("--inspect")) return name;
  }
  return null;
}
