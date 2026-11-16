import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface RedirectPair {
  /** Answers every request with `status` and `Location: <target>/landing`. */
  redirectUrl: string;
  /** Every request that reached the redirect target. */
  landed: Received[];
  close: () => Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function shut(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Two loopback servers: one that redirects (307/308 keep the method and body) and the target it points at. */
export async function startRedirectPair(status: 301 | 302 | 303 | 307 | 308 = 307): Promise<RedirectPair> {
  const landed: Received[] = [];
  const target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      landed.push({ method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ access_token: "ya29.attacker", expires_in: 3600, items: [] }));
    });
  });
  const targetBase = await listen(target);
  const redirector = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { location: `${targetBase}/landing`, connection: "close" });
      res.end();
    });
  });
  const redirectBase = await listen(redirector);
  return {
    redirectUrl: `${redirectBase}/start`,
    landed,
    close: async () => {
      await Promise.all([shut(redirector), shut(target)]);
    },
  };
}
