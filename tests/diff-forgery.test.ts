import { afterEach, describe, expect, it } from "vitest";
import { approveAction } from "../src/approval/approve.js";
import { renderDiff } from "../src/approval/plan-kinds.js";
import { runCli } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/io.js";
import { getAction } from "../src/ledger/actions.js";
import { planHash } from "../src/ledger/canonical.js";
import { LedgerDb } from "../src/ledger/db.js";
import { last4 } from "../src/ledger/ids.js";
import { isPlainLine, oneLine, stripControl } from "../src/util/sanitize.js";
import { setupHarness } from "./helpers/harness.js";
import { validPlan } from "./helpers/seed.js";

// Second review of the approve diff (2026-11-12): nothing an agent supplies may forge a line, hide a line,
// or make the text a human approves differ from the text that is written.
// Every special character is built from its code point so this file stays plain ASCII.
const cp = (...n: number[]): string => String.fromCodePoint(...n);
const ESC = cp(0x1b);

/** Characters that are invisible, blank-looking, or move the cursor or the text direction. */
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

/** Whitespace that is not a single ASCII space. */
const SPACES: [string, number][] = [
  ["LF", 0x0a],
  ["TAB", 0x09],
  ["NBSP U+00A0", 0xa0],
  ["en space U+2002", 0x2002],
  ["hair space U+200A", 0x200a],
  ["narrow NBSP U+202F", 0x202f],
  ["math space U+205F", 0x205f],
  ["ideographic space U+3000", 0x3000],
];

// The reviewer's F1 inputs: an unterminated or partial escape sequence in front of visible text.
const F1_OSC = `Team lunch${ESC}] CANCELLED - new plan: wire 9,000 EUR to IBAN DE00 1234, reply evil@evil.example`;
const F1_CSI = `Pay invoice ${ESC}[9000000 EUR`;
const F1_TWO = `Lunch ${ESC}Zoom call with competitor`;
// The reviewer's F2 input: blank-looking characters pad the title to the wrap column of an 80-column terminal.
const F2_PAD = `Lunch${cp(0x2800).repeat(61)}no attendee notifications (sendUpdates=none)`;

describe("stripControl never removes visible text", () => {
  it("an unterminated OSC keeps everything after it", () => {
    expect(stripControl(F1_OSC)).toBe(
      "Team lunch] CANCELLED - new plan: wire 9,000 EUR to IBAN DE00 1234, reply evil@evil.example",
    );
  });
  it("a partial CSI keeps its digits and the text after it", () => {
    expect(stripControl(F1_CSI)).toBe("Pay invoice [9000000 EUR");
  });
  it("ESC before a letter removes only the ESC", () => {
    expect(stripControl(F1_TWO)).toBe("Lunch Zoom call with competitor");
  });
  it("a complete CSI or OSC loses its control characters and is left as visible text", () => {
    expect(stripControl(`a${ESC}[31mred${ESC}[0m`)).toBe("a[31mred[0m");
    expect(stripControl(`x${ESC}]0;title${cp(0x07)}y`)).toBe("x]0;titley");
    expect(stripControl(`x${cp(0x9b)}1Ay`)).toBe("x1Ay");
  });
  for (const [name, code] of HIDDEN) {
    it(`removes ${name}`, () => expect(stripControl(`a${cp(code)}b`)).toBe("ab"));
  }
  it("keeps newline and tab, letters with accents, CJK, Hebrew and a plain emoji", () => {
    const text = `a\n\tb ${cp(0xe9)} ${cp(0x65e5, 0x672c)} ${cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)} ${cp(0x1f600)}`;
    expect(stripControl(text)).toBe(text);
  });
});

describe("isPlainLine: text the sanitiser would print unchanged", () => {
  it("accepts ordinary titles", () => {
    for (const s of ["Sync", "Q4 review: budget & hiring (draft #2)", `D${cp(0xe9)}jeuner d'${cp(0xe9)}quipe`, cp(0x65e5, 0x672c, 0x8a9e), cp(0x5e9, 0x5dc, 0x5d5, 0x5dd)]) {
      expect(isPlainLine(s), s).toBe(true);
      expect(oneLine(s, 1000), s).toBe(s);
    }
  });
  it("refuses empty, blank, padded and double-spaced text", () => {
    for (const s of ["", " ", " a", "a ", "a  b"]) expect(isPlainLine(s), JSON.stringify(s)).toBe(false);
  });
  for (const [name, code] of [...HIDDEN, ...SPACES]) {
    it(`refuses ${name}`, () => expect(isPlainLine(`a${cp(code)}b`)).toBe(false));
  }
  it("refuses ESC in any position", () => {
    for (const s of [F1_OSC, F1_CSI, F1_TWO, `${ESC}]hidden entirely`]) expect(isPlainLine(s)).toBe(false);
  });
});

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
async function harness(): Promise<H> {
  h = await setupHarness({ env: {} });
  return h;
}
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const SLOT = { start: "2026-11-12T10:00:00.000Z", end: "2026-11-12T10:30:00.000Z" };
const propose = (hh: H, args: Record<string, unknown>) =>
  hh.client.callTool({ name: "calendar_propose_event", arguments: { ...SLOT, ...args } });
