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

/** What scrubSecrets returns for any text that holds, or may hide, a secret (Ruling 18). */
export const SECRET_LIKE = "[redacted: text contained secret-like data]";

/**
 * Ruling 18's predicate, regex part. Case-insensitive, substring-based (no word boundary: `xaccess_token` counts):
 * - token shapes: `ya29.`, `1//` (each + 10 or more of `[\w-]`), `gocspx-` (+ 6 or more), an auth code `4/0` (+ 10 or
 *   more);
 * - a key word (`access_token`, `refresh_token`, `id_token`, `client_secret`, each also without the underscore,
 *   `authorization`, `bearer`, `api_key`, `apikey`, `password`) followed by a separator run of `[\s"':=]` (any length,
 *   possibly empty) and then any non-separator character; the bare word with nothing after it does not count;
 * - `code` followed that way by `4/`.
 * Each separator run is atomic (`(?=(run))\1`: the lookahead captures the whole run, the backreference consumes it),
 * so it is never re-tried shorter; the run class and the next character are disjoint. JWTs: see hasJwt.
 */
const SECRET_SHAPE =
  /ya29\.[\w-]{10,}|1\/\/[\w-]{10,}|gocspx-[\w-]{6,}|4\/0[\w-]{10,}|(?:access_?token|refresh_?token|id_?token|client_?secret|authorization|bearer|api_?key|password)(?=([\s"':=]*))\1[^\s"':=]|code(?=([\s"':=]*))(?:\2)4\//i;

const WORD_RUN = /[\w.-]+/g;

/**
 * A three-part JWT, case-insensitive, by one linear scan (the regex `eyJ[\w-]+\.[\w-]+\.[\w-]+` backtracks
 * quadratically on long dot-less `eyJ` runs): within a maximal run of `[\w.-]` split on `.`, three consecutive
 * non-empty segments where the first holds `eyJ` with at least one character after it.
 */
function hasJwt(text: string): boolean {
  if (!/eyj/i.test(text)) return false;
  for (const run of text.matchAll(WORD_RUN)) {
    if (!/eyj/i.test(run[0])) continue;
    const segs = run[0].split(".");
    for (let i = 0; i + 2 < segs.length; i++) {
      const seg = segs[i]!;
      const p = seg.toLowerCase().indexOf("eyj");
      if (p >= 0 && p + 3 < seg.length && segs[i + 1] !== "" && segs[i + 2] !== "") return true;
    }
  }
  return false;
}

export function looksSecret(text: string): boolean {
  return SECRET_SHAPE.test(text) || hasJwt(text);
}

const PERCENT = /%([0-9A-Fa-f]{2})/g;

/**
 * Percent-decoded repeatedly (at most 4 rounds, stopping when nothing changes; a malformed `%` stays; each byte
 * becomes one character, enough for matching), then `+` as a space, then every backslash deleted (no escape is
 * interpreted). Linear, never throws.
 */
export function normaliseForCheck(text: string): string {
  let cur = text;
  for (let i = 0; i < 4; i++) {
    const next = cur.replace(PERCENT, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === cur) break;
    cur = next;
  }
  return cur.replace(/\+/g, " ").replace(/\\/g, "");
}

/**
 * Free text (error messages) before it is stored or shown, all-or-nothing (Ruling 18; docs/ledger-contract.md,
 * "Free-text secret scrubbing"): if the text, or its decoded form, looks secret, the result is SECRET_LIKE; otherwise
 * the text is returned unchanged. Nothing is rewritten in place, so no partial redaction can leave a secret behind.
 * Over-redaction is accepted: a key word followed by any character ("the bearer of good news") fails closed.
 */
export function scrubSecrets(text: string): string {
  return looksSecret(text) || looksSecret(normaliseForCheck(text)) ? SECRET_LIKE : text;
}
