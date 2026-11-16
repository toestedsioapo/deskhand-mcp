import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface TokenRequest {
  body: URLSearchParams;
}

export interface FakeOAuth {
  tokenUrl: string;
  requests: TokenRequest[];
  /** Replace how the fake token endpoint answers. */
  respond: (handler: (req: TokenRequest, res: ServerResponse) => void) => void;
  close: () => Promise<void>;
}

export function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
}

/** A local node:http server on 127.0.0.1 playing Google's token endpoint. */
export async function startFakeOAuth(): Promise<FakeOAuth> {
  const requests: TokenRequest[] = [];
  let handler: (req: TokenRequest, res: ServerResponse) => void = (_req, res) =>
    jsonReply(res, 200, {
      access_token: "ya29.access",
      refresh_token: "1//refresh",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/calendar.readonly",
      token_type: "Bearer",
    });
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const tr = { body: new URLSearchParams(Buffer.concat(chunks).toString("utf8")) };
      requests.push(tr);
      handler(tr, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    tokenUrl: `http://127.0.0.1:${port}/token`,
    requests,
    respond: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
