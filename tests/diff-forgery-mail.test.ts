import { afterEach, describe, expect, it } from "vitest";
import { applyAction, idempotencyKey } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import { mailCreateDraftReply } from "../src/approval/mail-draft-kind.js";
import { calendarCreateEvent, getPlanKind, renderDiff } from "../src/approval/plan-kinds.js";
import { createPlan } from "../src/approval/plans.js";
import { runCli } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/io.js";
import { getAction } from "../src/ledger/actions.js";
import { canonicalJson, planHash } from "../src/ledger/canonical.js";
import { LedgerDb } from "../src/ledger/db.js";
import { last4 } from "../src/ledger/ids.js";
import { omittedMarker } from "../src/ledger/redact.js";
import { EVENT_DELETED } from "../src/providers/errors.js";
import type { FixtureMailProvider } from "../src/providers/fixture/mail.js";
import { CONTINUATION, isBodyLine, normaliseBody, termWidth } from "../src/util/sanitize.js";
import { setupHarness } from "./helpers/harness.js";
import { msg, useMail } from "./helpers/mail-world.js";
import { bodyFields, DRAFT_BODY, seedAction, validDraftPlan, validPlan } from "./helpers/seed.js";

// The approve diff of a draft reply (M4a, decision 3): nothing in an agent-written body or a stored row may forge a
// field, hide a line, or make the text the human approves differ from the draft that is written.
// Plain ASCII file: special characters are built from code points.
const cp = (...n: number[]): string => String.fromCodePoint(...n);
const ESC = cp(0x1b);

/** The 41 hidden characters of tests/diff-forgery.test.ts. */
const HIDDEN: [string, number][] = [
  ["CR", 0x0d],
  ["VT", 0x0b],
  ["FF", 0x0c],
  ["NEL U+0085", 0x85],
  ["LS U+2028", 0x2028],
  ["PS U+2029", 0x2029],
  ["BS", 0x08],
  ["NUL", 0x00],
  ["DEL", 0x7f],
  ["CSI U+009B", 0x9b],
  ["OSC U+009D", 0x9d],
  ["LRE U+202A", 0x202a],
  ["RLE U+202B", 0x202b],
  ["PDF U+202C", 0x202c],
  ["LRO U+202D", 0x202d],
  ["RLO U+202E", 0x202e],
  ["LRI U+2066", 0x2066],
  ["RLI U+2067", 0x2067],
  ["FSI U+2068", 0x2068],
  ["PDI U+2069", 0x2069],
  ["LRM U+200E", 0x200e],
  ["RLM U+200F", 0x200f],
  ["ALM U+061C", 0x061c],
  ["ZWSP U+200B", 0x200b],
  ["ZWNJ U+200C", 0x200c],
  ["ZWJ U+200D", 0x200d],
  ["WJ U+2060", 0x2060],
  ["BOM U+FEFF", 0xfeff],
  ["soft hyphen U+00AD", 0xad],
  ["MVS U+180E", 0x180e],
  ["CGJ U+034F", 0x034f],
  ["tag space U+E0020", 0xe0020],
  ["tag A U+E0041", 0xe0041],
  ["VS16 U+FE0F", 0xfe0f],
  ["VS17 U+E0100", 0xe0100],
  ["Hangul filler U+3164", 0x3164],
  ["Hangul choseong filler U+115F", 0x115f],
  ["Hangul jungseong filler U+1160", 0x1160],
  ["halfwidth Hangul filler U+FFA0", 0xffa0],
  ["Khmer inherent vowel U+17B5", 0x17b5],
  ["braille blank U+2800", 0x2800],
];

const HEAD = "create draft reply (not sent; Deskhand cannot send mail)";
const sha8 = (body: string) => bodyFields(body).bodySha256.slice(0, 8);

/** The decision-3 lines for validDraftPlan() up to and including the `body:` line. */
function headLines(body: string): string[] {
  return [
    HEAD,
    "thread: th_budget",
    "in reply to message: m2",
    "from: me@example.com",
    "subject: Re: Q4 budget",
    "new recipients: 1 not on this thread",
    "to: 2 recipient(s)",
    "  ana@example.com",
    "  ben@example.com",
    "cc: 1 recipient(s)",
    "  cara@example.com",
    "bcc: 1 recipient(s)",
    "  dan@example.com  (new: not on this thread)",
    `body: ${body.split("\n").length} lines, ${body.length} chars, sha256:${sha8(body)}`,
  ];
}

