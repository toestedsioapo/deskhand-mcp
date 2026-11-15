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

/**
 * The pattern pass: plain secret shapes become `[redacted]`, keeping the surrounding words. It only needs to know
 * plain text: encoded or escaped text that looks secret never reaches it (scrubSecrets step a), and anything it misses
 * is caught by the predicate on its output (step c). A replacement keeps a `key=` or `code=` prefix.
 */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // A value named by a secret key: `"access_token":"..."`, `client_secret = '...'` (quoted, up to the closing quote).
  [/(?<![A-Za-z])((?:access|refresh|id)_?token|client_?secret)(["']?\s*[=:]\s*)(["'])(?:(?!\3)[^\n])*\3?/gi, "$1$2$3[redacted]$3"],
  // The same, unquoted: `refresh_token=...`, `accessToken: ...` (up to a separator).
  [/(?<![A-Za-z])((?:access|refresh|id)_?token|client_?secret)(["']?\s*[=:]\s*)(?!["'])[^\s&"',;}]+/gi, "$1$2[redacted]"],
  // An OAuth authorization code: `code=4/0Aean...`, `"code":"4/0Aean..."`.
  [/(?<![A-Za-z])(code["']?\s*[=:]\s*["']?)4\/[\w.-]+/gi, "$1[redacted]"],
  [/Bearer\s+\S+/gi, "[redacted]"],
  // JWTs are not a regex here (`eyJ[\w-]+\.` backtracks quadratically on dot-less `eyJ` runs): see jwtSpans.
  [/ya29\.[\w.-]+/g, "[redacted]"],
  [/(?<![\w/])1\/\/[\w./-]+/g, "[redacted]"],
  // A refresh token as a URL path segment (`.../1//0gAB...`); a short `1//x` stays, it is not a token.
  [/(?<=\/)1\/\/[\w-]{10,}[\w./-]*/g, "[redacted]"],
  [/GOCSPX-[\w-]+/g, "[redacted]"],
];

/** Returned by scrubSecrets when the text holds, or may hide, a secret it cannot cut out cleanly. */
export const SECRET_LIKE = "[redacted: text contained secret-like data]";

/**
 * Ruling 17's predicate, regex part: deliberately simple and broad, case-insensitive. Token shapes (`ya29.`, `1//`,
 * `GOCSPX-`, auth code `4/0...`), or a secret key word followed by any number of separator characters (whitespace,
 * quotes, `:`, `=`) and then a value character that does not begin `[redacted]`, or `code` followed that way by `4/`.
 * The separator run is atomic (`(?=(run))\1`: a lookahead captures the whole run, the backreference consumes it), so
 * it can never be re-tried shorter; the run class and the value character are disjoint anyway. JWTs: see jwtSpans.
 */
const SECRET_SHAPE =
  /ya29\.[\w-]{10,}|1\/\/[\w-]{10,}|gocspx-[\w-]{6,}|4\/0[\w-]{10,}|(?:access_?token|refresh_?token|id_?token|client_?secret|authorization|bearer)(?=([\s"':=]*))\1(?!\[redacted\])[^\s"':=]|code(?=([\s"':=]*))(?:\2)4\//i;

const WORD_RUN = /[\w.-]+/g;

/**
 * The spans of three-part JWTs, as the regex `eyJ[\w-]+\.[\w-]+\.[\w-]+` (global, leftmost) would find them, by one
 * linear scan: each maximal run of `[\w.-]` is split on `.`; segments i, i+1 and i+2 form a JWT when all three are
 * non-empty and segment i holds `eyJ` with at least one character after it (the span starts at that `eyJ` and ends
 * with segment i+2). `ignoreCase` matches `eyj`, `EYJ`, ... (for the predicate).
 */
function jwtSpans(text: string, ignoreCase: boolean): [number, number][] {
  const spans: [number, number][] = [];
  const has = ignoreCase ? (s: string) => /eyj/i.test(s) : (s: string) => s.includes("eyJ");
  if (!has(text)) return spans;
  for (const run of text.matchAll(WORD_RUN)) {
    if (!has(run[0])) continue;
    const segs = run[0].split(".");
    const starts: number[] = [];
    let at = run.index;
    for (const s of segs) {
      starts.push(at);
      at += s.length + 1;
    }
    for (let i = 0; i + 2 < segs.length; i++) {
      const seg = segs[i]!;
      const p = (ignoreCase ? seg.toLowerCase() : seg).indexOf(ignoreCase ? "eyj" : "eyJ");
      if (p < 0 || p + 3 >= seg.length || segs[i + 1] === "" || segs[i + 2] === "") continue;
      spans.push([starts[i]! + p, starts[i + 2]! + segs[i + 2]!.length]);
      i += 2; // the next match can start no earlier than the segment after this JWT
    }
  }
  return spans;
}

/** Replaces each JWT span with `[redacted]`. */
function redactJwts(text: string): string {
  const spans = jwtSpans(text, false);
  if (spans.length === 0) return text;
  let out = "";
  let last = 0;
  for (const [a, b] of spans) {
    out += `${text.slice(last, a)}[redacted]`;
    last = b;
  }
  return out + text.slice(last);
}

export function looksSecret(text: string): boolean {
  return SECRET_SHAPE.test(text) || jwtSpans(text, true).length > 0;
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
 * Removes OAuth secrets from free text (error messages) before it is stored or shown (Ruling 17;
 * docs/ledger-contract.md, "Free-text secret scrubbing"):
 * a. if the decoded input differs from the input and looks secret, the whole text is SECRET_LIKE (any encoded or
 *    escaped secret fails closed);
 * b. otherwise the pattern pass replaces plain secret shapes with `[redacted]`, keeping the surrounding words;
 * c. if the result still looks secret, it is SECRET_LIKE; else the result is returned.
 * Over-redaction is accepted: a key word in prose followed by a word ("the bearer of good news") fails closed.
 */
export function scrubSecrets(text: string): string {
  const decoded = normaliseForCheck(text);
  if (decoded !== text && looksSecret(decoded)) return SECRET_LIKE;
  let out = redactJwts(text);
  for (const [p, r] of SECRET_PATTERNS) out = out.replace(p, r);
  return looksSecret(out) ? SECRET_LIKE : out;
}
