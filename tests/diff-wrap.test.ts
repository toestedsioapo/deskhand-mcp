import { afterEach, describe, expect, it } from "vitest";
import { applyAction } from "../src/approval/apply.js";
import { approveAction } from "../src/approval/approve.js";
import { renderDiff } from "../src/approval/plan-kinds.js";
import { runCli } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/io.js";
import { getAction } from "../src/ledger/actions.js";
import { canonicalJson, planHash } from "../src/ledger/canonical.js";
import { LedgerDb } from "../src/ledger/db.js";
import { last4 } from "../src/ledger/ids.js";
import { CONTINUATION, isPlainLine, layoutRow, termWidth } from "../src/util/sanitize.js";
import { setupHarness } from "./helpers/harness.js";
import { validPlan } from "./helpers/seed.js";

// Third review of the approve diff (2026-11-14): text that the terminal wraps must never start a row that looks
// like a diff field, and no accepted character may render blank. Plain ASCII file: characters come from code points.
const cp = (...n: number[]): string => String.fromCodePoint(...n);

/** A row that, at the start of a terminal row, would read as a real diff line or header. */
const FIELD_ROW =
  /^\s*(create event:|when:|event zone:|utc:|calendar:|\d+ attendees$|no attendee notifications|will email|plan hash|expires)/;
const FORGED = "no attendee notifications (sendUpdates=none)";

describe("isPlainLine refuses characters that can render blank (third review I1)", () => {
  const blank: [string, number][] = [
    ["unassigned U+0378", 0x0378],
    ["noncharacter U+FFFE", 0xfffe],
    ["noncharacter U+FFFF", 0xffff],
    ["unassigned plane-3 U+3FFFD", 0x3fffd],
    ["EGYPTIAN HIEROGLYPH FULL BLANK U+13441", 0x13441],
    ["EGYPTIAN HIEROGLYPH HALF BLANK U+13442", 0x13442],
    ["MUSICAL SYMBOL NULL NOTEHEAD U+1D159", 0x1d159],
    ["KHITAN SMALL SCRIPT FILLER U+16FE4", 0x16fe4],
    ["DEVANAGARI GAP FILLER U+A8F9", 0xa8f9],
    ["IDEOGRAPHIC HALF FILL SPACE U+303F", 0x303f],
  ];
  for (const [name, code] of blank) {
    it(`refuses ${name}`, () => expect(isPlainLine(`a${cp(code)}b`)).toBe(false));
  }
});

describe("isPlainLine caps stacked combining marks (third review M2)", () => {
  it("refuses five or more marks on one character", () => {
    expect(isPlainLine(`a${cp(0x301).repeat(5)}`)).toBe(false);
    expect(isPlainLine(`a${cp(0x336).repeat(199)}`)).toBe(false);
  });
  it("accepts up to four, which covers NFD Vietnamese and pointed Hebrew", () => {
    expect(isPlainLine(`a${cp(0x301).repeat(4)}`)).toBe(true);
    expect(isPlainLine(`Cafe${cp(0x301)}`)).toBe(true);
    expect(isPlainLine(`Vie${cp(0x323, 0x302)}t Nam`)).toBe(true); // e + dot below + circumflex
    expect(isPlainLine(cp(0x5e9, 0x5c1, 0x5b8, 0x5dc, 0x5d5, 0x5b9, 0x5dd))).toBe(true);
  });
});

describe("termWidth never underestimates", () => {
  it("printable ASCII is one column each", () => expect(termWidth("Team lunch")).toBe(10));
  it("anything else counts two columns per code point", () => {
    expect(termWidth(cp(0x4f1a, 0x8bae))).toBe(4);
    expect(termWidth(`Caf${cp(0xe9)}`)).toBe(5);
    expect(termWidth(cp(0x1f600))).toBe(2);
  });
});