/** The agent audience of headLines (ruling R3): the subject and every address value become their omitted marker. */
function agentHeadLines(body: string): string[] {
  const m = omittedMarker;
  return [
    HEAD,
    "thread: th_budget",
    "in reply to message: m2",
    `from: ${m("me@example.com")}`,
    `subject: ${m("Re: Q4 budget")}`,
    "new recipients: 1 not on this thread",
    "to: 2 recipient(s)",
    `  ${m("ana@example.com")}`,
    `  ${m("ben@example.com")}`,
    "cc: 1 recipient(s)",
    `  ${m("cara@example.com")}`,
    "bcc: 1 recipient(s)",
    `  ${m("dan@example.com")}  (new: not on this thread)`,
    `body: ${body.split("\n").length} lines, ${body.length} chars, sha256:${sha8(body)}`,
  ];
}

const withBody = (body: string, over: Record<string, unknown> = {}) => validDraftPlan({}, { ...bodyFields(body), ...over });
/** The plan as the sweep leaves it: no `body`, `bodyRemoved: true`, the same bodyChars and bodySha256. */
function swept(plan: ReturnType<typeof validDraftPlan>) {
  const { body: _body, ...rest } = plan.draft;
  return { ...plan, draft: { ...rest, bodyRemoved: true } };
}

// ---------------------------------------------------------------- the body rules

describe("normaliseBody and isBodyLine", () => {
  for (const [name, code] of HIDDEN) {
    it(`refuses ${name}`, () => {
      expect(normaliseBody(`a${cp(code)}b`)).toBeNull();
      if (code !== 0x0d) expect(isBodyLine(`a${cp(code)}b`)).toBe(false);
    });
  }
  it("refuses a tab, a trailing space, a lone CR, 501 lines and 20 001 characters", () => {
    expect(normaliseBody("a\tb")).toBeNull();
    expect(normaliseBody("a \nb")).toBeNull();
    expect(normaliseBody("a\rb")).toBeNull();
    expect(normaliseBody("a\r")).toBeNull();
    expect(normaliseBody(Array.from({ length: 501 }, () => "x").join("\n"))).toBeNull();
    expect(normaliseBody("x".repeat(20_001))).toBeNull();
  });
  it("accepts 500 lines and 20 000 characters", () => {
    const five = Array.from({ length: 500 }, () => "x").join("\n");
    expect(normaliseBody(five)).toBe(five);
    expect(normaliseBody("x".repeat(20_000))).toBe("x".repeat(20_000));
  });
  it("turns CRLF into LF; a trailing newline is one empty last line (Review Focus 2)", () => {
    const b = normaliseBody("a\r\nb\r\n");
    expect(b).toBe("a\nb\n");
    const d = renderDiff(withBody(b!), "UTC", "approver");
    expect(d.slice(d.indexOf(`body: 3 lines, 4 chars, sha256:${sha8(b!)}`) + 1)).toEqual(["  > a", "  > b", "  >", "end of body"]);
  });
  it("accepts the signature separator `-- ` and refuses `--  `, `a ` and ` -- `", () => {
    expect(isBodyLine("-- ")).toBe(true);
    expect(normaliseBody("Me\n-- \nMe")).toBe("Me\n-- \nMe");
    for (const s of ["--  ", "a ", " -- "]) {
      expect(isBodyLine(s), JSON.stringify(s)).toBe(false);
      expect(normaliseBody(`x\n${s}\ny`), JSON.stringify(s)).toBeNull();
    }
  });
  it("accepts empty lines, leading spaces, repeated spaces, accents, CJK and a plain emoji", () => {
    for (const s of ["", "  > quoted", "a  b", `D${cp(0xe9)}j${cp(0xe0)}`, cp(0x65e5, 0x672c), cp(0x1f600)]) {
      expect(isBodyLine(s), JSON.stringify(s)).toBe(true);
    }
  });
  it("refuses stacked marks, an oversized grapheme and a leading extender", () => {
    expect(isBodyLine(`a${cp(0x301).repeat(5)}`)).toBe(false);
    expect(isBodyLine(`x${cp(0x915, 0x94d).repeat(5)}${cp(0x915)}`)).toBe(false); // one conjunct of 11 code points
    expect(isBodyLine(`${cp(0x301)}a`)).toBe(false);
    expect(isBodyLine(`x${cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466, 0x200d, 0x1f468)}`)).toBe(false);
  });
  it("refuses an empty body", () => expect(normaliseBody("")).toBeNull());
});

