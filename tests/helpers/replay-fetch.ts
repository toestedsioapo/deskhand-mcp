import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../recorded/google/", import.meta.url));
const ALLOWED_HOSTS = ["www.googleapis.com", "oauth2.googleapis.com"];

interface Recording {
  name: string;
  method: string;
  url: URL;
  status: number;
  body: unknown;
  used: boolean;
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface Replay {
  fetch: typeof fetch;
  seen: SeenRequest[];
  /** Throws if any request broke a rule, matched nothing, or any recording went unused. */
  verify(): void;
}

const sameQuery = (a: URL, b: URL): boolean =>
  JSON.stringify([...a.searchParams.entries()].sort()) === JSON.stringify([...b.searchParams.entries()].sort());

/**
 * Serves tests/recorded/google/<name>.json in order of the names given: each
 * request takes the first unused recording with the same method, host, path
 * and query. Requests whose URL contains /send, or to any other host, are
 * violations.
 */
export function replayFetch(names: string[]): Replay {
  const recordings: Recording[] = names.map((name) => {
    const f = JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8")) as {
      request: { method: string; url: string };
      response: { status: number; body: unknown };
    };
    return { name, method: f.request.method, url: new URL(f.request.url), status: f.response.status, body: f.response.body, used: false };
  });
  const seen: SeenRequest[] = [];
  const violations: string[] = [];

  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    seen.push({ method, url: raw, headers, body: typeof init?.body === "string" ? init.body : undefined });
    if (raw.includes("/send")) violations.push(`forbidden send URL: ${url.origin}${url.pathname}`);
    if (!ALLOWED_HOSTS.includes(url.hostname)) {
      violations.push(`forbidden host: ${url.hostname}`);
      throw new Error("replay: forbidden host");
    }
    const hit = recordings.find(
      (r) => !r.used && r.method === method && r.url.origin === url.origin && r.url.pathname === url.pathname && sameQuery(r.url, url),
    );
    if (!hit) {
      violations.push(`unmatched request: ${method} ${url.origin}${url.pathname}${url.search}`);
      throw new Error("replay: unmatched request");
    }
    hit.used = true;
    return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return {
    fetch: fn,
    seen,
    verify() {
      const unused = recordings.filter((r) => !r.used).map((r) => `unused recording: ${r.name}`);
      const problems = [...violations, ...unused];
      if (problems.length > 0) throw new Error(problems.join("; "));
    },
  };
}
