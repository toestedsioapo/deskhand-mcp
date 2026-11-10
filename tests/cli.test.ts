import { describe, expect, it } from "vitest";
import { runCli, runMain } from "../src/cli/index.js";
import type { CliIo } from "../src/cli/io.js";
import { PACKAGE_VERSION } from "../src/config/version.js";
import { runCliBin } from "./helpers/spawn.js";

const noCtx = (): never => {
  throw new Error("ctxFactory must not be called");
};

function makeIo(sink: { out: string; err: string }): CliIo {
  return {
    out: (s) => (sink.out += s),
    err: (s) => (sink.err += s),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    readLine: () => Promise.reject(new Error("no input expected")),
  };
}

async function run(argv: string[]) {
  const sink = { out: "", err: "" };
  const code = await runCli(argv, makeIo(sink), noCtx);
  return { code, ...sink };
}

const SUBCOMMANDS = ["pending", "approve", "reject", "export", "auth"];
const STUBS = ["approve", "export", "auth"];

describe("runCli", () => {
  it.each([[[]], [["--help"]], [["-h"]]])("help for %j", async (argv) => {
    const { code, out } = await run(argv);
    expect(code).toBe(0);
    expect(out).toContain("deskhand");
    for (const name of SUBCOMMANDS) expect(out).toContain(name);
    expect(out).toContain("not implemented yet");
    expect(out).not.toMatch(/pending .*not implemented|reject .*not implemented/);
    expect(out).toContain("--version");
  });

  it("prints the version", async () => {
    const { code, out } = await run(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(PACKAGE_VERSION);
  });

  it("rejects unknown commands", async () => {
    const { code, out, err } = await run(["bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown command");
    expect(out).toBe("");
  });

  it.each(STUBS)("%s is not implemented yet", async (name) => {
    const { code, err } = await run([name]);
    expect(code).toBe(2);
    expect(err).toContain("not implemented");
  });
});

describe("dist/cli.js", () => {
  it("--help prints help with empty stderr", () => {
    const r = runCliBin(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("pending");
    expect(r.stderr).toBe("");
  });

  it("--version prints the package version", () => {
    const r = runCliBin(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(PACKAGE_VERSION);
  });

  it("unknown command exits 2", () => {
    const r = runCliBin(["bogus"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown command");
    expect(r.stdout).toBe("");
  });
});

describe("runMain", () => {
  it("prints 'deskhand: <message>' and exits 1 on unsupported Node, no stack trace", async () => {
    const sink = { out: "", err: "" };
    const code = await runMain("24.14.0", ["--help"], makeIo(sink));
    const err = sink.err;
    expect(code).toBe(1);
    expect(err).toMatch(/^deskhand: .*requires Node >=24\.15/);
    expect(err).not.toContain("    at ");
    expect(err.trimEnd().split("\n")).toHaveLength(1);
  });

  it("delegates to runCli on a supported Node", async () => {
    const sink = { out: "", err: "" };
    const code = await runMain("24.15.0", ["--version"], makeIo(sink), noCtx);
    expect(code).toBe(0);
    expect(sink.out).toBe(`${PACKAGE_VERSION}\n`);
  });
});