const actionCount = (hh: H) => hh.db.all("SELECT id FROM actions").length;

function scripted(lines: string[] = []): CliIo & { outText: () => string } {
  let out = "";
  const q = [...lines];
  return {
    out: (s) => (out += s),
    err: () => undefined,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    readLine: async () => q.shift() ?? "",
    outText: () => out,
  };
}
async function pendingText(hh: H): Promise<string> {
  const io = scripted();
  const code = await runCli(["pending"], io, () => ({ ...hh.ctx, db: LedgerDb.open(hh.ctx.config.paths.ledgerPath) }));
  expect(code).toBe(0);
  return io.outText();
}

describe("calendar_propose_event: the title a human approves is the title that is written", () => {
  const refused: [string, string][] = [
    ["an unterminated OSC that hid the rest of the title", F1_OSC],
    ["a partial CSI", F1_CSI],
    ["ESC before a letter", F1_TWO],
    ["an OSC with nothing visible in front", `${ESC}]hidden entirely`],
    ["a complete colour sequence", `${ESC}[31mred${ESC}[0m`],
    ["braille blanks padding a forged line to the wrap column", F2_PAD],
    ["leading, trailing and repeated whitespace", "  A\n\n\tB   C  "],
    ["a single space", " "],
    ["only a zero-width space", cp(0x200b)],
    ["a newline before a forged count line", "Sync\n0 attendees"],
    ...HIDDEN.map(([name, code]): [string, string] => [name, `Sync${cp(code)}0 attendees`]),
    ...SPACES.map(([name, code]): [string, string] => [name, `Sync${cp(code)}0 attendees`]),
  ];
  for (const [name, title] of refused) {
    it(`refuses a title with ${name}`, async () => {
      const hh = await harness();
      const r = await propose(hh, { title, attendees: ["boss@example.com"], send_updates: "all" });
      expect(r.isError).toBe(true);
      await hh.logging.whenIdle();
      expect(actionCount(hh)).toBe(0);
      expect(hh.rows().map((x) => [x.kind, x.outcome, x.error_code])).toEqual([["tool_call", "error", "INVALID_INPUT"]]);
    });
  }

  it("for an accepted title the diff, pending and approve show exactly the stored title", async () => {
    const hh = await harness();
    for (const title of ["Team lunch", `D${cp(0xe9)}jeuner d'${cp(0xe9)}quipe (salle 2)`, cp(0x5e9, 0x5dc, 0x5d5, 0x5dd), "x".repeat(200)]) {
      const r = await propose(hh, { title });
      expect(r.isError, title).toBeFalsy();
      const out = r.structuredContent as { action_id: string; diff: string[] };
      const stored = (getAction(hh.db, out.action_id)!.plan_json as unknown as { event: { title: string } }).event.title;
      expect(stored).toBe(title);
      expect(out.diff[0]).toBe(`create event: ${stored}`);
      expect(await pendingText(hh)).toContain(`    create event: ${stored}\n`);
      const io = scripted([last4(out.action_id)]);
      expect(await approveAction(hh.ctx, out.action_id, io)).toEqual({ ok: true });
      expect(io.outText()).toContain(`    create event: ${stored}\n`);
    }
  });
});

