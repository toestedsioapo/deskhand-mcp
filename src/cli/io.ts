export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  readLine(prompt: string): Promise<string>;
}

export function realCliIo(): CliIo {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    async readLine(prompt) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  };
}

// OSC (terminated by BEL or ST), CSI, and other two-character escapes.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const ESC_OTHER = /\u001b[@-Z\\-_]?/g;
// C0 except tab and newline, DEL, C1, and bidi/invisible override characters.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

/** Untrusted text made safe for a terminal: no escapes, no control characters except newline and tab. */
export function stripControl(s: string): string {
  return s.replace(OSC, "").replace(CSI, "").replace(ESC_OTHER, "").replace(CONTROL, "");
}
