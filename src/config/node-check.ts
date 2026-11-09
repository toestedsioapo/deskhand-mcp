const MIN_MAJOR = 24;
const MIN_MINOR = 15;

/** Throws if `version` (e.g. "24.11.1", no leading "v") is below Node 24.15. */
export function assertSupportedNode(version: string): void {
  const [major = 0, minor = 0] = version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const ok = major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
  if (!ok) {
    throw new Error(
      `this package requires Node >=${MIN_MAJOR}.${MIN_MINOR} (found ${version}).`,
    );
  }
}