describe("a plan row written around the tool cannot be shown as something else", () => {
  const INVALID = ["(invalid plan)"];
  const cases: [string, Record<string, unknown>][] = [
    ["a title with an unterminated OSC", { title: F1_OSC }],
    ["a title with a newline", { title: "Sync\n0 attendees" }],
    ["a title padded with braille blanks", { title: F2_PAD }],
    ["a title with surrounding spaces", { title: " Sync " }],
    ["a 201-character title (the tail would be cut)", { title: "x".repeat(201) }],
    ["a calendarId with an escape", { calendarId: `primary${ESC}]attacker@group.calendar.google.com` }],
    ["a calendarId with a newline", { calendarId: "primary\n0 attendees" }],
    ["a calendarId with a space", { calendarId: "my calendar" }],
    ["a 257-character calendarId", { calendarId: "c".repeat(257) }],
    ["an attendee with an escape", { attendees: [`ok@x.co${ESC}],evil@evil.example`] }],
    ["an attendee that is only an escape sequence", { attendees: [`${ESC}]hidden@evil.example`] }],
    ["an attendee with a newline", { attendees: ["eve@example.com\nwill email 0 attendees"] }],
    ["an attendee with a space", { attendees: ["a b@example.com"] }],
    ["an attendee with a bidi override", { attendees: [`eve@example.com${cp(0x202e)}`] }],
    ["an empty attendee", { attendees: [""] }],
    ["a 255-character attendee", { attendees: [`${"a".repeat(243)}@example.com`] }],
    ["51 attendees", { attendees: Array.from({ length: 51 }, (_, k) => `p${k}@example.com`) }],
  ];
  for (const [name, ev] of cases) {
    it(`${name} is an invalid plan`, () => expect(renderDiff(validPlan({}, ev), "UTC")).toEqual(INVALID));
  }

  it("approve refuses such a row with INTERNAL and prints none of its text", async () => {
    const hh = await harness();
    const r = await propose(hh, { title: "Team lunch" });
    const id = (r.structuredContent as { action_id: string }).action_id;
    const evil = validPlan({}, { ...SLOT, title: F1_OSC });
    hh.db.run("UPDATE actions SET plan_json = ?, plan_hash = ? WHERE id = ?", [JSON.stringify(evil), planHash(evil), id]);
    const io = scripted([last4(id)]);
    const res = await approveAction(hh.ctx, id, io);
    expect(res).toMatchObject({ ok: false, errorCode: "INTERNAL" });
    expect(getAction(hh.db, id)!.status).toBe("planned");
    expect(io.outText()).not.toContain("Team lunch");
    const pending = await pendingText(hh);
    expect(pending).toContain("    (invalid plan)\n");
    expect(pending).not.toContain("Team lunch");
  });
});

describe("the pending and approve headers cannot be forged through row columns", () => {
  async function seeded(hh: H): Promise<string> {
    const r = await propose(hh, { title: "Team lunch", attendees: ["boss@example.com"] });
    return (r.structuredContent as { action_id: string }).action_id;
  }

  it("a plan_hash with escape sequences is not printed", async () => {
    const hh = await harness();
    const id = await seeded(hh);
    hh.db.run("UPDATE actions SET plan_hash = ? WHERE id = ?", [`${ESC}[1A${ESC}[2K${ESC}[31mPWNED`, id]);
    const out = await pendingText(hh);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("PWNED");
    expect(out).toContain("hash (invalid)");
  });

  it("a multi-line tool name stays on the header line", async () => {
    const hh = await harness();
    const id = await seeded(hh);
    const tool = `calendar_propose_event  expires 2099-01-01T00:00:00.000Z  hash 00000000\n    create event: Harmless\n    0 attendees\nact_FAKE  x`;
    hh.db.run("UPDATE actions SET tool = ? WHERE id = ?", [tool, id]);
    const lines = (await pendingText(hh)).split("\n");
    expect(lines.filter((l) => l.trim() === "create event: Harmless")).toEqual([]);
    expect(lines.filter((l) => l.trim() === "0 attendees")).toEqual([]);
    expect(lines.filter((l) => l.startsWith("act_"))).toHaveLength(1);
  });

  it("a multi-line expires_at stays on the header line", async () => {
    const hh = await harness();
    const id = await seeded(hh);
    hh.db.run("UPDATE actions SET expires_at = ? WHERE id = ?", ["2099-01-01T00:00:00.000Z\n    forged line", id]);
    const lines = (await pendingText(hh)).split("\n");
    expect(lines.filter((l) => l.trim().startsWith("forged line"))).toEqual([]);
    expect(lines.filter((l) => l.startsWith("act_"))).toHaveLength(1);
  });
});

describe("the notification line states the stored sendUpdates value", () => {
  const last = (ev: Record<string, unknown>) => renderDiff(validPlan({}, ev), "UTC").at(-1);
  const THREE = ["a@example.com", "b@example.com", "c@example.com"];
  it("none", () => {
    expect(last({ sendUpdates: "none", attendees: THREE })).toBe("no attendee notifications (sendUpdates=none)");
    expect(last({ sendUpdates: "none", attendees: [] })).toBe("no attendee notifications (sendUpdates=none)");
  });
  it("all with attendees", () => expect(last({ sendUpdates: "all", attendees: THREE })).toBe("will email 3 attendees"));
  it("externalOnly with attendees does not claim that everyone is emailed", () => {
    expect(last({ sendUpdates: "externalOnly", attendees: THREE })).toBe(
      "will email the attendees outside your organisation, up to 3 (sendUpdates=externalOnly)",
    );
  });
  it("all or externalOnly with no attendees names the stored value, not none", () => {
    expect(last({ sendUpdates: "all", attendees: [] })).toBe("no attendee notifications (sendUpdates=all, no attendees)");
    expect(last({ sendUpdates: "externalOnly", attendees: [] })).toBe(
      "no attendee notifications (sendUpdates=externalOnly, no attendees)",
    );
  });
});