// ---------------------------------------------------------------- the diff

describe("the draft diff (decision 3)", () => {
  it("is the registered kind", () => expect(getPlanKind("mail.create_draft_reply")).toBe(mailCreateDraftReply));

  it("approver: exactly the decision-3 lines for 2 to, 1 cc and 1 new bcc", () => {
    expect(renderDiff(validDraftPlan(), "UTC", "approver")).toEqual([
      ...headLines(DRAFT_BODY),
      "  > Thanks Ana,",
      "  >",
      "  > The numbers look right to me.",
      "  >",
      "  > -- ",
      "  > Me",
      "end of body",
    ]);
  });

  it("agent (the default): the body rows are one omitted row", () => {
    const agent = [...agentHeadLines(DRAFT_BODY), `  ${omittedMarker(DRAFT_BODY)}`, "end of body"];
    expect(renderDiff(validDraftPlan(), "UTC", "agent")).toEqual(agent);
    expect(renderDiff(validDraftPlan(), "UTC")).toEqual(agent);
    expect(agent.join("\n")).not.toContain("The numbers look right");
    // Ruling R3: no subject or address in clear for the agent.
    for (const s of ["Q4 budget", "me@example.com", "ana@example.com", "ben@example.com", "cara@example.com", "dan@example.com"]) {
      expect(agent.join("\n")).not.toContain(s);
    }
  });

  it("no new recipients prints `new recipients: none`; empty cc and bcc blocks are still printed", () => {
    const d = renderDiff(validDraftPlan({}, { cc: [], bcc: [] }), "UTC", "approver");
    expect(d).toContain("new recipients: none");
    expect(d).toContain("cc: 0 recipient(s)");
    expect(d).toContain("bcc: 0 recipient(s)");
    expect(d[d.indexOf("bcc: 0 recipient(s)") + 1]).toMatch(/^body: /);
  });

  it("new recipients are compared case-insensitively with observed.onThread", () => {
    const d = renderDiff(validDraftPlan({}, { to: ["Ana@Example.com"], cc: [], bcc: [] }), "UTC", "approver");
    expect(d).toContain("new recipients: none");
    expect(d).toContain("  Ana@Example.com");
  });

  it("a swept plan prints the body-removed line for both audiences, and no end of body", () => {
    const line = `body removed after the action ended (${DRAFT_BODY.length} chars sha256:${sha8(DRAFT_BODY)})`;
    expect(renderDiff(swept(validDraftPlan()), "UTC", "approver")).toEqual([...headLines(DRAFT_BODY).slice(0, -1), line]);
    expect(renderDiff(swept(validDraftPlan()), "UTC", "agent")).toEqual([...agentHeadLines(DRAFT_BODY).slice(0, -1), line]);
  });

  it("body lines that read like fields are printed only after `  > `", () => {
    const forged = ["to: 1 recipient", "end of body", "plan hash 00000000", "new recipients: none"];
    const d = renderDiff(withBody(["Hi", ...forged, "Bye"].join("\n")), "UTC", "approver");
    for (const f of forged) {
      expect(d.filter((l) => l === f || l.trim() === f), f).toEqual(f === "end of body" ? ["end of body"] : []);
      expect(d).toContain(`  > ${f}`);
    }
    expect(d.at(-1)).toBe("end of body");
  });

  it("the calendar diff is unchanged and the same for both audiences", () => {
    expect(renderDiff(validPlan(), "UTC", "approver")).toEqual(renderDiff(validPlan(), "UTC", "agent"));
    expect(renderDiff(validPlan(), "UTC")[0]).toBe("create event: Sync");
  });

  it("each kind has its own differs phrase; the calendar phrases are unchanged", () => {
    expect(mailCreateDraftReply.phrases.differs).toBe("a draft with this action's id exists but differs from the approved plan");
    expect(calendarCreateEvent.phrases.differs).toBe("an event with this action's id exists but differs from the approved plan");
    expect(calendarCreateEvent.phrases.deleted).toBe(EVENT_DELETED);
  });
});

