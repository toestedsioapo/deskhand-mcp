import { readFileSync } from "node:fs";
import { partyRulesSchema, type PartyRules } from "../tempo/index.js";

export type OwnRulesResult = { ok: true; rules: PartyRules } | { ok: false; message: string };

/** Reads and validates the caller's working-hours rules on every call. Never throws; messages name the path, never the file's content. */
export function loadOwnRules(path: string): OwnRulesResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, message: `Own working-hours rules not found at ${path}. Create that file or pass the own_rules field.` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, message: `Own working-hours rules at ${path} are not valid JSON. Fix the file or pass the own_rules field.` };
  }
  const parsed = partyRulesSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, message: `Own working-hours rules at ${path} are invalid (${issues}). Fix the file or pass the own_rules field.` };
  }
  return { ok: true, rules: parsed.data };
}
