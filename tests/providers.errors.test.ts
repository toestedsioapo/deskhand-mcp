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
  it("ProviderError keeps a plain reason or a fixed phrase", () => {
    expect(new ProviderError("g", "op", { status: 403, reason: "rateLimit" }).message).toBe("g op failed: HTTP 403 rateLimit");
    expect(new ProviderError("g", "op", { phrase: "network error" }).message).toBe("g op failed: network error");
  });
});
