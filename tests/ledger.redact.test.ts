import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/ledger/canonical.js";
import { redactPreview, scrubSecrets } from "../src/ledger/redact.js";

type Loose = Record<string, any>;
const sha8 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
// Random text so no 20-char slice can appear by coincidence elsewhere.
const body = randomBytes(4000).toString("base64").slice(0, 5000);

function noSlice(text: string, hay: string): boolean {
  for (let i = 0; i + 20 <= text.length; i++) if (hay.includes(text.slice(i, i + 20))) return false;
  return true;
}

describe("redactPreview", () => {
  it("redacts secret-like keys at any depth", () => {
    const out = redactPreview({
      access_token: "ya29.x",
      a: { b: [{ Password: "p", ok: 1 }] },
      Authorization: "z",
    }) as Loose;
    expect(out["access_token"]).toBe("[redacted]");
    expect(out["a"].b[0].Password).toBe("[redacted]");
    expect(out["a"].b[0].ok).toBe(1);
    expect(out["Authorization"]).toBe("[redacted]");
  });

  it("omits body/html/content strings with length and hash", () => {
    expect(body.length).toBe(5000);
    for (const key of ["body", "html", "Content", "BODY"]) {
      const out = redactPreview({ x: { [key]: body } }) as Loose;
      expect(out["x"][key]).toBe(`[omitted 5000 chars sha256:${sha8(body)}]`);
      expect(noSlice(body, JSON.stringify(out))).toBe(true);
    }
  });

  it("is deterministic for the same input", () => {
    expect(redactPreview({ body })).toEqual(redactPreview({ body }));
  });

  it("uses UTF-16 length for N", () => {
    const s = "😀".repeat(10);
    expect((redactPreview({ body: s }) as Loose)["body"]).toBe(`[omitted 20 chars sha256:${sha8(s)}]`);
  });

  it("omits non-string content via canonical JSON", () => {
    const c = { b: 1, a: ["secret text here"] };
    const j = canonicalJson(c);
    expect((redactPreview({ content: c }) as Loose)["content"]).toBe(
      `[omitted ${j.length} chars sha256:${sha8(j)}]`,
    );
  });

  it("secret-key rule wins over body rule", () => {
    expect((redactPreview({ authorization_body: "x" }) as Loose)["authorization_body"]).toBe("[redacted]");
  });

  it("truncates other long strings", () => {
    const s = "x".repeat(300);
    expect((redactPreview({ note: s }) as Loose)["note"]).toBe(
      `${"x".repeat(200)}…[truncated sha256:${sha8(s)}]`,
    );
  });

  it("leaves short strings untouched", () => {
    const s = "y".repeat(199);
    expect((redactPreview({ note: s }) as Loose)["note"]).toBe(s);
  });

  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
  const wide = (n: number): Record<string, string> => {
    const o: Record<string, string> = {};
    for (let i = 0; i < n; i++) o[`k${i}`] = "z".repeat(199);
    return o;
  };

  it("cap step 1: omits output first, keeps input", () => {
    const out = redactPreview({ v: 1, input: { a: 1 }, output: wide(40), note: "n" }) as Loose;
    expect(bytes(out)).toBeLessThanOrEqual(4096);
    expect(out).toEqual({ v: 1, input: { a: 1 }, output: "[omitted]", note: "n" });
  });

  it("cap step 2: then omits input, keeping note and action_id", () => {
    const out = redactPreview({
      v: 1,
      input: wide(40),
      output: wide(40),
      note: "cancelled",
      action_id: "act_X",
    }) as Loose;
    expect(bytes(out)).toBeLessThanOrEqual(4096);
    expect(out).toEqual({ v: 1, input: "[omitted]", output: "[omitted]", note: "cancelled", action_id: "act_X" });
  });

  it("cap step 3: note longer than 200 chars is cut to 200 when still over the cap", () => {
    // Extra top-level keys push the preview over the cap even with input/output omitted.
    const out = redactPreview({ v: 1, input: wide(40), output: null, note: "n".repeat(300), ...wide(30) }) as Loose;
    expect(bytes(out)).toBeLessThanOrEqual(4096);
    expect(out["note"].length).toBeLessThanOrEqual(200);
    expect(out["input"]).toBe("[omitted]");
    expect(out["output"]).toBe("[omitted]");
  });

  it("keeps note when a huge input is capped", () => {
    const out = redactPreview({ v: 1, input: wide(40), output: null, note: "cancelled" }) as Loose;
    expect(out["note"]).toBe("cancelled");
    expect(out["input"]).toBe("[omitted]");
  });

  it("caps depth: over-deep values become a marker and nothing overflows", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20_000; i++) deep = [deep];
    const out = redactPreview({ v: 1, input: deep, output: null, note: null });
    expect(JSON.stringify(out)).toContain("[omitted: too deep]");
    let obj: unknown = "leaf";
    for (let i = 0; i < 20_000; i++) obj = { body: obj };
    expect(() => redactPreview({ v: 1, input: obj, output: null, note: null })).not.toThrow();
  });

  it("depth cap boundary: 32 levels kept, 34 omitted", () => {
    const nest = (n: number): unknown => {
      let v: unknown = "x";
      for (let i = 0; i < n; i++) v = [v];
      return v;
    };
    expect(JSON.stringify(redactPreview(nest(32)))).not.toContain("too deep");
    expect(JSON.stringify(redactPreview(nest(34)))).toContain("[omitted: too deep]");
  });

  it.each(["apikey", "api_key", "api-key", "X-Api-Key", "private_key", "private-key", "Cookie", "set-cookie", "passphrase"])(
    "redacts key %s",
    (k) => {
      expect((redactPreview({ [k]: "v" }) as Loose)[k]).toBe("[redacted]");
    },
  );

  it("does not redact author", () => {
    expect((redactPreview({ author: "Ann" }) as Loose)["author"]).toBe("Ann");
  });

  it("does not mutate its input", () => {
    const input = { body, access_token: "t", nested: { s: "q".repeat(300) } };
    const snap = JSON.stringify(input);
    redactPreview(input);
    expect(JSON.stringify(input)).toBe(snap);
  });

  it("leak test", () => {
    const rt = "1//refresh-SECRET-VALUE-0123456789";
    const input = { refresh_token: rt, headers: { Authorization: "Bearer abc.def.ghi" }, body };
    const s = JSON.stringify(redactPreview({ v: 1, input, output: null, note: null }));
    expect(s).not.toContain(rt);
    expect(s).not.toContain("Bearer");
    expect(s).not.toContain("abc.def.ghi");
    expect(noSlice(body, s)).toBe(true);
  });
});

