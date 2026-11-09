import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for the "no side effects outside action_apply" rule.
 * Scans every src/**\/*.ts file as text; paths are repo-relative with "/".
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : [],
  );
}

const FILES = walk(SRC).map((abs) => ({
  path: relative(ROOT, abs).split(sep).join("/"),
  text: readFileSync(abs, "utf8"),
}));

const matching = (re: RegExp, filter: (p: string) => boolean = () => true) =>
  FILES.filter((f) => filter(f.path) && re.test(f.text)).map((f) => f.path).sort();

const importSpecifiers = (text: string): string[] =>
  [...text.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => (m[1] ?? m[2])!,
  );

/** Files allowed to SET actions.status to 'approved' (enabled in Task 5). */
const APPROVE_ALLOWED = ["src/approval/approve.ts"];

describe("safety structure", () => {
  it("scans a non-trivial source tree", () => {
    expect(FILES.map((f) => f.path)).toContain("src/approval/plan-kinds.ts");
    expect(FILES.map((f) => f.path)).toContain("src/approval/apply.ts");
  });

  it("the provider write `createEvent` is referenced outside src/providers only by src/approval/plan-kinds.ts", () => {
    expect(matching(/\bcreateEvent\b/, (p) => !p.startsWith("src/providers/"))).toEqual(["src/approval/plan-kinds.ts"]);
  });

  it("a plan kind's execute is called only from src/approval/apply.ts", () => {
    const call = /\.\s*execute\s*\(|\[\s*["'`]execute["'`]\s*\]/;
    expect(matching(call)).toEqual(["src/approval/apply.ts"]);
  });

  it("only the action_apply tool imports the apply engine", () => {
    const importers = FILES.filter((f) => importSpecifiers(f.text).some((s) => /approval\/apply(\.js)?$|^\.\/apply(\.js)?$/.test(s)))
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual(["src/tools/action-apply.ts"]);
  });

  it("nothing in src/tools or src/cli imports provider implementations or calls provider writes", () => {
    const offenders = FILES.filter((f) => /^src\/(tools|cli)\//.test(f.path)).flatMap((f) => {
      const bad = importSpecifiers(f.text).filter((s) => /providers\//.test(s) && !/providers\/types(\.js)?$/.test(s));
      if (/\bcreateEvent\b|\.\s*execute\s*\(/.test(f.text)) bad.push("<provider write call>");
      return bad.map((b) => `${f.path}: ${b}`);
    });
    expect(offenders).toEqual([]);
  });

  it.todo(
    `status 'approved' is SET only in ${APPROVE_ALLOWED.join(", ")} (allowed-file list: ${JSON.stringify(APPROVE_ALLOWED)}; enabled in Task 5)`,
  );
});
