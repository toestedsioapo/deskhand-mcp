import { createHash } from "node:crypto";

/**
 * Canonical JSON for plan_hash: object keys sorted recursively, no whitespace,
 * undefined properties dropped, scalars via JSON.stringify. Dates must already
 * be ISO strings; Date and non-finite numbers throw.
 */
export function canonicalJson(value: unknown): string {
  const out = canon(value);
  if (out === undefined) throw new TypeError("cannot canonicalise undefined");
  return out;
}

function canon(value: unknown): string | undefined {
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
    return `[${value.map((v) => canon(v) ?? "null").join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const c = canon(obj[key]);
    if (c !== undefined) parts.push(`${JSON.stringify(key)}:${c}`);
  }
  return `{${parts.join(",")}}`;
}

export function planHash(plan: unknown): string {
  return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}

export function hashPrefix(hash: string): string {
  return hash.slice(0, 8);
}
