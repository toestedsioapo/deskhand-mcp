import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { selectProvider } from "../src/composition.js";
import { ProviderError } from "../src/providers/errors.js";
import { createFixtureMailProvider } from "../src/providers/fixture/index.js";
import type { MailProvider } from "../src/providers/types.js";
import { makeTempHome } from "./helpers/home.js";

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
const PLAN_TOOLS = ["src/tools/calendar-propose-event.ts", "src/tools/inbox-draft-reply.ts"];

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

/** "POST" string literals in any case and quote (fetch upper-cases `"post"`), not counting the `"GET" | "POST"` type. */
function postLiterals(text: string): number {
  return (text.replace(/"GET"\s*\|\s*"POST"/gi, "").match(/["'`]post["'`]/gi) ?? []).length;
}

/** Every line that names `<word>` at all (a call, a declaration, an alias, `.call`/`.bind`), trimmed. */
function linesNaming(text: string, word: string): string[] {
  const re = new RegExp(`\\b${word}\\b`);
  return text.split("\n").map((l) => l.trim()).filter((l) => re.test(l));
}

/** An indirect call (`.call(`/`.apply(`/`.bind(`) or an alias (`= fetch`, `= deps.fetch`, `= googleRequest`). */
const INDIRECT = /\b(?:fetch|googleRequest)\s*\.\s*(?:call|apply|bind)\b|=\s*(?:[\w.]+\.)?(?:fetch|googleRequest)\s*(?:[;,)]|$)/m;

/** googleRequest's arguments: `deps, op,` then an inline object literal whose first properties are the literal calendar service and a literal method. */
const INLINE_REQUEST = /^deps, op, \{\s*service: "calendar",\s*method: "(?:GET|POST)",/;

/** An import that renames googleRequest (`googleRequest as x`). */
const ALIASED_IMPORT = /\bimport\b[^;]*\bgoogleRequest\s+as\b/;

/** The argument text of each `<name>(` call (not its `function <name>(` declaration), up to the matching `)`. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`(?<!function )\\b${name}\\s*\\(`, "g"))) {
    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push(text.slice(open, i - 1));
  }
  return out;
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
      "src/providers/google/gmail.ts",
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

  it("every file in src/providers/google/: only oauth.ts (token endpoint), calendar.ts (insert, freeBusy) and gmail.ts (createDraft) can POST", () => {
    const google = FILES.filter((f) => f.path.startsWith("src/providers/google/"));
    expect(google.length).toBeGreaterThanOrEqual(5);
    const name = (p: string) => p.slice("src/providers/google/".length);
    // A "POST" string anywhere (a variable, an argument, a property), except the `"GET" | "POST"` type of http.ts.
    expect(
      Object.fromEntries(google.map((f) => [name(f.path), postLiterals(f.text)]).filter(([, n]) => n !== 0)),
    ).toEqual({ "calendar.ts": 2, "gmail.ts": 1, "http.ts": 1, "oauth.ts": 1 });
    // http.ts's one "POST" is the Gmail allowlist's only write row (create a draft); it sends nothing by itself.
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
      "string", // assertAllowedGmailRequest(method: string, url): it only compares the method
    ]);
    // Every line naming fetch at all, pinned: no `.call`/`.bind`, alias or extra reference can slip in.
    expect(Object.fromEntries(google.map((f) => [name(f.path), linesNaming(f.text, "fetch")]).filter(([, l]) => l.length > 0))).toEqual({
      "http.ts": [
        "fetch: typeof fetch;",
        "refreshAccessToken(client, current, { ...deps.oauth, fetch: (u, init) => deps.oauth.fetch(u, { ...init, signal }) }),",
        "const res = await deps.fetch(req.url, init);",
      ],
      "oauth.ts": ["fetch: typeof fetch;", "res = await deps.fetch(deps.endpoints.tokenUrl, {"],
    });
    // Every line naming googleRequest in src/: its definition, calendar.ts's import and its three calls, gmail.ts's
    // import and its two calls.
    expect(Object.fromEntries(FILES.map((f) => [f.path, linesNaming(f.text, "googleRequest").length]).filter(([, n]) => n !== 0))).toEqual({
      "src/providers/google/calendar.ts": 4,
      "src/providers/google/gmail.ts": 3,
      "src/providers/google/http.ts": 1,
    });
    // gmail.ts's two calls: an inline GET under the read scope, and createDraft's one POST to the drafts collection
    // under the compose scope, sent at most once.
    const gmailText = google.find((f) => f.path.endsWith("/gmail.ts"))!.text;
    const gmailCalls = callArgs(gmailText, "googleRequest").map((a) => a.replace(/\s+/g, " "));
    expect(gmailCalls).toEqual([
      'deps, op, { service: "gmail", method: "GET", url, requiredScope: SCOPE_GMAIL_READ }',
      'deps, op, { service: "gmail", method: "POST", url: `${BASE}/drafts`, body: { message: { raw, threadId: d.threadId } }, requiredScope: SCOPE_GMAIL_COMPOSE, singleSend: true, }',
    ]);
    const createDraft = methodBody(gmailText, "createDraft");
    expect(gmailText.slice(createDraft.start, createDraft.end)).toContain('method: "POST"');
    expect(FILES.filter((f) => INDIRECT.test(f.text)).map((f) => f.path)).toEqual([]);
    // The googleRequest import is never aliased, and no call spreads a request object into its arguments
    // (tests/google.write-surface.test.ts is the behavioural guard behind these).
    expect(FILES.filter((f) => ALIASED_IMPORT.test(f.text)).map((f) => f.path)).toEqual([]);
    const calArgs = callArgs(google.find((f) => f.path.endsWith("/calendar.ts"))!.text, "googleRequest");
    expect(calArgs).toHaveLength(3);
    expect(calArgs.filter((a) => a.includes("..."))).toEqual([]);
    // Each call passes an inline object literal that opens with a literal method, and asks for one of the two scope
    // constants by name: no request object built elsewhere, no scope from a variable.
    expect(calArgs.filter((a) => !INLINE_REQUEST.test(a))).toEqual([]);
    const calText = google.find((f) => f.path.endsWith("/calendar.ts"))!.text;
    expect([...calText.matchAll(/\brequiredScope\s*:\s*([^,}\s]+)/g)].map((m) => m[1]).sort()).toEqual([
      "SCOPE_CALENDAR_READ",
      "SCOPE_CALENDAR_READ",
      "SCOPE_CALENDAR_WRITE",
    ]);
    // googleRequest is called from exactly three places in calendar.ts (get, freeBusy, createEvent) and two in gmail.ts
    // (get, createDraft).
    const calls = FILES.flatMap((f) =>
      [...f.text.matchAll(/(?<!function )\bgoogleRequest\s*\(/g)].map(() => f.path),
    );
    expect(calls).toEqual([
      "src/providers/google/calendar.ts",
      "src/providers/google/calendar.ts",
      "src/providers/google/calendar.ts",
      "src/providers/google/gmail.ts",
      "src/providers/google/gmail.ts",
    ]);
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
    // Round-3 shapes: lowercase method, an indirect call and an alias.
    const sneaky =
      'await deps.fetch.call(undefined, insertUrl, { method: "post", body });\nconst g = googleRequest; await g(deps, op, { method: "post" as never, url });';
    expect(postLiterals(sneaky)).toBe(2);
    expect(INDIRECT.test("await deps.fetch.call(undefined, u)")).toBe(true);
    expect(INDIRECT.test("const g = googleRequest;")).toBe(true);
    expect(INDIRECT.test("const f = deps.fetch")).toBe(true);
    expect(INDIRECT.test("googleRequest.bind(null)")).toBe(true);
    expect(INDIRECT.test("const res = await deps.fetch(req.url, init);")).toBe(false);
    expect(linesNaming(sneaky, "fetch")).toHaveLength(1);
    expect(linesNaming(sneaky, "googleRequest")).toHaveLength(1);
    // Round-4 shapes: an alias import and a spread request object.
    expect(ALIASED_IMPORT.test('import { googleRequest, googleRequest as send, type GoogleHttpDeps } from "./http.js";')).toBe(true);
    expect(ALIASED_IMPORT.test('import { googleRequest, type GoogleHttpDeps } from "./http.js";')).toBe(false);
    const spread = "const res = await googleRequest(deps, op, fbReq);\nawait googleRequest(deps, op, { ...fbReq, url: `${BASE}/x(${id})` });";
    expect(callArgs(spread, "googleRequest")).toEqual(["deps, op, fbReq", "deps, op, { ...fbReq, url: `${BASE}/x(${id})` }"]);
    // Round-5 shape: a request object declared before the call and a write scope from a variable.
    const mutant = [
      "const w = SCOPE_CALENDAR_WRITE;",
      "const extra = { ...fbReq, url: `${cal(calendarId)}/events`, body: { summary: \"x\" }, requiredScope: w };",
      "for (const r of [extra, fbReq]) {",
      "  try { res = await googleRequest(deps, op, r); } catch (e) { if (r === fbReq) throw e; }",
      "}",
    ].join("\n");
    expect(callArgs(mutant, "googleRequest").filter((a) => !INLINE_REQUEST.test(a))).toEqual(["deps, op, r"]);
    expect(INLINE_REQUEST.test('deps, op, {\n        service: "calendar",\n        method: "POST",\n        url: `${BASE}/freeBusy`,')).toBe(true);
    expect(INLINE_REQUEST.test('deps, op, { service: "gmail", method: "GET", url }')).toBe(false);
    expect(INLINE_REQUEST.test('deps, op, { url, method: "GET" }')).toBe(false);
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
      if (/\bcreateEvent\b|\bcreateDraft\b|\.\s*execute\s*\(/.test(f.text)) bad.push("<provider write call>");
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

  it("MailProvider has no member whose name contains `send` (any case): on the type and on every provider object", async () => {
    // Type level (checked by `pnpm typecheck`): no key of MailProvider, lower-cased, contains "send".
    expectTypeOf<Extract<Lowercase<keyof MailProvider & string>, `${string}send${string}`>>().toEqualTypeOf<never>();
    // Negative control: the same check on an interface with a send member is not never, so the check above can fail.
    type WithSend = MailProvider & { sendMail(): void };
    expectTypeOf<Extract<Lowercase<keyof WithSend & string>, `${string}send${string}`>>().toEqualTypeOf<"sendmail">();
    expectTypeOf<Extract<Lowercase<keyof WithSend & string>, `${string}send${string}`>>().not.toBeNever();
    // Source level: the interface is declared, and no line inside it names a send member.
    const types = FILES.find((f) => f.path === "src/providers/types.ts")!.text;
    const start = types.indexOf("export interface MailProvider {");
    expect(start).toBeGreaterThan(-1);
    const body = types.slice(start, types.indexOf("\n}\n", start));
    expect(body).toMatch(/createDraft\(/);
    expect(body.split("\n").filter((l) => /^\s+\w*send\w*\s*[(:?]/i.test(l))).toEqual([]);
    // Object level: the fixture stub and both mail providers selectProvider wires.
    const home = makeTempHome();
    try {
      const objects: object[] = [createFixtureMailProvider()];
      for (const name of ["fixture", "google"]) {
        const { mail, provider } = selectProvider(loadConfig({ ...home.env, DESKHAND_PROVIDER: name }));
        expect(mail, name).not.toBeNull();
        expect(provider, name).not.toBeNull();
        objects.push(mail!);
      }
      for (const o of objects) {
        const keys = [...Object.keys(o), ...Object.getOwnPropertyNames(Object.getPrototypeOf(o))];
        expect(keys.filter((k) => /send/i.test(k))).toEqual([]);
        expect(keys).toContain("createDraft");
      }
      const none = selectProvider(loadConfig(home.env));
      expect([none.provider, none.mail]).toEqual([null, null]);
    } finally {
      home.cleanup();
    }
  });

  it("until a mailbox exists, the fixture refuses every call", async () => {
    const home = makeTempHome();
    try {
      const cases = [
        ["fixture", "fixture mail", "no mailbox in this world", ["profile", "searchThreads", "getThread", "threadMessageIds", "getDraft", "threadDrafts", "createDraft"]],
      ] as const;
      for (const [name, label, phrase, ops] of cases) {
        const mail = selectProvider(loadConfig({ ...home.env, DESKHAND_PROVIDER: name })).mail!;
        const calls: Record<string, () => Promise<unknown>> = {
          profile: () => mail.profile(),
          searchThreads: () => mail.searchThreads("x", 1),
          getThread: () => mail.getThread("t", 1),
          threadMessageIds: () => mail.threadMessageIds("t"),
          getDraft: () => mail.getDraft("d"),
          threadDrafts: () => mail.threadDrafts("t"),
          createDraft: () =>
            mail.createDraft(
              {
                threadId: "t", idempotencyKey: "k", inReplyTo: null, references: [],
                to: ["a@example.com"], cc: [], bcc: [], subject: "s", body: "b",
              },
              () => undefined,
            ),
        };
        for (const op of ops) {
          const err = await calls[op]!().then(() => undefined, (e: unknown) => e);
          expect(err, `${name} ${op}`).toBeInstanceOf(ProviderError);
          expect((err as ProviderError).message).toBe(`${label} ${op} failed: ${phrase}`);
          expect((err as ProviderError).retryable).toBe(false);
        }
      }
    } finally {
      home.cleanup();
    }
  });

  it("the mail write `createDraft(` appears only in src/approval/, the fixture and google providers and the interface", () => {
    const allowed = (p: string) =>
      p.startsWith("src/approval/") ||
      p.startsWith("src/providers/fixture/") ||
      p.startsWith("src/providers/google/") ||
      p === "src/providers/types.ts";
    expect(matching(/\bcreateDraft\s*\(/, (p) => !allowed(p))).toEqual([]);
    // Nothing in src/tools or src/cli even names it.
    expect(matching(/\bcreateDraft\b/, (p) => /^src\/(tools|cli)\//.test(p))).toEqual([]);
  });

  it("no bypass flag or env var exists for approve", () => {
    const cli = FILES.filter((f) => f.path.startsWith("src/cli/") || f.path === "src/approval/approve.ts");
    for (const f of cli) {
      expect(f.text, f.path).not.toMatch(/--yes|--force|["']-y["']|DESKHAND_[A-Z_]*APPROVE/);
    }
  });
});
