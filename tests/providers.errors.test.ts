import { describe, expect, it } from "vitest";
import { AuthRequiredError, ProviderError } from "../src/providers/errors.js";

describe("provider errors", () => {
  it("AuthRequiredError names the command to run", () => {
    expect(new AuthRequiredError().message).toContain("deskhand auth login");
  });
  it("AuthRequiredError takes a fixed sentence from the adapter", () => {
    const m = "Google write access is not granted. Run: deskhand auth upgrade";
    expect(new AuthRequiredError(m).message).toBe(m);
  });
  it("ProviderError drops a reason that is not letters only", () => {
    const e = new ProviderError("google calendar", "events.insert", { status: 403, reason: "rate<script>" });
    expect(e.message).toBe("google calendar events.insert failed: HTTP 403");
  });
  it("ProviderError is retryable for HTTP 429 and 5xx, not for other statuses", () => {
    for (const s of [429, 500, 502, 503, 504]) expect(new ProviderError("g", "op", { status: s }).retryable, String(s)).toBe(true);
    for (const s of [400, 403, 404, 409, 410, 412]) expect(new ProviderError("g", "op", { status: s }).retryable, String(s)).toBe(false);
  });
  it("a phrase ProviderError is definite unless marked retryable", () => {
    expect(new ProviderError("g", "op", { phrase: "invalid event id" }).retryable).toBe(false);
    expect(new ProviderError("g", "op", { phrase: "timed out", retryable: true }).retryable).toBe(true);
  });
  it("ProviderError keeps a plain reason or a fixed phrase", () => {
    expect(new ProviderError("g", "op", { status: 403, reason: "rateLimit" }).message).toBe("g op failed: HTTP 403 rateLimit");
    expect(new ProviderError("g", "op", { phrase: "network error" }).message).toBe("g op failed: network error");
  });
});