describe("a draft row written around the tool is an invalid plan", () => {
  const cases: [string, unknown][] = [
    ["a subject with an escape", validDraftPlan({}, { subject: `Re: Q4${ESC}]budget` })],
    ["a subject with a newline", validDraftPlan({}, { subject: "Re: Q4\nto: 0 recipient(s)" })],
    ["a 251-character subject", validDraftPlan({}, { subject: "x".repeat(251) })],
    ["a body with an escape (bodyChars and bodySha256 match)", withBody(`Hi${ESC}]evil`)],
    ["a body with a tab", withBody("a\tb")],
    ["a body with a lone CR", withBody("a\rb")],
    ["both body and bodyRemoved", validDraftPlan({}, { bodyRemoved: true })],
    [
      "neither body nor bodyRemoved",
      (() => {
        const p = validDraftPlan();
        const { body: _body, ...draft } = p.draft;
        return { ...p, draft };
      })(),
    ],
    ["no to", validDraftPlan({}, { to: [] })],
    ["the same address in to and bcc", validDraftPlan({}, { bcc: ["ANA@example.com"] })],
    ["51 recipients", validDraftPlan({}, { cc: Array.from({ length: 49 }, (_, k) => `p${k}@example.com`) })],
    ["a non-ASCII address", validDraftPlan({}, { to: [`jos${cp(0xe9)}@example.com`] })],
    ["an address with a newline", validDraftPlan({}, { to: ["eve@example.com\nbcc: 0 recipient(s)"] })],
    ["a threadId with a space", validDraftPlan({}, { threadId: "th budget" })],
    ["an inReplyTo that is not <...> shaped", validDraftPlan({}, { inReplyTo: "m2@example.com" })],
    ["11 references", validDraftPlan({}, { references: Array.from({ length: 11 }, (_, k) => `<r${k}@x>`) })],
    ["a bodySha256 that is not 64 hex", validDraftPlan({}, { bodySha256: "abc" })],
    ["an unknown draft key", validDraftPlan({}, { attachments: [] })],
    ["a latestMessageId with an escape", validDraftPlan({ observed: { latestMessageId: `m2${ESC}`, onThread: [] } })],
  ];
  for (const [name, plan] of cases) {
    it(`${name}`, () => expect(renderDiff(plan, "UTC", "approver")).toEqual(["(invalid plan)"]));
  }
  it("the plan the helpers build is valid", () => expect(renderDiff(validDraftPlan(), "UTC")[0]).toBe(HEAD));
});

// ---------------------------------------------------------------- hashablePlan

describe("plan_hash leaves the body out (decision 2)", () => {
  it("the hash with the body equals the hash with bodyRemoved and no body", () => {
    expect(planHash(swept(validDraftPlan()))).toBe(planHash(validDraftPlan()));
  });
  it("bodySha256 is in the hash", () => {
    expect(planHash(validDraftPlan({}, { bodySha256: "f".repeat(64) }))).not.toBe(planHash(validDraftPlan()));
  });
});

// ---------------------------------------------------------------- CLI end to end

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const THREAD = {
  id: "th_budget",
  messages: [
    msg("m1", "2026-11-09T10:00:00.000Z", { message_id: "<m1@example.com>" }),
    msg("m2", "2026-11-09T11:00:00.000Z", { message_id: "<m2@example.com>", from: { address: "ben@example.com" } }),
  ],
};

async function harness(env: NodeJS.ProcessEnv = {}): Promise<H> {
  h = await setupHarness({ env });
  useMail(h, [THREAD]);
  return h;
}
const drafts = (hh: H) => (hh.ctx.mail as FixtureMailProvider).drafts;

