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
  readLine(prompt: string): Promise<string>;
}

// Characters that are invisible, blank-looking, or that move the cursor or change the text direction:
// Cc (C0, DEL and C1 controls, so ESC and the one-byte CSI/OSC), Cf (bidi marks, embeddings, overrides and
// isolates, zero-width characters, soft hyphen, tag characters, BOM), Zl and Zp (line and paragraph separator),
// Cs and Co (lone surrogates, private use), every default-ignorable code point (Hangul and Khmer fillers,
// variation selectors, combining grapheme joiner) and the braille blank U+2800.
// Escapes only: this file must stay pure ASCII (a test enforces it).
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Default_Ignorable_Code_Point}\u2800]/gu;

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
  return s.length > 0 && oneLine(s, Number.POSITIVE_INFINITY) === s;
}

/** One or more printable ASCII characters, no space: calendar ids and attendee addresses. */
export const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