describe("scrubSecrets", () => {
  it("replaces every secret pattern and keeps the surrounding words", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOiIx.c2lnX25hdHVyZS0x";
    const text = `401 Bearer ya29.A0AbC-d_e refresh 1//0gXyZ-ab_c secret GOCSPX-abc_DEF-123 jwt ${jwt} done`;
    const out = scrubSecrets(text);
    for (const s of ["ya29.", "1//0g", "GOCSPX", "Bearer", "eyJ", "A0AbC", "c2lnX"]) expect(out).not.toContain(s);
    for (const w of ["401", "refresh", "secret", "jwt", "done"]) expect(out).toContain(w);
    expect(out).toContain("[redacted]");
  });

  it("scrubs bare tokens without a Bearer prefix", () => {
    expect(scrubSecrets("tok ya29.a0.b-c_d end")).toBe("tok [redacted] end");
    expect(scrubSecrets("rt 1//0abc-d_e/f end")).toBe("rt [redacted] end");
  });

  it.each([
    ["URL-encoded refresh token", "grant refresh_token=1%2F%2F0gABCDEFxyz&x=1 end", ["1%2F%2F0g", "ABCDEFxyz"]],
    ["URL-encoded, lowercase escapes", "rt 1%2f%2f0gABCDEFxyz end", ["0gABCDEFxyz"]],
    ["JSON-escaped refresh token", 'body {"refresh_token":"1\\/\\/0gABCDEFxyz"} end', ["0gABCDEFxyz"]],
    ["refresh token in a URL path", "GET https://host/revoke/1//0gABCDEFxyz?x=1 end", ["1//0g", "ABCDEFxyz"]],
    ["URL-encoded Bearer", "header Bearer%20opaqueTOKEN123 end", ["opaqueTOKEN123"]],
    ["plus-encoded Bearer", "header Bearer+opaqueTOKEN123 end", ["opaqueTOKEN123"]],
    ["client secret in a query string", "POST ?client_id=x&client_secret=GOCSPX-abc_DEF-123&y=2 end", ["GOCSPX", "abc_DEF"]],
    ["URL-encoded client secret prefix", "q client_secret=GOCSPX%2Dabc_DEF end", ["GOCSPX", "abc_DEF"]],
    ["URL-encoded access token", "q access_token=ya29%2Ea0AfH6xyz end", ["ya29", "a0AfH6"]],
    ["opaque access token in a query", "GET /x?access_token=plainopaque123 end", ["plainopaque123"]],
    ["auth code in a query", "cb ?state=s&code=4/0AeanS0abcdef end", ["0AeanS0abcdef"]],
    ["auth code in JSON", 'body {"code":"4/0AeanS0abcdef","state":"s"} end', ["0AeanS0abcdef"]],
    ["camelCase accessToken with =", "q accessToken=opaqueSECRET123 end", ["opaqueSECRET123"]],
    ["camelCase refreshToken in JSON", 'body {"refreshToken":"1/xyzSECRET"} end', ["xyzSECRET"]],
    ["camelCase clientSecret in JSON", 'body {"clientSecret":"plainSECRET"} end', ["plainSECRET"]],
    ["camelCase idToken with :", "q idToken: opaqueIDTOKEN end", ["opaqueIDTOKEN"]],
    ["URL-encoded = separator", "q refresh_token%3DopaqueSECRET end", ["opaqueSECRET"]],
    ["URL-encoded JSON separator", "q access_token%22%3A%22opaqueVALUE%22 end", ["opaqueVALUE"]],
    ["URL-encoded underscore in the key", "q client%5Fsecret=SECRETVAL end", ["SECRETVAL"]],
    ["quoted value with a space", 'q client_secret = "abc def" end', ["abc", "def"]],
    ["JSON inside a JSON string", 'body {\\"access_token\\":\\"opaqueSECRET1\\"} end', ["opaqueSECRET1"]],
    ["JSON inside a JSON string, camelCase, spaced", 'body \\"refreshToken\\": \\"opaqueSECRET2\\" end', ["opaqueSECRET2"]],
    ["a quoted value containing an escaped quote", 'body {"refresh_token":"ab\\"opaqueSECRET8"} end', ["opaqueSECRET8", "ab\\"]],
    ["JSON inside a JSON string, value with an escaped quote", 'body {\\"access_token\\":\\"ab\\\\\\"opaqueL\\"} end', ["opaqueL"]],
    ["URL-encoded value with an escaped quote", "q access_token%22%3A%22ab%5C%22opaqueM%22 end", ["opaqueM"]],
    ["double URL-encoded value with an escaped quote", "q access_token%2522%253A%2522ab%255C%2522opaqueN%2522 end", ["opaqueN"]],
    ["double URL-encoded = separator", "q refresh_token%253DopaqueSECRET5 end", ["opaqueSECRET5"]],
    ["double URL-encoded JSON separator", "q access_token%2522%253A%2522opaqueSECRET6%2522 end", ["opaqueSECRET6"]],
  ])("scrubs a %s and keeps the surrounding words", (_name, text, gone) => {
    const out = scrubSecrets(text);
    for (const g of gone) expect(out).not.toContain(g);
    expect(out).toContain("[redacted]");
    expect(out.split(" ")[0]).toBe(text.split(" ")[0]);
    expect(out.endsWith(" end")).toBe(true);
  });

  // JSON nested `d` levels deep: a quote is written with 2^d - 1 backslashes before it.
  for (const d of [1, 2, 3]) {
    const q = "\\".repeat(2 ** d - 1) + '"';
    const inner = "\\".repeat(2 ** (d + 1) - 1) + '"';
    it(`scrubs keys and values in JSON nested ${d} level(s) deep, also a value holding an escaped quote`, () => {
      for (const [key, value] of [
        ["access_token", `opaqueD${d}`],
        ["refreshToken", `opaqueR${d}`],
        ["client_secret", `ab${inner}opaqueQ${d}`],
      ] as const) {
        const text = `body {${q}${key}${q}:${q}${value}${q},${q}x${q}:1} end`;
        const out = scrubSecrets(text);
        expect(out, text).not.toMatch(/opaque/);
        expect(out).toContain(`${key}${q}:${q}[redacted]${q}`);
        expect(out.startsWith("body {")).toBe(true);
        expect(out.endsWith(":1} end")).toBe(true);
      }
      const code = scrubSecrets(`cb {${q}code${q}:${q}4/0AeanS0abcdef${q}} end`);
      expect(code).not.toContain("0AeanS0abcdef");
    });
  }

  it("stays linear on long backslash and escape runs inside a quoted value", () => {
    const inputs = [
      'access_token\\\\\\":' + "\\".repeat(100_000),
      "access_token:" + "\\".repeat(100_000) + '"' + "x".repeat(100_000),
      "access_token:" + "\\".repeat(50_000) + '"' + ("\\".repeat(49_999) + "y").repeat(2),
      "code" + "\\".repeat(100_000),
      "x" + "\\".repeat(100_000) + "code",
      "access_token" + "\\".repeat(100_000),
      'access_token:\\"' + "\\".repeat(100_000),
      'access_token:"' + "\\".repeat(100_000),
      "access_token%22%3A%22" + "%5C".repeat(30_000),
      'access_token:\\"' + '\\\\\\"'.repeat(25_000),
    ];
    for (const s of inputs) {
      const t = performance.now();
      scrubSecrets(s);
      expect(performance.now() - t, `${s.slice(0, 20)}... (${s.length})`).toBeLessThan(50);
    }
  });

  it("leaves ordinary text and URLs alone", () => {
    expect(scrubSecrets("HTTP 403 at http://host/1//x? no")).toBe("HTTP 403 at http://host/1//x? no");
  });
});
