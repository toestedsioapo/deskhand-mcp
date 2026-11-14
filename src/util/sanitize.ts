/**
 * Neutral home of the terminal sanitisers and the CLI I/O shape, so layers
 * below the CLI (src/approval) never import from src/cli/ (a structural test
 * enforces it). src/cli/io.ts re-exports everything here.
 */

/** The streams a CLI command talks to. TTY flags come from the real streams (src/cli/io.ts). */
export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** `process.execArgv` and `NODE_OPTIONS` of the running process (the real CLI sets both); omitted means none. */
  execArgv?: readonly string[];
  nodeOptions?: string;
  /** Terminal width in columns when stdout is a TTY; omitted means unknown (rows are laid out for 80). */
  columns?: number;
  readLine(prompt: string): Promise<string>;
}

// Characters that are invisible, blank-looking, or that move the cursor or change the text direction:
// Cc (C0, DEL and C1 controls, so ESC and the one-byte CSI/OSC), Cf (bidi marks, embeddings, overrides and
// isolates, zero-width characters, soft hyphen, tag characters, BOM), Zl and Zp (line and paragraph separator),
// Cs and Co (lone surrogates, private use), every default-ignorable code point (Hangul and Khmer fillers,
// variation selectors, combining grapheme joiner), Cn (unassigned code points and noncharacters, which a terminal
// may draw as nothing) and the characters designed to render blank: braille blank U+2800, ideographic half fill
// space U+303F, Devanagari gap filler U+A8F9, Egyptian full and half blank U+13441 and U+13442, Khitan small script
// filler U+16FE4 and musical null notehead U+1D159.
// Escapes only: this file must stay pure ASCII (a test enforces it).
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u2800\u303f\ua8f9\u{13441}\u{13442}\u{16fe4}\u{1d159}]/gu;

/** More combining marks on one character than any script needs: they stack over the rows above and below. */
const MARK_STACK = /\p{M}{5,}/u;

/**
 * Untrusted text made safe for a terminal: every hidden character (see HIDDEN) is removed except newline and tab.
 * Only those characters are removed, never the visible text after them: an escape sequence is not interpreted, so
 * `ESC [ 3 1 m` comes out as the visible text `[31m`. (Removing whole sequences let an unterminated `ESC ]` hide
 * the rest of a title from the person approving it.)
 */
export function stripControl(s: string): string {
  return s.replace(HIDDEN, (c) => (c === "\n" || c === "\t" ? c : ""));
}

/**
 * Untrusted text for a single-line field: stripControl, whitespace runs
 * (including newline and tab) collapsed to one space, trimmed, and capped at
 * `max` characters (an ellipsis marks a cut).
 */
export function oneLine(s: string, max = 200): string {
  const flat = stripControl(s).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * True when `s` is non-empty and the sanitiser would print it unchanged: no hidden character, and no whitespace
 * other than single ASCII spaces between words. Text that passes is shown to the approver exactly as it is stored
 * and written, which is why titles must pass it.
 */
export function isPlainLine(s: string): boolean {
  return s.length > 0 && !MARK_STACK.test(s) && oneLine(s, Number.POSITIVE_INFINITY) === s;
}

// ---------------------------------------------------------------- terminal rows

/** Marks a row that continues the line above; no real diff or header line starts with it. */
export const CONTINUATION = "    | ";
/** Width used when the terminal's is unknown (piped output, tests). */
export const DEFAULT_COLUMNS = 80;
/** Narrowest layout: below this the prefix and marker would not fit. */
export const MIN_COLUMNS = 20;

/**
 * Columns `s` may take, never fewer than a terminal uses: printable ASCII is 1, every other code point 2 (wide
 * CJK, emoji, and ambiguous-width characters on terminals that draw them wide). Over-counting only breaks a row
 * early; under-counting would let the terminal wrap a row itself, without the continuation marker.
 */
export function termWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    w += c >= 0x20 && c <= 0x7e ? 1 : 2;
  }
  return w;
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * `text` laid out as terminal rows of at most `columns` (see termWidth): the first row starts with `prefix`, every
 * further row with CONTINUATION. The CLI wraps long values itself so that text the terminal would have wrapped can
 * never start a row and pass for a diff line. A row breaks after its last double space, else its last space, else
 * between two characters (graphemes), never inside one.
 */
export function layoutRow(prefix: string, text: string, columns: number = DEFAULT_COLUMNS): string[] {
  const width = Math.max(Number.isNaN(columns) ? DEFAULT_COLUMNS : Math.floor(columns), MIN_COLUMNS);
  const rows: string[] = [];
  let head = prefix;
  let row: string[] = []; // graphemes on the current row
  let used = termWidth(prefix);
  for (const { segment } of graphemes.segment(text)) {
    const w = termWidth(segment);
    if (row.length > 0 && used + w > width) {
      // Prefer to break after the last space on the row (the space stays at the end of the row, so the rows
      // still join back to the exact text); otherwise break between characters.
      // A double space (the pending header's column gap) wins, so a label is not split from its value.
      const gap = row.findLastIndex((g, k) => g === " " && row[k - 1] === " ");
      const space = gap >= 0 ? gap : row.lastIndexOf(" ");
      const carry = space >= 0 && space < row.length - 1 ? row.splice(space + 1) : [];
      rows.push(head + row.join(""));
      head = CONTINUATION;
      row = carry;
      used = CONTINUATION.length + termWidth(carry.join(""));
      if (row.length > 0 && used + w > width) {
        rows.push(head + row.join(""));
        row = [];
        used = CONTINUATION.length;
      }
    }
    row.push(segment);
    used += w;
  }
  rows.push(head + row.join(""));
  return rows;
}

/**
 * Writes untrusted text as terminal rows: sanitised (stripControl), split at its own newlines, tabs shown as one
 * space (a tab's width depends on the column), and each line laid out by layoutRow for `io.columns`.
 */
export function writeRows(io: Pick<CliIo, "out" | "columns">, prefix: string, text: string): void {
  for (const line of stripControl(text).replace(/\t/g, " ").split("\n")) {
    for (const row of layoutRow(prefix, line, io.columns ?? DEFAULT_COLUMNS)) io.out(`${row}\n`);
  }
}

/** One or more printable ASCII characters, no space: calendar ids and attendee addresses. */
export const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
