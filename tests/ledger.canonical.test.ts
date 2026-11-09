import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashPrefix, planHash } from "../src/ledger/canonical.js";

describe("canonicalJson", () => {
  it("sorts keys recursively (fixed vector)", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
  });
  it("drops undefined properties", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("keeps unicode as-is", () => {
    expect(canonicalJson({ k: "héllo 日本 😀" })).toBe('{"k":"héllo 日本 😀"}');
  });
  it("throws on Date", () => {
    expect(() => canonicalJson({ d: new Date() })).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
  });
  it("throws on non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });
  it("throws a clear error on over-deep input instead of overflowing the stack", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/too deep/);
  });
  it("handles scalars and null", () => {
    expect(canonicalJson([1, "a", null, true])).toBe('[1,"a",null,true]');
  });
});

describe("planHash", () => {
  const plan = { sendUpdates: "none", ev: { title: "x", attendees: ["a", "b"] } };
  it("is lowercase hex sha256 of canonicalJson", () => {
    const h = planHash(plan);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex"));
  });
  it("ignores key order", () => {
    expect(planHash({ ev: { attendees: ["a", "b"], title: "x" }, sendUpdates: "none" })).toBe(
      planHash(plan),
    );
  });
  it("changes with a nested value", () => {
    expect(planHash({ ...plan, ev: { title: "y", attendees: ["a", "b"] } })).not.toBe(planHash(plan));
  });
  it("changes when sendUpdates none -> all", () => {
    expect(planHash({ ...plan, sendUpdates: "all" })).not.toBe(planHash(plan));
  });
  it("hashPrefix is the first 8 hex", () => {
    expect(hashPrefix(planHash(plan))).toBe(planHash(plan).slice(0, 8));
  });
});
