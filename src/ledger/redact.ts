import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

const SECRET_KEY = /token|secret|password|authorization|credential/i;
const BODY_KEY = /^(body|html|content)$/i;
const MAX_STRING = 200;
const MAX_PREVIEW_BYTES = 4096;

const sha8 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);

function omitted(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = canonicalJson(value);
    } catch {
      text = String(value);
    }
  }
  return `[omitted ${text.length} chars sha256:${sha8(text)}]`;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[truncated sha256:${sha8(value)}]`
      : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (SECRET_KEY.test(k)) out[k] = "[redacted]";
      else if (BODY_KEY.test(k)) out[k] = omitted(v);
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

/** Redacts a preview (see docs/ledger-contract.md). Never mutates its input. */
export function redactPreview(value: unknown): unknown {
  const out = redact(value);
  if (Buffer.byteLength(JSON.stringify(out) ?? "null", "utf8") > MAX_PREVIEW_BYTES) {
    return { v: 1, input: "[omitted]", output: "[omitted]", note: null };
  }
  return out;
}