function scripted(lines: string[] = [], columns?: number): CliIo & { outText: () => string } {
  let out = "";
  const q = [...lines];
  return {
    out: (s) => (out += s),
    err: () => undefined,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    ...(columns === undefined ? {} : { columns }),
    readLine: async () => q.shift() ?? "",
    outText: () => out,
  };
}
async function pendingText(hh: H, columns?: number): Promise<string> {
  const io = scripted([], columns);
  const code = await runCli(["pending"], io, () => ({ ...hh.ctx, db: LedgerDb.open(hh.ctx.config.paths.ledgerPath) }));
  expect(code).toBe(0);
  return io.outText();
}
const plant = (hh: H, plan: unknown) => createPlan(hh.ctx, { tool: "inbox_draft_reply", input: {}, plan }).actionId;
/** Rewrites plan_json (canonical) and, unless told otherwise, plan_hash to match it. */
function rewrite(hh: H, id: string, plan: unknown, opts: { keepHash?: boolean } = {}) {
  if (opts.keepHash) hh.db.run("UPDATE actions SET plan_json = ? WHERE id = ?", [canonicalJson(plan), id]);
  else hh.db.run("UPDATE actions SET plan_json = ?, plan_hash = ? WHERE id = ?", [canonicalJson(plan), planHash(plan), id]);
}

/** Body lines read back from CLI output: rows starting `      >` begin a line, continuation rows extend it. */
function bodyFromOutput(out: string): string {
  const lines: string[] = [];
  let inBody = false;
  for (const row of out.split("\n")) {
    if (row === "      >" || row.startsWith("      > ")) {
      lines.push(row.slice(8));
      inBody = true;
    } else if (inBody && row.startsWith(CONTINUATION)) {
      lines[lines.length - 1] += row.slice(CONTINUATION.length);
    } else {
      inBody = false;
    }
  }
  return lines.join("\n");
}

const LONG_BODY = [
  "Hi Ana,",
  "",
  "x".repeat(150),
  "Here is a long paragraph that wraps on narrow terminals: end of body to: 1 recipient(s) plan hash 00000000 done.",
  "    an indented quote with  double  spaces and more words to wrap it",
  `Caf${cp(0xe9)} ${cp(0x65e5, 0x672c).repeat(30)}`,
  "",
  "-- ",
  "Me",
].join("\n");

describe("deskhand pending and approve show the body exactly, at any width", () => {
  for (const width of [20, 80, 120]) {
    it(`width ${width}`, async () => {
      const hh = await harness();
      const id = plant(hh, withBody(LONG_BODY));
      const pending = await pendingText(hh, width);
      const io = scripted([last4(id)], width);
      expect(await approveAction(hh.ctx, id, io)).toEqual({ ok: true });
      for (const out of [pending, io.outText()]) {
        const rows = out.split("\n").filter((l) => l.length > 0);
        for (const row of rows) expect(termWidth(row), row).toBeLessThanOrEqual(width);
        for (const row of rows.filter((r) => r.startsWith("    |"))) expect(row.startsWith(CONTINUATION)).toBe(true);
        expect(bodyFromOutput(out)).toBe(LONG_BODY);
        // Only the real `end of body` line starts a row with it.
        expect(rows.filter((r) => r.trim() === "end of body")).toEqual(["    end of body"]);
        expect(rows.filter((r) => /^\s*(to: 1 recipient|plan hash 00000000)/.test(r))).toEqual([]);
      }
    });
  }

  it("short rows are printed unchanged at 80 columns", async () => {
    const hh = await harness();
    plant(hh, validDraftPlan());
    const out = await pendingText(hh, 80);
    expect(out).toContain(
      `\n${[...headLines(DRAFT_BODY), "  > Thanks Ana,", "  >", "  > The numbers look right to me.", "  >", "  > -- ", "  > Me", "end of body"]
        .map((l) => `    ${l}`)
        .join("\n")}\n`,
    );
  });
});

