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

  it("caps the whole preview at 4096 bytes", () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < 40; i++) input[`k${i}`] = "z".repeat(199);
    const out = redactPreview({ v: 1, input, output: null, note: null });
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(4096);
    expect(out).toEqual({ v: 1, input: "[omitted]", output: "[omitted]", note: null });
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
