import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/env.js";
import { loadOAuthClient } from "../src/providers/google/client-file.js";

const SECRET = "GOCSPX-super-secret-value";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskhand-client-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(content: string): string {
  writeFileSync(join(dir, "client_secret.json"), content);
  return join(dir, "client_secret.json");
}
function errorOf(): ConfigError {
  try {
    loadOAuthClient(dir);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return e as ConfigError;
  }
  throw new Error("expected throw");
}

describe("loadOAuthClient", () => {
  it("reads a Desktop-app client", () => {
    put(JSON.stringify({ installed: { client_id: "id.apps", client_secret: SECRET, auth_uri: "x" } }));
    expect(loadOAuthClient(dir)).toEqual({ clientId: "id.apps", clientSecret: SECRET });
  });
  it("missing file names the full path and the setup guide", () => {
    const e = errorOf();
    expect(e.message).toContain(join(dir, "client_secret.json"));
    expect(e.message).toContain("docs/google-oauth-setup.md");
  });
  it("a web client says to create a Desktop app client", () => {
    put(JSON.stringify({ web: { client_id: "a", client_secret: SECRET } }));
    const e = errorOf();
    expect(e.message).toContain('create a "Desktop app" client');
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toContain("\n");
  });
  it("a service-account key gives a one-line error", () => {
    put(JSON.stringify({ type: "service_account", private_key: SECRET, client_email: "a@b" }));
    const e = errorOf();
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toContain("\n");
    expect(e.message).toContain("service");
  });
  it("non-JSON gives a one-line error without content", () => {
    put(`not json ${SECRET}`);
    const e = errorOf();
    expect(e.message).not.toContain(SECRET);
    expect(e.message).not.toContain("\n");
  });
  it("installed without client_id/secret is rejected without echoing", () => {
    put(JSON.stringify({ installed: { client_id: "x", client_secret: 5 } }));
    const e = errorOf();
    expect(e.message).not.toContain("\n");
  });
});
