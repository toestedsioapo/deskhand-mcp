import { createHash } from "node:crypto";

/**
 * Canonical JSON for plan_hash: object keys sorted recursively, no whitespace,
 * undefined properties dropped, scalars via JSON.stringify. Dates must already
 * be ISO strings; Date and non-finite numbers throw.
 */
export function canonicalJson(value: unknown): string {
  const out = canon(value, 0);
  if (out === undefined) throw new TypeError("cannot canonicalise undefined");
  return out;
}

const MAX_DEPTH = 256;

function canon(value: unknown, depth: number): string | undefined {
  if (depth > MAX_DEPTH) throw new RangeError("input too deep to canonicalise");
  if (value === undefined) return undefined;
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("cannot canonicalise a non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalise a ${typeof value}`);
  }
  if (value instanceof Date) throw new TypeError("Date is not allowed; pass an ISO-8601 string");
  if (Array.isArray(value)) {
    return `[${value.map((v) => canon(v, depth + 1) ?? "null").join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const c = canon(obj[key], depth + 1);
    if (c !== undefined) parts.push(`${JSON.stringify(key)}:${c}`);
  }
  return `{${parts.join(",")}}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What plan_hash covers (ADR 0010). For an object with `kind: "mail.create_draft_reply"` and an object `draft`: a
 * copy without `draft.body` and `draft.bodyRemoved` (the hash covers the body through `draft.bodySha256`, so the
 * sweep that removes the body never changes the hash). Anything else is returned unchanged, so every calendar hash
 * is the hash of the plan itself, as before. The input is never mutated.
 */
export function hashablePlan(plan: unknown): unknown {
  if (!isObject(plan) || plan["kind"] !== "mail.create_draft_reply" || !isObject(plan["draft"])) return plan;
  const { body: _body, bodyRemoved: _removed, ...draft } = plan["draft"];
  return { ...plan, draft };
}

/** sha256 of the canonical JSON of hashablePlan(plan). The plan store, approve, apply and pending all hash through it. */
export function planHash(plan: unknown): string {
  return createHash("sha256").update(canonicalJson(hashablePlan(plan)), "utf8").digest("hex");
}

export function hashPrefix(hash: string): string {
  return hash.slice(0, 8);
}
