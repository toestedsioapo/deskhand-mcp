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

// OSC (terminated by BEL or ST), CSI, and other two-character escapes.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const ESC_OTHER = /\u001b[@-Z\\-_]?/g;
// C0 except tab and newline, DEL, C1, zero-width and bidi marks (U+200B-U+200F),
// line/paragraph separators (U+2028, U+2029), bidi embeddings/overrides
// (U+202A-U+202E), bidi isolates (U+2066-U+2069) and the BOM (U+FEFF).
// Escapes only: this file must stay pure ASCII (a test enforces it).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Untrusted text made safe for a terminal: no escapes, no control characters except newline and tab. */
export function stripControl(s: string): string {
  return s.replace(OSC, "").replace(CSI, "").replace(ESC_OTHER, "").replace(CONTROL, "");
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
