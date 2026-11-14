import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config/env.js";
import { readToken, tokenPath, writeToken, type StoredToken } from "../src/providers/google/token-store.js";

const tok: StoredToken = {
  version: 1,
  client_id: "id.apps",
  scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  refresh_token: "REFRESH-SECRET",
  access_token: "ACCESS-SECRET",
  expires_at: "2026-11-11T10:00:00.000Z",
  obtained_at: "2026-11-11T09:00:00.000Z",
};
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskhand-token-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("token store", () => {
  it("tokenPath is <configDir>/token.json", () => {
    expect(tokenPath(dir)).toBe(join(dir, "token.json"));
  });
  it("round trips", () => {
    writeToken(dir, tok);
    expect(readToken(dir)).toEqual(tok);
  });
  it("missing gives null", () => {
    expect(readToken(dir)).toBeNull();
  });
  it.each([["not json REFRESH-SECRET"], [JSON.stringify({ version: 1, refresh_token: "REFRESH-SECRET" })], [JSON.stringify({ ...tok, version: 2 })]])(
    "malformed gives ConfigError without echoing content",
    (content) => {
      writeFileSync(tokenPath(dir), content);
      try {
        readToken(dir);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as Error).message).not.toContain("REFRESH-SECRET");
      }
    },
  );
  it.skipIf(process.platform === "win32")("file mode is 0600 on POSIX", () => {
    writeToken(dir, tok);
    expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600);
  });
  it("overwrite replaces and leaves no temp file", () => {
    writeToken(dir, tok);
    writeToken(dir, { ...tok, access_token: "NEW" });
    expect(readToken(dir)?.access_token).toBe("NEW");
    expect(readdirSync(dir)).toEqual(["token.json"]);
  });
  it("a failed write leaves the previous file intact and no temp file", () => {
    writeToken(dir, tok);
    const before = readFileSync(tokenPath(dir), "utf8");
    // Force the rename to fail: replace token.json with a non-empty directory is not portable,
    // so use a circular value that makes serialisation throw.
    const bad = { ...tok } as Record<string, unknown>;
    bad.self = bad;
    expect(() => writeToken(dir, bad as unknown as StoredToken)).toThrow();
    expect(readFileSync(tokenPath(dir), "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["token.json"]);
  });
  it("a failed rename cleans up the temp file", () => {
    const d = join(dir, "sub");
    mkdirSync(d);
    mkdirSync(join(d, "token.json", "x"), { recursive: true }); // target is a non-empty dir: rename fails
    expect(() => writeToken(d, tok)).toThrow();
    expect(readdirSync(d)).toEqual(["token.json"]);
    expect(existsSync(join(d, "token.json", "x"))).toBe(true);
  });
});
