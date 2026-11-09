import { describe, expect, it } from "vitest";
import { runCli, runMain } from "../src/cli/index.js";
import { PACKAGE_VERSION } from "../src/config/version.js";
import { runCliBin } from "./helpers/spawn.js";

function run(argv: string[]) {
  let out = "";
  let err = "";
  const code = runCli(argv, {
    out: (s) => (out += s),
    err: (s) => (err += s),
  });
  return { code, out, err };
}

const SUBCOMMANDS = ["pending", "approve", "reject", "export", "auth"];

describe("runCli", () => {
  it.each([[[]], [["--help"]], [["-h"]]])("help for %j", (argv) => {
    const { code, out } = run(argv);
    expect(code).toBe(0);
    expect(out).toContain("deskhand");
    for (const name of SUBCOMMANDS) expect(out).toContain(name);
    expect(out).toContain("not implemented yet");
    expect(out).toContain("--version");
  });

  it("prints the version", () => {
    const { code, out } = run(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(PACKAGE_VERSION);
  });

  it("rejects unknown commands", () => {
    const { code, out, err } = run(["bogus"]);
    expect(code).toBe(2);
    expect(err).toContain("unknown command");
    expect(out).toBe("");
  });

  it.each(SUBCOMMANDS)("%s is not implemented yet", (name) => {
    const { code, err } = run([name]);
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
  it("prints 'deskhand: <message>' and exits 1 on unsupported Node, no stack trace", () => {
    let err = "";
    const code = runMain("24.14.0", ["--help"], {
      out: () => {},
      err: (s) => (err += s),
    });
    expect(code).toBe(1);
    expect(err).toMatch(/^deskhand: .*requires Node >=24\.15/);
    expect(err).not.toContain("    at ");
    expect(err.trimEnd().split("\n")).toHaveLength(1);
  });

  it("delegates to runCli on a supported Node", () => {
    let out = "";
    const code = runMain("24.15.0", ["--version"], {
      out: (s) => (out += s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out).toBe(`${PACKAGE_VERSION}\n`);
  });
});
