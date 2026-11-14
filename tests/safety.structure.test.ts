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

/** The tools that create plans (call createPlan). Explicit list; extend only with review. */
const PLAN_TOOLS = ["src/tools/calendar-propose-event.ts"];

/** Files allowed to SET actions.status to 'approved' or write the approval columns. Explicit list; extend only with review. */
const APPROVE_ALLOWED = ["src/approval/approve.ts"];

/** An SQL SET clause (up to its WHERE / end of string) that assigns status 'approved'. */
const SETS_APPROVED = /\bSET\b(?:(?!\bWHERE\b)[^;`"])*?\bstatus\s*=\s*'approved'/i;
/** An assignment (`col = ...`, not `==`/`!==`/`:`) to any approval column. */
const WRITES_APPROVAL_COLUMN = /(?<![=!<>.\w])\b(approved_by|approved_at|approval_method|approved_plan_hash)\s*=(?!=)/;

/** A status assignment from a bound parameter; a transition must spell its target status literally. */
const PARAM_STATUS = /\bstatus\s*=\s*\?/i;
/** An import specifier that reaches into the CLI layer (`cli/...`). */
const CLI_IMPORT = /(^|\/)cli\//;

/** The [start, end) span of `async <name>(` ... its closing `\n    },\n` in a provider object literal; throws if absent. */
function methodBody(text: string, name: string): { start: number; end: number } {
  const start = text.indexOf(`async ${name}(`);
  if (start <= 0) throw new Error(`no method ${name}`);
  const end = text.indexOf("\n    },\n", start);
  if (end <= start) throw new Error(`no end for method ${name}`);
  return { start, end };
}

/** "POST" string literals (any quote), not counting the `"GET" | "POST"` method type. */
function postLiterals(text: string): number {
  return (text.replace(/"GET"\s*\|\s*"POST"/g, "").match(/["'`]POST["'`]/g) ?? []).length;
}

/** Each `fetch(` call with its callee and first argument, e.g. `deps.fetch(req.url,`. */
function fetchCalls(text: string): string[] {
  return [...text.matchAll(/(?:[\w.]+\.)?\bfetch\s*\(\s*[^,)]*,?/g)].map((m) => m[0].replace(/\s+/g, "")).sort();
}

describe("safety structure", () => {
  it("scans a non-trivial source tree", () => {
    expect(FILES.map((f) => f.path)).toContain("src/approval/plan-kinds.ts");
    expect(FILES.map((f) => f.path)).toContain("src/approval/apply.ts");
  });

  it("the provider write `createEvent` is referenced outside src/providers only by src/approval/plan-kinds.ts", () => {
    expect(matching(/\bcreateEvent\b/, (p) => !p.startsWith("src/providers/"))).toEqual(["src/approval/plan-kinds.ts"]);
  });

  it("the Google adapter's events insert (a literal `method: \"POST\"` with the write scope) lives only inside createEvent", () => {
    const google = FILES.filter((f) => f.path.startsWith("src/providers/google/"));
    // Outside calendar.ts: no literal POST except the OAuth token endpoint, and the write scope is only compared, never requested.
    expect(google.filter((f) => /method:\s*["']POST["']/.test(f.text)).map((f) => f.path).sort()).toEqual([
      "src/providers/google/calendar.ts",
      "src/providers/google/oauth.ts",
    ]);
    expect(google.filter((f) => /requiredScope:\s*SCOPE_CALENDAR_WRITE/.test(f.text)).map((f) => f.path)).toEqual([
      "src/providers/google/calendar.ts",
    ]);
    const cal = google.find((f) => f.path === "src/providers/google/calendar.ts")!.text;
    const { start, end } = methodBody(cal, "createEvent");
    const outside = cal.slice(0, start) + cal.slice(end);
    expect(outside).not.toMatch(/requiredScope:\s*SCOPE_CALENDAR_WRITE/);
    expect(cal.slice(start, end)).toMatch(/method:\s*["']POST["']/);
  });

  it("calendar.ts sends a POST from exactly two call sites: createEvent's insert and freeBusy's POST /freeBusy", () => {
    const cal = FILES.find((f) => f.path === "src/providers/google/calendar.ts")!.text;
    // Every "POST" string literal in the file, wherever it is (a helper parameter, a type, a positional argument).
    const posts = [...cal.matchAll(/["'`]POST["'`]/g)].map((m) => m.index);
    expect(posts).toHaveLength(2);
    const insert = methodBody(cal, "createEvent");
    const freeBusy = methodBody(cal, "freeBusy");
    const inInsert = posts.filter((i) => i > insert.start && i < insert.end);
    const inFreeBusy = posts.filter((i) => i > freeBusy.start && i < freeBusy.end);
    expect(inInsert).toHaveLength(1);
    expect(inFreeBusy).toHaveLength(1);
    expect(cal.slice(freeBusy.start, freeBusy.end)).toMatch(/method:\s*"POST",\s*url:\s*`\$\{BASE\}\/freeBusy`/);
    // Every request goes through googleRequest with a literal method: no variable method, no other transport.
    expect([...cal.matchAll(/method:\s*([^,\s}]+)/g)].map((m) => m[1]).sort()).toEqual(['"GET"', '"POST"', '"POST"']);
    expect(cal).not.toMatch(/\bfetch\s*\(/);
  });

  it("methodBody finds a real, non-empty span (the guards above cannot pass vacuously)", () => {
    const cal = FILES.find((f) => f.path === "src/providers/google/calendar.ts")!.text;
    for (const name of ["createEvent", "freeBusy"]) {
      const { start, end } = methodBody(cal, name);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start + 50);
    }
    expect(() => methodBody(cal, "noSuchMethod")).toThrow();
  });

  it("every file in src/providers/google/: only oauth.ts (token endpoint) and calendar.ts (insert, freeBusy) can POST", () => {
    const google = FILES.filter((f) => f.path.startsWith("src/providers/google/"));
    expect(google.length).toBeGreaterThanOrEqual(5);
    const name = (p: string) => p.slice("src/providers/google/".length);
    // A "POST" string anywhere (a variable, an argument, a property), except the `"GET" | "POST"` type of http.ts.
    expect(
      Object.fromEntries(google.map((f) => [name(f.path), postLiterals(f.text)]).filter(([, n]) => n !== 0)),
    ).toEqual({ "calendar.ts": 2, "oauth.ts": 1 });
    // Network calls: http.ts `send` (deps.fetch) and the refresh pass-through to the token endpoint; oauth.ts postToken.
    expect(Object.fromEntries(google.map((f) => [name(f.path), fetchCalls(f.text)]).filter(([, c]) => c.length > 0))).toEqual({
      "http.ts": ["deps.fetch(req.url,", "deps.oauth.fetch(u,"],
      "oauth.ts": ["deps.fetch(deps.endpoints.tokenUrl,"],
    });
    // No other transport: no node:https, undici or http(s).request; node:http only for oauth.ts's loopback listener.
    for (const f of google) {
      expect(f.text, f.path).not.toMatch(/["']node:https["']|["']undici["']|\bhttps?\.request\b|\brequest\s*\(/);
      if (f.path.endsWith("/oauth.ts")) expect(f.text).toMatch(/import \{ createServer, type Server, type ServerResponse \} from "node:http";/);
      else expect(f.text, f.path).not.toMatch(/["']node:http["']/);
    }
    // http.ts only forwards the method it is given.
    const http = google.find((f) => f.path.endsWith("/http.ts"))!.text;
    expect([...http.matchAll(/\bmethod\s*:\s*([^,;}\n]+)/g)].map((m) => m[1]!.trim()).sort()).toEqual([
      '"GET" | "POST"',
      '"GET" | "POST"',
      "req.method",
    ]);
    // googleRequest is called from calendar.ts only, from exactly three places (get, freeBusy, createEvent).
    const calls = FILES.flatMap((f) =>
      [...f.text.matchAll(/(?<!function )\bgoogleRequest\s*\(/g)].map(() => f.path),
    );
    expect(calls).toEqual(["src/providers/google/calendar.ts", "src/providers/google/calendar.ts", "src/providers/google/calendar.ts"]);
    // calendar.ts never passes a method by shorthand (`{ method }`), so every method is a visible literal.
    const cal = google.find((f) => f.path.endsWith("/calendar.ts"))!.text;
    expect(cal).not.toMatch(/[{,]\s*method\s*[,}]/);
  });

  it("the provider POST guards detect what they are meant to detect (self-test)", () => {
    const evil = 'const m = "POST";\nconst r = await googleRequest(deps, op, { method: m, url, requiredScope: SCOPE_CALENDAR_READ });\nawait fetch(url, { method: `POST` });';
    expect(postLiterals(evil)).toBe(2);
    expect(fetchCalls(evil)).toEqual(["fetch(url,"]);
    expect(postLiterals('req: { method: "GET" | "POST"; url: string }')).toBe(0);
    expect(postLiterals("method: 'POST'")).toBe(1);
    expect(/[{,]\s*method\s*[,}]/.test("googleRequest(deps, op, { method, url })")).toBe(true);
  });

  it("createPlan is imported and mentioned only by the plan tools listed in PLAN_TOOLS (outside src/approval)", () => {
    const outside = (p: string) => !p.startsWith("src/approval/");
    expect(matching(/\bimport\s*\{[^}]*\bcreatePlan\b[^}]*\}\s*from/, outside)).toEqual(PLAN_TOOLS);
    expect(matching(/\bcreatePlan\b/, outside)).toEqual(PLAN_TOOLS);
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
    // providers/types (interface) and providers/errors (error classes) are importable. src/cli/auth.ts is the one CLI file allowed to import src/providers/google (OAuth login; it never calls provider writes).
    const offenders = FILES.filter((f) => /^src\/(tools|cli)\//.test(f.path)).flatMap((f) => {
      const google = f.path === "src/cli/auth.ts" ? /providers\/google\/(client-file|oauth|token-store)(\.js)?$/ : /(?!)/;
      const bad = importSpecifiers(f.text).filter(
        (s) => /providers\//.test(s) && !/providers\/(types|errors)(\.js)?$/.test(s) && !google.test(s),
      );
      if (/\bcreateEvent\b|\.\s*execute\s*\(/.test(f.text)) bad.push("<provider write call>");
      return bad.map((b) => `${f.path}: ${b}`);
    });
    expect(offenders).toEqual([]);
  });

  it("only src/composition.ts and src/cli/auth.ts import from src/providers/google/ (files inside it import each other)", () => {
    const importers = FILES.filter(
      (f) => !f.path.startsWith("src/providers/google/") && importSpecifiers(f.text).some((s) => /(^|\/)providers\/google(\/|$)/.test(s)),
    )
      .map((f) => f.path)
      .sort();
    expect(importers).toEqual(["src/cli/auth.ts", "src/composition.ts"]);
  });

  it(`status 'approved' is SET only in ${APPROVE_ALLOWED.join(", ")}`, () => {
    expect(matching(SETS_APPROVED)).toEqual(APPROVE_ALLOWED);
  });

  it(`approval columns are written only in ${APPROVE_ALLOWED.join(", ")}`, () => {
    expect(matching(WRITES_APPROVAL_COLUMN)).toEqual(APPROVE_ALLOWED);
    // An INSERT into actions must never carry approval columns either.
    expect(matching(/INSERT\s+INTO\s+actions\b[^;]*?\b(approved_by|approved_at|approval_method|approved_plan_hash)\b/i)).toEqual([]);
  });

  it("the approval guards detect what they are meant to detect (self-test)", () => {
    expect(SETS_APPROVED.test("UPDATE actions SET status = 'approved', approved_by = ?")).toBe(true);
    expect(SETS_APPROVED.test(`UPDATE actions SET x = 1, status='approved' WHERE id = ?`)).toBe(true);
    // A WHERE-clause comparison (apply.ts) is not a SET.
    expect(SETS_APPROVED.test("UPDATE actions SET status = 'failed' WHERE id = ? AND status = 'approved'")).toBe(false);
    expect(WRITES_APPROVAL_COLUMN.test("approved_plan_hash = ?")).toBe(true);
    expect(WRITES_APPROVAL_COLUMN.test("hash !== row.approved_plan_hash || x")).toBe(false);
    expect(WRITES_APPROVAL_COLUMN.test("approved_by: a.approved_by")).toBe(false);
  });

  it("approveAction / rejectAction are imported only by src/cli (never by a tool or the server)", () => {
    const importers = FILES.filter((f) => importSpecifiers(f.text).some((s) => /approval\/approve(\.js)?$|^\.\/approve(\.js)?$/.test(s)))
      .map((f) => f.path)
      .sort();
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((p) => !p.startsWith("src/cli/"))).toEqual([]);
    expect(importers).toContain("src/cli/approve.ts");
  });

  it("no status is ever SET from a bound parameter (`status = ?`): every transition names its literal target", () => {
    expect(matching(PARAM_STATUS)).toEqual([]);
  });

  it("nothing outside src/cli/ and src/cli.ts imports from cli/ (tools, server, approval stay CLI-free)", () => {
    const offenders = FILES.filter((f) => !f.path.startsWith("src/cli/") && f.path !== "src/cli.ts").flatMap((f) =>
      importSpecifiers(f.text)
        .filter((s) => CLI_IMPORT.test(s))
        .map((s) => `${f.path}: ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it("only src/tempo/ imports @marvinliem/tempo-core (ADR 0006)", () => {
    const importers = FILES.filter((f) => importSpecifiers(f.text).some((s) => s.includes("@marvinliem/tempo-core")))
      .map((f) => f.path)
      .sort();
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((p) => !p.startsWith("src/tempo/"))).toEqual([]);
  });

  it("os.userInfo is used only by src/config/actor.ts (resolveActor has the fallback)", () => {
    expect(matching(/\buserInfo\b/)).toEqual(["src/config/actor.ts"]);
  });

  it("the status and cli-import guards detect what they are meant to detect (self-test)", () => {
    expect(PARAM_STATUS.test("UPDATE actions SET status = ? WHERE id = ?")).toBe(true);
    expect(PARAM_STATUS.test("SET status=?, error = ?")).toBe(true);
    expect(PARAM_STATUS.test("UPDATE actions SET status = 'failed' WHERE id = ? AND status = 'approved'")).toBe(false);
    expect(CLI_IMPORT.test("../cli/io.js")).toBe(true);
    expect(CLI_IMPORT.test("./cli/index.js")).toBe(true);
    expect(CLI_IMPORT.test("../util/sanitize.js")).toBe(false);
    expect(CLI_IMPORT.test("./client.js")).toBe(false);
  });

  it("no bypass flag or env var exists for approve", () => {
    const cli = FILES.filter((f) => f.path.startsWith("src/cli/") || f.path === "src/approval/approve.ts");
    for (const f of cli) {
      expect(f.text, f.path).not.toMatch(/--yes|--force|["']-y["']|DESKHAND_[A-Z_]*APPROVE/);
    }
  });
});
