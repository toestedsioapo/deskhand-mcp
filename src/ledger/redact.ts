import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

const SECRET_KEY =
  /token|secret|password|authorization|credential|api[_-]?key|private[_-]?key|cookie|passphrase/i;
const BODY_KEY = /^(body|html|content)$/i;
const MAX_STRING = 200;
const MAX_PREVIEW_BYTES = 4096;
const MAX_NOTE = 200;
const MAX_DEPTH = 32;
const TOO_DEEP = "[omitted: too deep]";

const sha8 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);

function omitted(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = canonicalJson(value);
    } catch {
      // Over-deep, cyclic or otherwise non-canonical: describe it without recursing.
      text = "[unserialisable]";
    }
  }
  return `[omitted ${text.length} chars sha256:${sha8(text)}]`;
}

function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return TOO_DEEP;
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[truncated sha256:${sha8(value)}]`
      : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (SECRET_KEY.test(k)) out[k] = "[redacted]";
      else if (BODY_KEY.test(k)) out[k] = omitted(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const size = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "null", "utf8");

/**
 * Redacts a preview (see docs/ledger-contract.md). Never mutates its input.
 * Over the size cap: omit `output`, then `input`, then truncate `note`; `note`
 * and `action_id` are always kept.
 */
export function redactPreview(value: unknown): unknown {
  const out = redact(value, 0);
  if (size(out) <= MAX_PREVIEW_BYTES) return out;
  if (out === null || typeof out !== "object" || Array.isArray(out)) {
    return { v: 1, input: "[omitted]", output: "[omitted]", note: null };
  }
  const p: Record<string, unknown> = { ...(out as Record<string, unknown>) };
  p["output"] = "[omitted]";
  if (size(p) <= MAX_PREVIEW_BYTES) return p;
  p["input"] = "[omitted]";
  if (size(p) <= MAX_PREVIEW_BYTES) return p;
  if (typeof p["note"] === "string") p["note"] = p["note"].slice(0, MAX_NOTE);
  if (size(p) <= MAX_PREVIEW_BYTES) return p;
  // Last resort: only the documented fields survive.
  const keep: Record<string, unknown> = { v: p["v"] ?? 1, input: "[omitted]", output: "[omitted]" };
  keep["note"] = typeof p["note"] === "string" ? p["note"] : null;
  if (typeof p["action_id"] === "string") keep["action_id"] = p["action_id"].slice(0, MAX_NOTE);
  return keep;
}

/** Plain recursive redaction (secret keys, body keys, long strings) with no size cascade. For `actions.input_json`. */
export function redactInput(value: unknown): unknown {
  return redact(value, 0);
}
