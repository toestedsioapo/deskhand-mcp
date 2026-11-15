import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/ledger/canonical.js";
import { normaliseForCheck, redactPreview, SECRET_LIKE, scrubSecrets } from "../src/ledger/redact.js";
import { AuthRequiredError, EVENT_DELETED, ProviderError } from "../src/providers/errors.js";

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
  ])("scrubs a %s (plain: keeps the surrounding words; encoded or escaped: the fixed sentence)", (_name, text, gone) => {
    const out = scrubSecrets(text);
    for (const g of gone) expect(out).not.toContain(g);
    if (normaliseForCheck(text) !== text) {
      // Ruling 17: an encoded or escaped secret fails closed.
      expect(out).toBe(SECRET_LIKE);
      return;
    }
    expect(out).toContain("[redacted]");
    expect(out.split(" ")[0]).toBe(text.split(" ")[0]);
    expect(out.endsWith(" end")).toBe(true);
  });

  // JSON nested `d` levels deep: a quote is written with 2^d - 1 backslashes before it.
  for (const d of [1, 2, 3]) {
    const q = "\\".repeat(2 ** d - 1) + '"';
    const inner = "\\".repeat(2 ** (d + 1) - 1) + '"';
    it(`JSON nested ${d} level(s) deep holding a secret fails closed, also a value holding an escaped quote`, () => {
      for (const [key, value] of [
        ["access_token", `opaqueD${d}`],
        ["refreshToken", `opaqueR${d}`],
        ["client_secret", `ab${inner}opaqueQ${d}`],
      ] as const) {
        const text = `body {${q}${key}${q}:${q}${value}${q},${q}x${q}:1} end`;
        // Ruling 17: escaped JSON holding a secret fails closed.
        expect(scrubSecrets(text), text).toBe(SECRET_LIKE);
      }
      expect(scrubSecrets(`cb {${q}code${q}:${q}4/0AeanS0abcdef${q}} end`)).toBe(SECRET_LIKE);
    });
  }

  // URL-encoded JSON inside a JSON string (`%5C%22access_token%5C%22%3A%5C%22...`), at depths 2 and 3, also double-encoded.
  const nest = (v: unknown, depth: number): string => {
    let s = JSON.stringify(v);
    for (let i = 1; i < depth; i++) s = JSON.stringify(s);
    return s;
  };
  for (const [label, enc] of [
    ["URL-encoded", (s: string) => encodeURIComponent(s)],
    ["double URL-encoded", (s: string) => encodeURIComponent(encodeURIComponent(s))],
  ] as const) {
    for (const depth of [2, 3]) {
      it(`${label} nested JSON secrets at depth ${depth} fail closed`, () => {
        const cases: [unknown, string[], boolean][] = [
          [{ access_token: "opaqueU1", x: "keep" }, ["opaqueU1"], true],
          [{ refreshToken: "opaqueU3", x: "keep" }, ["opaqueU3"], true],
          [{ client_secret: 'ab"opaqueU4', x: "keep" }, ["opaqueU4"], true],
          [{ code: "4/0AeanU2", x: "keep" }, ["0AeanU2"], false],
        ];
        for (const [obj, gone, keyed] of cases) {
          const text = `q=${enc(nest(obj, depth))} end`;
          const out = scrubSecrets(text);
          for (const g of gone) expect(out, text).not.toContain(g);
          // Ruling 17: encoded JSON holding a secret fails closed (the other values go with it).
          expect(out, String(keyed)).toBe(SECRET_LIKE);
        }
      });
    }
  }

  // Pretty-printed JSON, URL-encoded: the whitespace around a separator arrives as `%20`, `+`, `%0A` (or `%2520`...).
  const nestPretty = (v: unknown, depth: number): string => {
    let s = JSON.stringify(v, null, 2);
    for (let i = 1; i < depth; i++) s = JSON.stringify(s);
    return s;
  };
  for (const [label, enc] of [
    ["encodeURIComponent", (s: string) => encodeURIComponent(s)],
    ["double encodeURIComponent", (s: string) => encodeURIComponent(encodeURIComponent(s))],
    ["encodeURI", (s: string) => encodeURI(s)],
    ["URLSearchParams", (s: string) => new URLSearchParams({ j: s }).toString()],
    ["URLSearchParams then encodeURIComponent", (s: string) => encodeURIComponent(new URLSearchParams({ j: s }).toString())],
    ["URLSearchParams twice", (s: string) => new URLSearchParams({ k: new URLSearchParams({ j: s }).toString() }).toString()],
  ] as const) {
    for (const depth of [1, 2, 3]) {
      it(`pretty-printed JSON through ${label} at depth ${depth} fails closed`, () => {
        const cases: [unknown, string, boolean][] = [
          [{ access_token: "it'sSEKRIT", x: "KEEPME" }, "SEKRIT", true],
          [{ refreshToken: "a,b&cSEKRIT", x: "KEEPME" }, "SEKRIT", true],
          [{ clientSecret: "q\"x'SEKRIT", x: "KEEPME" }, "SEKRIT", true],
          [{ code: "4/0AeanCODEXQ" }, "CODEXQ", false],
        ];
        for (const [obj, gone, keyed] of cases) {
          const text = `q=${enc(nestPretty(obj, depth))} end`;
          const out = scrubSecrets(text);
          expect(out, text).not.toContain(gone);
          // Ruling 17: encoded JSON holding a secret fails closed (KEEPME goes with it).
          expect(out, String(keyed)).toBe(SECRET_LIKE);
        }
      });
    }
  }

  it("prose around the word code is left alone", () => {
    for (const t of ["Error code: 4 retries left", "the code%20is%204%2F5", "code=%204 apples"]) {
      expect(scrubSecrets(t)).toBe(t);
    }
    // Ruling 17, accepted over-redaction: with `+` read as a space this is `code` + separators + `4/`.
    expect(scrubSecrets("zip code + 4/5 digits")).toBe(SECRET_LIKE);
  });

  it("stays linear on long backslash and escape runs inside a quoted value", () => {
    const inputs = [
      "access_token%3A" + "%20".repeat(33_000),
      "code%3A" + "%20".repeat(33_000),
      "access_token%3A" + "+".repeat(100_000),
      "access_token%253A" + "%2520".repeat(20_000),
      "access_token%22" + "%0A".repeat(33_000),
      "access_token%3A" + "%5C".repeat(33_000),
      "code%3A" + "%5C".repeat(33_000),
      "access_token%253A" + "%255C".repeat(20_000),
      "access_token%3A%5C%22" + "%5C".repeat(33_000),
      "access_token%3A%5C%5C%5C%22" + "%5C%5C%22".repeat(10_000),
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

/** Fail-closed behaviour, first added by Ruling 16 (wave 8); the mechanism is now Ruling 17's (wave 9, below). */
describe("scrubSecrets fails closed", () => {
  const FAIL = "[redacted: text contained secret-like data]";

  it("returns the fixed sentence when an encoding the patterns miss still holds a secret", () => {
    for (const t of [
      "x ya29%25252Ea0SEKRITabc end", // triple-encoded access token
      "x 1%25252F%25252F0gSEKRITabcdef end", // triple-encoded refresh token
      "x GOCSPX%25252DSEKRIT end",
      "x access_token%25252522%2525253A%25252522SEKRIT%25252522 end", // key and value four encodings deep
      "x %2561ccess_token=SEKRIT end", // a letter of the key itself encoded
    ]) {
      expect(scrubSecrets(t), t).toBe(FAIL);
    }
  });

  it("keeps the pattern pass's output when the normalised copy is clean", () => {
    expect(scrubSecrets("401 Bearer ya29.A0AbC refresh 1//0gXyZ end")).toBe("401 [redacted] refresh [redacted] end");
    expect(scrubSecrets('q {"access_token":"abc","x":"KEEPME"} end')).toBe('q {"access_token":"[redacted]","x":"KEEPME"} end');
  });

  it("an empty secret value: quoted is redacted as usual, unquoted fails closed (Ruling 17)", () => {
    expect(scrubSecrets('q {"access_token":"","x":"KEEPME"} end')).toBe('q {"access_token":"[redacted]","x":"KEEPME"} end');
    // The predicate sees `access_token=` followed by a value character (`&`): deliberately broad.
    expect(scrubSecrets("q access_token=&x=1 end")).toBe(SECRET_LIKE);
  });

  it("ordinary prose and URLs with + and %20 and no secret come back unchanged", () => {
    for (const t of [
      "HTTP 503 backendError at https://www.googleapis.com/calendar/v3/calendars/primary/events?q=a+b%20c&maxResults=50",
      "search?q=access+token+docs&lang=en",
      "the code%20is%204%2F5 and 100%25 sure",
      "a+b=c, 50% off, %zz and %2 are malformed",
      'He said "hi" and C:\\temp\\new is a path, a\\/b',
      "Error code: 4 retries left",
      "token refresh failed",
      "client secret file is missing",
    ]) {
      expect(scrubSecrets(t), t).toBe(t);
    }
  });

  // Fuzz: one secret, many encodings. The secret's marker must never survive.
  const secrets: [string, unknown][] = [
    ["access_token", { access_token: "opaq'SEKRIT1", x: "KEEPME" }],
    ["refreshToken", { refreshToken: "a,b&cSEKRIT2", x: "KEEPME" }],
    ["clientSecret", { clientSecret: 'q"x\'SEKRIT3' }],
    ["id_token", { id_token: "plainSEKRIT4" }],
    ["code", { code: "4/0AeanSEKRIT5" }],
    ["ya29", { note: "ya29.a0SEKRIT6" }],
    ["1//", { note: "1//0gSEKRIT7abcdef" }],
    ["GOCSPX", { note: "GOCSPX-SEKRIT8" }],
  ];
  const nests: [string, (v: unknown) => string][] = [];
  for (const depth of [1, 2, 3]) {
    for (const pretty of [false, true]) {
      nests.push([
        `json${depth}${pretty ? "-pretty" : ""}`,
        (v) => {
          let s = pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
          for (let i = 1; i < depth; i++) s = JSON.stringify(s);
          return s;
        },
      ]);
    }
  }
  const encoders: [string, (s: string) => string][] = [
    ["raw", (s) => s],
    ["encodeURIComponent", (s) => encodeURIComponent(s)],
    ["encodeURIComponent x2", (s) => encodeURIComponent(encodeURIComponent(s))],
    ["encodeURIComponent x3", (s) => encodeURIComponent(encodeURIComponent(encodeURIComponent(s)))],
    ["encodeURI", (s) => encodeURI(s)],
    ["URLSearchParams", (s) => new URLSearchParams({ j: s }).toString()],
    ["URLSearchParams then encodeURIComponent", (s) => encodeURIComponent(new URLSearchParams({ j: s }).toString())],
    ["URLSearchParams x2", (s) => new URLSearchParams({ k: new URLSearchParams({ j: s }).toString() }).toString()],
  ];
  it(`never lets a secret survive: ${secrets.length} secrets x ${nests.length} JSON shapes x ${encoders.length} encoders`, () => {
    const leaks: string[] = [];
    for (const [sName, obj] of secrets) {
      const marker = /SEKRIT\d/.exec(JSON.stringify(obj))![0];
      for (const [nName, nest] of nests) {
        for (const [eName, enc] of encoders) {
          const text = `pre ${enc(nest(obj))} post`;
          if (scrubSecrets(text).includes(marker)) leaks.push(`${sName} / ${nName} / ${eName}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("stays linear on ~100 KB inputs, including long %25 chains", () => {
    const inputs = [
      "%25".repeat(33_000),
      "x " + "%2525".repeat(20_000) + "2E",
      "ya29" + "%25".repeat(33_000) + "2E",
      "access_token%3A" + "%2B".repeat(33_000),
      "access_token%253A" + "%2B".repeat(33_000),
      "+".repeat(100_000),
      "\\".repeat(100_000) + '"',
      "%5C".repeat(33_000) + "%22",
      "a%20".repeat(25_000),
    ];
    for (const s of inputs) {
      const t = performance.now();
      scrubSecrets(s);
      expect(performance.now() - t, `${s.slice(0, 20)}... (${s.length})`).toBeLessThan(50);
    }
  });
});

/**
 * Ruling 17 (fix wave 9): a simple, broad predicate checked on the DECODED INPUT (percent-decoded up to 4 times, `+`
 * as a space, every backslash deleted) and on the pattern pass's output; either hit gives the fixed sentence.
 */
describe("scrubSecrets, Ruling 17", () => {
  const FIXED = "[redacted: text contained secret-like data]";

  it.each([
    // RT9-1: a value that starts with an escaped quote.
    ["triple-encoded value starting with a quote", "%25257B%252522access_token%252522%25253A%252522%25255C%252522SEKRIT%252522%25257D"],
    ["key letter encoded, value starting with an escaped quote", '%61ccess_token":"\\"SEKRIT"'],
    ["the single-quote twin", "access_token%25253D'%25255C'SEKRIT'"],
    // RT9-2: a backslash right before `refresh_token`.
    ["encodeURIComponent of a Windows path", "C%3A%5Crefresh_token%3DSEKRIT"],
    ["encodeURI of a Windows path", "C:%5Crefresh_token=SEKRIT"],
    ["camelCase after an encoded backslash", "%5CrefreshToken%3ASEKRIT"],
    ["inside URL-encoded JSON", encodeURIComponent(JSON.stringify({ path: "C:\\refresh_token=SEKRIT" }))],
    // RT9-3: whitespace encoded deeper than the patterns know, then a raw quote.
    ["triple-encoded space before a single-quoted value", "access_token:%252520'SEKRIT'"],
    ["encodeURI x3 of a Python repr", encodeURI(encodeURI(encodeURI("{'access_token': 'opaqueSEKRIT', 'x': 'KEEP'}")))],
    ["client_secret twin", "client_secret:%252520'SEKRIT'"],
    ["double-quoted twin", 'access_token=%252520"SEKRIT"'],
  ])("RT9 repro: %s -> the fixed sentence", (_name, text) => {
    expect(scrubSecrets(text)).toBe(FIXED);
  });

  it.each([
    ["encoded underscore, = and 12 encoded spaces", "access%5Ftoken%3D" + "%20".repeat(12) + "SEKRIT"],
    ["encoded underscore, : and 13 encoded spaces", "client%5Fsecret%3A" + "%20".repeat(13) + "SEKRIT"],
    ["encoded underscore, = and 13 plus signs", "refresh%5Ftoken=" + "+".repeat(13) + "SEKRIT"],
    ["encoded key letter and 13 raw spaces", "%61ccess_token=" + " ".repeat(13) + "SEKRIT"],
    ["every byte percent-encoded, YAML style", [..."access_token:\n" + " ".repeat(14) + "SEKRIT"].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")],
    ["encoded key, 10 000 separators", "%61ccess_token=" + " ".repeat(10_000) + "SEKRIT"],
  ])("RT10-1 repro: %s -> the fixed sentence (the separator run is unbounded)", (_name, text) => {
    expect(scrubSecrets(text)).toBe(FIXED);
  });

  it("JWTs: the exact span is redacted in plain text; case variants are caught by the predicate", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOiIx.c2lnX25hdHVyZS0x";
    expect(scrubSecrets(`tok ${jwt} end`)).toBe("tok [redacted] end");
    expect(scrubSecrets(`a=${jwt}.more x`)).toBe("a=[redacted].more x");
    expect(scrubSecrets(`ab${jwt} x`)).toBe("ab[redacted] x");
    expect(scrubSecrets(`x eyJ.a.b eyJa..b eyJa.b end`)).toBe("x eyJ.a.b eyJa..b eyJa.b end");
    expect(scrubSecrets(`two ${jwt} and ${jwt} end`)).toBe("two [redacted] and [redacted] end");
    expect(scrubSecrets("x EYJHBGCIOI.EYJZDWIIOIIX.C2LNX25HDHVYZS0X end")).toBe(FIXED);
  });

  it("plain shapes keep their surrounding words (the pattern pass still runs)", () => {
    expect(scrubSecrets("401 Bearer ya29.A0AbC-d_e refresh 1//0gXyZ-ab_c end")).toBe("401 [redacted] refresh [redacted] end");
    expect(scrubSecrets('q {"access_token":"abc","x":"KEEPME"} end')).toBe('q {"access_token":"[redacted]","x":"KEEPME"} end');
    expect(scrubSecrets("cb ?state=s&code=4/0AeanS0abcdef end")).toBe("cb ?state=s&code=[redacted] end");
  });

  it("a plain shape the pattern pass misses still fails closed (checked on the output)", () => {
    expect(scrubSecrets("x ab1//0gSEKRITabcdef end")).toBe(FIXED); // the raw 1// rule refuses a word character before it
    expect(scrubSecrets('q {"access_token":"\\"SEKRIT"} end')).toBe(FIXED);
    expect(scrubSecrets("tok eyJhbGciOi.eyJzdWIiOiIx.c2lnX25hdHVyZS0x")).not.toContain("c2lnX");
  });

  it("ordinary prose and URLs without secrets come back unchanged", () => {
    for (const t of [
      "Error code: 4 retries left",
      "HTTP 503 backendError at https://www.googleapis.com/calendar/v3/calendars/primary/events?q=a+b%20c&maxResults=50",
      "search?q=access+token+docs&lang=en",
      "the code%20is%204%2F5 and 100%25 sure",
      "a+b=c, 50% off, %zz and %2 are malformed",
      'He said "hi" and C:\\temp\\new is a path, a\\/b',
      "token refresh failed",
      "zip code 4 digits",
    ]) {
      expect(scrubSecrets(t), t).toBe(t);
    }
  });

  it("accepted over-redaction: a key word in prose with a value-like word after it", () => {
    // Deliberately broad: "bearer" followed by a word is treated as a credential.
    expect(scrubSecrets("the bearer of good news")).not.toBe("the bearer of good news");
    expect(scrubSecrets("missing access_token in the response")).toBe(FIXED);
  });

  it("our own fixed error sentences pass through unchanged", () => {
    const g = (op: string, d: { status?: number; reason?: string; phrase?: string }) => new ProviderError("google calendar", op, d).message;
    const sentences = [
      "Not signed in to Google. Run: deskhand auth login",
      "Google write access is not granted. Run: deskhand auth upgrade",
      "The Google sign-in has expired or was revoked. Run: deskhand auth login",
      "The Google OAuth client file is missing or unreadable. See docs/google-oauth-setup.md",
      new AuthRequiredError().message,
      g("events.list", { status: 429, reason: "rateLimitExceeded" }),
      g("events.insert", { status: 503, reason: "backendError" }),
      ...[
        "timed out",
        "network error",
        "token refresh failed",
        "could not save token",
        "invalid request URL",
        "refused request to an unexpected host",
        "unreadable response",
        "unreadable event",
        "unreadable event time",
        "invalid event id",
        "Google returned a different event id",
        "id conflict but the event is not readable",
        "calendar error notFound",
        EVENT_DELETED,
      ].map((phrase) => g("events.get", { phrase })),
      "an event with this action's id exists but differs from the approved plan",
      "an earlier write attempt may still be landing; retry later",
      "Google sign-in failed: could not reach the token endpoint.",
      "Google sign-in failed: the token endpoint returned HTTP 400.",
      "Google sign-in failed: the browser response did not match this login attempt.",
      "Google sign-in was cancelled or denied.",
      "Google sign-in failed: Google returned no sign-in code.",
      "Google sign-in failed: the code exchange did not complete.",
      "Google sign-in failed: the token response had no access token.",
      "Google did not return a refresh token. Remove Deskhand's access in your Google account (myaccount.google.com/permissions), then run: deskhand auth login",
      "Google did not report which permissions were granted. Run the sign-in again.",
      "Google sign-in did not grant every requested permission. Run the sign-in again and allow all requested access.",
      "Google sign-in failed: could not start the local callback listener.",
      "Google sign-in timed out waiting for the browser. Run: deskhand auth login",
      "Google sign-in failed: could not show the sign-in link.",
      "no Google sign-in found; run deskhand auth login first",
    ];
    for (const s of sentences) expect(scrubSecrets(s), s).toBe(s);
  });

  it("never throws: malformed %, lone surrogates, 1 MB input", () => {
    for (const t of ["%", "%%%", "%E0%A4%A", "%ZZ%2", "\uD800 access", "x\uDC00y%uD800", "%25%25%2", "a".repeat(1_000_000)]) {
      expect(() => scrubSecrets(t)).not.toThrow();
    }
    const big = "x ".repeat(250_000) + "access_token=SEKRIT " + "%20".repeat(100_000);
    expect(scrubSecrets(big)).toBe(FIXED);
  });

  // Differential fuzz: one secret, many encodings and JSON shapes; no secret substring may survive.
  const values: [string, string][] = [
    ["opaque", "opaqSEKRIT1x"],
    ["quote first", '"SEKRIT2x'],
    ["escaped quote first", '\\"SEKRIT3x'],
    ["single quote first", "'SEKRIT4x"],
    ["comma and amp", "a,b&cSEKRIT5x"],
    ["backslash r", "\\rSEKRIT6x"],
  ];
  const keys = ["access_token", "accessToken", "refresh_token", "refreshToken", "id_token", "idToken", "client_secret", "clientSecret"];
  const shapes: [string, string][] = [
    ["ya29", "ya29.a0SEKRIT7abcdefgh"],
    ["1//", "1//0gSEKRIT8abcdefgh"],
    ["GOCSPX", "GOCSPX-SEKRIT9abc"],
    ["code", "4/0AeanSEKRITAabcd"],
  ];
  const wrap = (v: unknown, depth: number, pretty: boolean): string => {
    // Depth 0: a form-encoded body (a raw `&` or `,` inside a value would end it there, so the value is encoded).
    if (depth === 0) return new URLSearchParams(v as Record<string, string>).toString();
    let s = pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
    for (let i = 1; i < depth; i++) s = JSON.stringify(s);
    return s;
  };
  const encoders: [string, (s: string) => string][] = [
    ["raw", (s) => s],
    ["encodeURIComponent", (s) => encodeURIComponent(s)],
    ["encodeURIComponent x2", (s) => encodeURIComponent(encodeURIComponent(s))],
    ["encodeURIComponent x3", (s) => encodeURIComponent(encodeURIComponent(encodeURIComponent(s)))],
    ["encodeURI", (s) => encodeURI(s)],
    ["encodeURI x3", (s) => encodeURI(encodeURI(encodeURI(s)))],
    ["URLSearchParams", (s) => new URLSearchParams({ j: s }).toString()],
    ["URLSearchParams then encodeURIComponent", (s) => encodeURIComponent(new URLSearchParams({ j: s }).toString())],
    ["URLSearchParams x2", (s) => new URLSearchParams({ k: new URLSearchParams({ j: s }).toString() }).toString()],
    ["lowercase hex", (s) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
  ];
  it("never lets a secret survive (keys x values x shapes x JSON depth 0-3 x compact/pretty x encoders)", () => {
    const leaks: string[] = [];
    const objects: [string, unknown, string][] = [];
    for (const k of keys) for (const [vn, v] of values) objects.push([`${k}/${vn}`, { [k]: v, x: "KEEP" }, /SEKRIT\d/.exec(v)![0]]);
    for (const [sn, s] of shapes) {
      objects.push([`${sn} bare`, { note: `see ${s} here` }, /SEKRIT[0-9A]/.exec(s)![0]]);
      if (sn === "code") objects.push(["code keyed", { code: s, x: "KEEP" }, "SEKRITA"]);
    }
    let n = 0;
    for (const [name, obj, marker] of objects) {
      for (const depth of [0, 1, 2, 3]) {
        for (const pretty of depth === 0 ? [false] : [false, true]) {
          for (const [en, enc] of encoders) {
            const text = `pre ${enc(wrap(obj, depth, pretty))} post`;
            n += 1;
            if (scrubSecrets(text).includes(marker)) leaks.push(`${name} d${depth}${pretty ? "p" : ""} ${en}`);
          }
        }
      }
    }
    expect(n).toBeGreaterThan(3500);
    expect(leaks).toEqual([]);
  });

  it("stays linear on ~100 KB adversarial inputs", () => {
    const inputs = [
      "%25".repeat(33_000),
      "%2525".repeat(20_000) + "2E",
      "\\".repeat(100_000),
      "access_token" + "\\".repeat(100_000),
      "bearer" + " ".repeat(100_000),
      "code" + ":".repeat(100_000),
      "ya29." + "-".repeat(100_000),
      "access_token=".repeat(8_000),
      "+%20".repeat(25_000),
      // RT10-2: JWT detection on runs of `eyJ` and its case variants, with and without dots.
      "eyJ".repeat(33_000),
      "EYJ".repeat(33_000),
      "eyj".repeat(33_000),
      "Eyj".repeat(33_000),
      "eyJ.".repeat(25_000),
      "eyJa.".repeat(20_000),
      "EYJa.b".repeat(16_000),
      "eyJ" + "a".repeat(100_000) + ".",
      // RT10-1: unbounded separator runs.
      "access_token" + " ".repeat(100_000) + "[redacted]",
      "%61ccess_token=" + " ".repeat(100_000),
      "code" + ":".repeat(100_000) + "x",
      "bearer".repeat(16_000),
    ];
    for (const s of inputs) {
      const t = performance.now();
      scrubSecrets(s);
      expect(performance.now() - t, `${s.slice(0, 20)}... (${s.length})`).toBeLessThan(50);
    }
  });
});
