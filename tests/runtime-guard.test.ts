import { describe, expect, it } from "vitest";
import { untrustedRuntimeFlag } from "../src/approval/runtime-guard.js";

describe("untrustedRuntimeFlag", () => {
  it("is null for a clean runtime", () => {
    expect(untrustedRuntimeFlag([], "")).toBeNull();
    expect(untrustedRuntimeFlag(["--max-old-space-size=512", "--no-warnings"], "--max-old-space-size=512")).toBeNull();
    expect(untrustedRuntimeFlag([], undefined)).toBeNull();
  });

  it.each([
    ["--import"],
    ["--import=./x.mjs"],
    ["--require"],
    ["--require=./x.cjs"],
    ["-r"],
    ["--loader"],
    ["--loader=./l.mjs"],
    ["--experimental-loader"],
    ["--experimental-loader=./l.mjs"],
    ["--experimental_loader"],
    ["--inspect"],
    ["--inspect=0"],
    ["--inspect-brk"],
    ["--inspect-brk=127.0.0.1:9229"],
    ["--inspect-wait"],
  ])("flags %s in execArgv", (flag) => {
    expect(untrustedRuntimeFlag(["--no-warnings", flag, "./x.mjs"], "")).not.toBeNull();
  });

  it("flags the same options in NODE_OPTIONS, split on whitespace", () => {
    expect(untrustedRuntimeFlag([], "--import file:///x.mjs")).not.toBeNull();
    expect(untrustedRuntimeFlag([], "--max-old-space-size=512   --require ./x.cjs")).not.toBeNull();
    expect(untrustedRuntimeFlag([], "-r ./x.cjs")).not.toBeNull();
    expect(untrustedRuntimeFlag([], "--inspect-brk")).not.toBeNull();
    expect(untrustedRuntimeFlag([], "\t--experimental-loader=./l.mjs\n")).not.toBeNull();
  });

  it("returns the offending flag name", () => {
    expect(untrustedRuntimeFlag(["--import=./x.mjs"], "")).toBe("--import");
    expect(untrustedRuntimeFlag([], "-r ./x.cjs")).toBe("-r");
    expect(untrustedRuntimeFlag(["--inspect-brk=9229"], "")).toBe("--inspect-brk");
  });

  it("does not flag look-alike flags", () => {
    expect(untrustedRuntimeFlag(["--importmap"], "")).toBeNull();
    expect(untrustedRuntimeFlag(["--require-module"], "")).toBeNull();
    expect(untrustedRuntimeFlag(["--stack-trace-limit=10", "-rx"], "")).toBeNull();
    expect(untrustedRuntimeFlag([], "--title=import")).toBeNull();
  });
});