describe("layoutRow: the CLI wraps long values itself", () => {
  it("a short value is one row with the first prefix", () => {
    expect(layoutRow("    ", "create event: Team lunch", 80)).toEqual(["    create event: Team lunch"]);
  });
  it(`continuation rows start with the marker ${JSON.stringify(CONTINUATION)} and no row exceeds the width`, () => {
    const title = `create event: ${"Quarterly planning sync with leadership partners and the whole"}${FORGED}`;
    for (const w of [40, 80, 100, 120]) {
      const rows = layoutRow("    ", title, w);
      expect(rows.length, `width ${w}`).toBeGreaterThan(1);
      expect(rows[0]!.startsWith("    create event: ")).toBe(true);
      for (const r of rows.slice(1)) expect(r.startsWith(CONTINUATION), r).toBe(true);
      for (const r of rows) expect(termWidth(r), `${w}: ${r}`).toBeLessThanOrEqual(w);
      expect(rows.map((r, k) => (k === 0 ? r.slice(4) : r.slice(CONTINUATION.length))).join("")).toBe(title);
    }
  });
  it("never splits a surrogate pair or a character from its combining marks", () => {
    const text = `${"x".repeat(73)}${cp(0x1f600)}${"y".repeat(10)}e${cp(0x301, 0x323)}${"z".repeat(70)}`;
    for (const w of [76, 77, 78, 79, 80, 81]) {
      const rows = layoutRow("    ", text, w);
      for (const r of rows) {
        expect(/\p{Cs}/u.test(r), r).toBe(false);
        expect(/^\s*\|?\s*\p{M}/u.test(r.replace(CONTINUATION, "")), r).toBe(false);
      }
    }
  });
  it("a width below the floor is raised to it, so the prefix always fits", () => {
    for (const r of layoutRow("    ", "x".repeat(100), 3)) expect(termWidth(r)).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------- end to end

type H = Awaited<ReturnType<typeof setupHarness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const SLOT = { start: "2026-11-12T10:00:00.000Z", end: "2026-11-12T10:30:00.000Z" };
const propose = (hh: H, args: Record<string, unknown>) =>
  hh.client.callTool({ name: "calendar_propose_event", arguments: { ...SLOT, ...args } });

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

/** The reviewer's inputs: visible text that lands a forged line at the start of a row at 80, 100 or 120 columns. */
const WRAP_TITLES: [number, string, string][] = [
  [80, `${"Quarterly planning sync with leadership partners and the whole"}${FORGED}`, FORGED],
  [100, `${"y".repeat(82)}calendar: primary`, "calendar: primary"],
  [120, `${"z".repeat(102)}0 attendees`, "0 attendees"],
  [80, `${cp(0x4f1a, 0x8bae).repeat(15)}${cp(0x4f1a)}${FORGED}`, FORGED],
];

describe("pending and approve: a wrapped title can never start a row that looks like a field", () => {
  for (const [width, title, forged] of WRAP_TITLES) {
    it(`width ${width}: ${JSON.stringify(forged)}`, async () => {
      h = await setupHarness({ env: {} });
      const r = await propose(h, {
        title,
        calendar_id: "attacker-shared@group.calendar.google.com",
        attendees: ["ana@example.com"],
        send_updates: "all",
      });
      expect(r.isError).toBeFalsy();
      const id = (r.structuredContent as { action_id: string }).action_id;
      const expectedFields = renderDiff(JSON.parse(JSON.stringify(getAction(h.db, id)!.plan_json)), h.ctx.config.timeZone)
        .slice(1)
        .filter((l) => FIELD_ROW.test(l)).length;

      const pending = await pendingText(h, width);
      const io = scripted([last4(id)], width);
      expect(await approveAction(h.ctx, id, io)).toEqual({ ok: true });
      for (const out of [pending, io.outText()]) {
        const rows = out.split("\n").filter((l) => l.length > 0);
        for (const row of rows) expect(termWidth(row), row).toBeLessThanOrEqual(width);
        // The forged text is on a marked continuation row, never at a row start.
        expect(rows.some((row) => row.startsWith(CONTINUATION) && row.includes(forged.slice(0, 5)))).toBe(true);
        // Only the real field lines (plus the title line, and approve's own two footer lines) look like fields.
        const fieldRows = rows.filter((row) => FIELD_ROW.test(row));
        const footer = out === io.outText() ? 2 : 0;
        expect(fieldRows.length, fieldRows.join("\n")).toBe(1 + expectedFields + footer);
      }
    });
  }

  it("without a known width the CLI wraps at 80", async () => {
    h = await setupHarness({ env: {} });
    await propose(h, { title: WRAP_TITLES[0]![1], send_updates: "all", attendees: ["ana@example.com"] });
    const rows = (await pendingText(h)).split("\n");
    for (const row of rows) expect(termWidth(row)).toBeLessThanOrEqual(80);
    expect(rows.filter((r) => r.trim().startsWith(FORGED))).toEqual([]);
  });

  it("short lines are unchanged (the owner-checked diff layout)", async () => {
    h = await setupHarness({ env: {} });
    await propose(h, { title: "Team lunch", attendees: ["ana@example.com"], send_updates: "all" });
    const out = await pendingText(h, 80);
    expect(out).toContain("\n    create event: Team lunch\n");
    expect(out).toContain("\n      ana@example.com\n    will email 1 attendees\n");
    // The only continuation row is the pending header's own (id, tool, expiry and hash exceed 80 columns).
    const continued = out.split("\n").filter((r) => r.startsWith(CONTINUATION));
    expect(continued).toEqual([expect.stringMatching(/^ {4}\| (expires |hash )/)]);
  });
});

describe("a stored plan_json must be the canonical form of itself (third review M3)", () => {
  // Duplicate keys: JSON.parse keeps the last, SQLite json_extract (Deskflow, Deskbench) the first.
  async function duplicateKeyRow(hh: H, status: "planned" | "approved"): Promise<string> {
    const r = await propose(hh, { title: "Benign lunch" });
    const id = (r.structuredContent as { action_id: string }).action_id;
    const canon = getAction(hh.db, id)!.plan_json as unknown as Record<string, unknown>;
    const json = canonicalJson(canon).replace('"title":"Benign lunch"', '"title":"Benign lunch","title":"Board offsite"');
    const hash = planHash(JSON.parse(json));
    hh.db.run("UPDATE actions SET plan_json = ?, plan_hash = ? WHERE id = ?", [json, hash, id]);
    if (status === "approved") {
      hh.db.run(
        "UPDATE actions SET status = 'approved', approved_by = 't', approved_at = ?, approval_method = 'cli_tty', approved_plan_hash = ? WHERE id = ?",
        ["2026-11-10T09:30:00.123Z", hash, id],
      );
    }
    return id;
  }

  it("pending shows it as an invalid plan", async () => {
    h = await setupHarness({ env: {} });
    await duplicateKeyRow(h, "planned");
    const out = await pendingText(h);
    expect(out).toContain("    (invalid plan)\n");
    expect(out).not.toContain("Board offsite");
  });
  it("approve refuses it with INTERNAL before the prompt", async () => {
    h = await setupHarness({ env: {} });
    const id = await duplicateKeyRow(h, "planned");
    const io = scripted([last4(id)]);
    expect(await approveAction(h.ctx, id, io)).toMatchObject({ ok: false, errorCode: "INTERNAL" });
    expect(io.outText()).not.toContain("Board offsite");
  });
  it("apply refuses it and writes nothing", async () => {
    h = await setupHarness({ env: { DESKHAND_ALLOW_WRITES: "1" } });
    const id = await duplicateKeyRow(h, "approved");
    const before = (await h.provider.listEvents("primary", { start: SLOT.start, end: SLOT.end }, 100)).events.length;
    expect(await applyAction(h.ctx, id)).toMatchObject({ ok: false });
    expect(getAction(h.db, id)!.status).not.toBe("applied");
    expect((await h.provider.listEvents("primary", { start: SLOT.start, end: SLOT.end }, 100)).events.length).toBe(before);
  });
});

describe("the stored-plan schema is as strict as the tool input (third review M6)", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["an attendee that is not an email", { attendees: ["calendar:primary"] }],
    ["an attendee that reads like a count", { attendees: ["0attendees"] }],
    ["a start with nine fractional digits", { start: "2026-11-12T10:00:00.123456789Z" }],
    ["a start with an offset (tool input is stored as UTC)", { start: "2026-11-12T11:00:00.000+01:00" }],
    ["a start without milliseconds", { start: "2026-11-12T10:00:00Z" }],
    ["a 65-character time zone", { timeZone: `Europe/${"B".repeat(58)}` }],
  ];
  for (const [name, ev] of cases) {
    it(`${name} is an invalid plan`, () => expect(renderDiff(validPlan({}, ev), "UTC")).toEqual(["(invalid plan)"]));
  }
  it("the plan the tool stores still passes", () => expect(renderDiff(validPlan(), "UTC")[0]).toBe("create event: Sync"));
});