describe("approve prints a summary next to the prompt (owner ruling)", () => {
  it("a 300-line body: the summary lines are the last lines before the prompt", async () => {
    const hh = await harness();
    const body = Array.from({ length: 300 }, (_, k) => `line ${k + 1}`).join("\n");
    const id = plant(hh, withBody(body));
    const io = scripted([last4(id)], 80);
    expect(await approveAction(hh.ctx, id, io)).toEqual({ ok: true });
    const rows = io.outText().split("\n").filter((l) => l.length > 0);
    expect(rows.slice(-3)).toEqual(["summary: to 2, cc 1, bcc 1", "new recipients: 1 not on this thread", "subject: Re: Q4 budget"]);
    expect(rows.slice(-20)).toEqual(expect.arrayContaining(["summary: to 2, cc 1, bcc 1"]));
  });
  it("a long subject in the summary is wrapped like the diff", async () => {
    const hh = await harness();
    const subject = `Re: ${"budget ".repeat(30).trim()}`;
    const id = plant(hh, validDraftPlan({}, { subject }));
    const io = scripted([last4(id)], 40);
    expect(await approveAction(hh.ctx, id, io)).toEqual({ ok: true });
    const rows = io.outText().split("\n").filter((l) => l.length > 0);
    for (const row of rows) expect(termWidth(row)).toBeLessThanOrEqual(40);
    const tail = rows.slice(rows.indexOf("summary: to 2, cc 1, bcc 1"));
    expect(tail[1]).toBe("new recipients: 1 not on this thread");
    expect(tail[2]!.startsWith("subject: Re: ")).toBe(true);
    expect(tail.length).toBeGreaterThan(3);
    for (const r of tail.slice(3)) expect(r.startsWith(CONTINUATION)).toBe(true);
    expect([tail[2], ...tail.slice(3).map((r) => r.slice(CONTINUATION.length))].join("")).toBe(`subject: ${subject}`);
  });
  it("a calendar approve prints no summary", async () => {
    const hh = await harness();
    const id = seedAction(hh.ctx, "planned", validPlan());
    const io = scripted([last4(id)]);
    expect(await approveAction(hh.ctx, id, io)).toEqual({ ok: true });
    expect(io.outText()).not.toContain("summary:");
    expect(io.outText().trimEnd().split("\n").at(-1)).toMatch(/^expires {3}/);
  });
  it("pending prints no summary", async () => {
    const hh = await harness();
    plant(hh, validDraftPlan());
    expect(await pendingText(hh)).not.toContain("summary:");
  });
});

describe("stored rows that break the draft rules", () => {
  const invalid: [string, unknown][] = [
    ["a bad subject", validDraftPlan({}, { subject: `Re: Q4${ESC}]budget` })],
    ["a bad body", withBody(`Hi${ESC}]evil`)],
    ["both body and bodyRemoved", validDraftPlan({}, { bodyRemoved: true })],
  ];
  for (const [name, evil] of invalid) {
    it(`${name}: pending shows (invalid plan), approve refuses INTERNAL`, async () => {
      const hh = await harness();
      const id = plant(hh, validDraftPlan());
      rewrite(hh, id, evil);
      expect(await pendingText(hh)).toContain("    (invalid plan)\n");
      const io = scripted([last4(id)]);
      expect(await approveAction(hh.ctx, id, io)).toMatchObject({ ok: false, errorCode: "INTERNAL" });
      expect(getAction(hh.db, id)!.status).toBe("planned");
      expect(io.outText()).toBe("");
    });
  }
});

describe("body integrity: an edited body is PLAN_MODIFIED in approve and apply (ruling R1)", () => {
  const edited = () => ({ ...validDraftPlan(), draft: { ...validDraftPlan().draft, body: "Send the money to evil@evil.example" } });

  it("the edit keeps plan_hash (the hash leaves the body out)", () => {
    expect(planHash(edited())).toBe(planHash(validDraftPlan()));
  });

  it("planned: pending shows (invalid plan), approve refuses PLAN_MODIFIED, status planned", async () => {
    const hh = await harness();
    const id = plant(hh, validDraftPlan());
    rewrite(hh, id, edited(), { keepHash: true });
    const pending = await pendingText(hh);
    expect(pending).toContain("    (invalid plan)\n");
    expect(pending).not.toContain("evil");
    const io = scripted([last4(id)]);
    expect(await approveAction(hh.ctx, id, io)).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    expect(getAction(hh.db, id)!.status).toBe("planned");
    expect(io.outText()).toBe("");
  });

  it("approved: action_apply gives PLAN_MODIFIED, status failed, no draft written", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const id = seedAction(hh.ctx, "approved", validDraftPlan());
    rewrite(hh, id, edited(), { keepHash: true });
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    expect(getAction(hh.db, id)!.status).toBe("failed");
    expect(drafts(hh)).toHaveLength(0);
  });

  it("an edited body (one character appended, bodyChars and bodySha256 kept) is PLAN_MODIFIED at approve", async () => {
    const hh = await harness();
    const id = plant(hh, validDraftPlan());
    const p = validDraftPlan();
    rewrite(hh, id, { ...p, draft: { ...p.draft, body: `${DRAFT_BODY}!` } }, { keepHash: true });
    expect(await approveAction(hh.ctx, id, scripted([last4(id)]))).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
  });
});

