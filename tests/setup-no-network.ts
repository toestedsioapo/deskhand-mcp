/**
 * Test setup: no live network. Every fetch except loopback (the fake OAuth
 * server and the simulated browser callback) throws. Real I/O is never
 * reachable by accident, whatever a test forgets to inject.
 */
const realFetch = globalThis.fetch;

function hostOf(input: string | URL | Request): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw).hostname;
  } catch {
    return "";
  }
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const host = hostOf(input);
  if (host === "127.0.0.1" || host === "localhost") return realFetch(input, init);
  throw new Error("network access is forbidden in tests");
}) as typeof fetch;
