import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/ledger/canonical.js";
import { redactPreview } from "../src/ledger/redact.js";

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