describe("a plan without its body never writes (decision 2)", () => {
  it("unexpired planned with bodyRemoved: approve refuses PLAN_MODIFIED", async () => {
    const hh = await harness();
    const id = plant(hh, validDraftPlan());
    rewrite(hh, id, swept(validDraftPlan()), { keepHash: true });
    const io = scripted([last4(id)]);
    expect(await approveAction(hh.ctx, id, io)).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    expect(getAction(hh.db, id)!.status).toBe("planned");
    expect(io.outText()).toBe("");
  });

  it("expired planned with bodyRemoved: approve refuses PLAN_EXPIRED (expiry first)", async () => {
    const hh = await harness();
    const id = plant(hh, validDraftPlan());
    rewrite(hh, id, swept(validDraftPlan()), { keepHash: true });
    hh.db.run("UPDATE actions SET expires_at = ? WHERE id = ?", ["2026-11-10T09:00:00.000Z", id]);
    expect(await approveAction(hh.ctx, id, scripted([last4(id)]))).toMatchObject({ ok: false, errorCode: "PLAN_EXPIRED" });
  });

  it("unexpired approved with bodyRemoved: action_apply gives PLAN_MODIFIED, failed, no draft", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const id = seedAction(hh.ctx, "approved", validDraftPlan());
    rewrite(hh, id, swept(validDraftPlan()), { keepHash: true });
    expect(await applyAction(hh.ctx, id)).toMatchObject({ ok: false, errorCode: "PLAN_MODIFIED" });
    expect(getAction(hh.db, id)!.status).toBe("failed");
    expect(drafts(hh)).toHaveLength(0);
  });
});

describe("apply with a draft plan (the kind's provider calls)", () => {
  const ID = "act_01JC3Z8K4V7Q2W9X5R6T1N0BHM";
  const header = `<deskhand.${idempotencyKey(ID)}@deskhand.invalid>`;
  const ours = () => validDraftPlan({}, { messageIdHeader: header });
  async function approvedDraft(hh: H): Promise<string> {
    hh.ctx.ids = { newActionId: () => ID };
    return seedAction(hh.ctx, "approved", ours());
  }

  it("replay of an applied plan whose body was swept returns the stored result (carried a)", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const id = await approvedDraft(hh);
    const first = await applyAction(hh.ctx, id);
    expect(first).toMatchObject({ ok: true, replayed: false });
    rewrite(hh, id, swept(ours()), { keepHash: true });
    const again = await applyAction(hh.ctx, id);
    expect(again).toEqual({ ok: true, replayed: true, output: (first as { output: unknown }).output });
    expect(drafts(hh)).toHaveLength(1);
    expect(JSON.stringify(again)).not.toContain("The numbers look right");
    expect(getAction(hh.db, id)!.result_json).not.toContain("The numbers look right");
  });

  it("a draft under our Message-ID that differs fails with the draft phrase (carried c)", async () => {
    const hh = await harness({ DESKHAND_ALLOW_WRITES: "1" });
    const id = await approvedDraft(hh);
    const p = ours().draft;
    await hh.ctx.mail!.createDraft({ ...p, body: DRAFT_BODY, bcc: ["mallory@example.com"] });
    expect(await applyAction(hh.ctx, id)).toEqual({
      ok: false,
      errorCode: "STALE_PLAN",
      message: "a draft with this action's id exists but differs from the approved plan",
    });
    expect(getAction(hh.db, id)!.status).toBe("failed");
    expect(drafts(hh)).toHaveLength(1);
  });
});
