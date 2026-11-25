import { openSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Delegates to the real openSync; one test makes a single call fail.
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
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
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

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

describe("token store temp file (M3b follow-up 1)", () => {
  const FIXED = 1_700_000_000_000;
  const tmpName = (n: number) => `token.json.${process.pid}.${FIXED}.${n}.tmp`;

  it("an existing file at the first temp path is left untouched and token.json is still written", () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED);
    writeFileSync(join(dir, tmpName(0)), "PLANTED");
    writeToken(dir, tok);
    expect(readFileSync(join(dir, tmpName(0)), "utf8")).toBe("PLANTED");
    expect(readToken(dir)).toEqual(tok);
  });
  it("a symlink at the temp path is not followed", () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED);
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "VICTIM");
    try {
      symlinkSync(victim, join(dir, tmpName(0)));
    } catch {
      return; // symlinks need privileges on some platforms
    }
    writeToken(dir, tok);
    expect(readFileSync(victim, "utf8")).toBe("VICTIM");
    expect(lstatSync(join(dir, tmpName(0))).isSymbolicLink()).toBe(true);
    expect(readToken(dir)).toEqual(tok);
  });
  it("five collisions in a row throw and write nothing", () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED);
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, tmpName(i)), `PLANTED${i}`);
    expect(() => writeToken(dir, tok)).toThrow();
    expect(readToken(dir)).toBeNull();
    for (let i = 0; i < 5; i++) expect(readFileSync(join(dir, tmpName(i)), "utf8")).toBe(`PLANTED${i}`);
  });
  it("a non-EEXIST open failure leaves the planted entry untouched and surfaces the original error", () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED);
    writeFileSync(join(dir, tmpName(0)), "PLANTED");
    const boom = Object.assign(new Error("too many open files"), { code: "EMFILE" });
    vi.mocked(openSync).mockImplementationOnce(() => {
      throw boom;
    });
    expect(() => writeToken(dir, tok)).toThrow(boom);
    expect(readFileSync(join(dir, tmpName(0)), "utf8")).toBe("PLANTED");
    expect(readToken(dir)).toBeNull();
  });
  it("four collisions still succeed on the fifth try", () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED);
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, tmpName(i)), "PLANTED");
    writeToken(dir, tok);
    expect(readToken(dir)).toEqual(tok);
  });
});
