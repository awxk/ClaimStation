import { describe, expect, it } from "vitest";
import { shouldAttemptCandidate, type Cache } from "./cache.js";
import type { CacheEntry, Candidate } from "../types.js";

const candidate: Candidate = {
  source: "manual",
  productId: "UP0000-CUSA00000_00-TEST00000000000",
  name: "Test Product",
  storeUrl: "https://store.playstation.com/en-us/product/UP0000-CUSA00000_00-TEST00000000000",
};

function cacheWith(status: CacheEntry["status"]): Cache {
  return new Map([
    [
      candidate.productId,
      {
        productId: candidate.productId,
        name: candidate.name,
        storeUrl: candidate.storeUrl,
        status,
        attempts: 1,
        firstSeenAt: "2026-09-01T00:00:00.000Z",
        lastAttemptAt: "2026-09-01T00:00:00.000Z",
      },
    ],
  ]);
}

describe("cache attempt policy", () => {
  it("does not reattempt cached trials by default or with force", () => {
    expect(shouldAttemptCandidate(candidate, cacheWith("trial"))).toBe(false);
    expect(shouldAttemptCandidate(candidate, cacheWith("trial"), { force: true })).toBe(false);
  });

  it("reattempts cached trials only with the trial retry flag", () => {
    expect(shouldAttemptCandidate(candidate, cacheWith("trial"), { retryTrials: true })).toBe(true);
  });

  it("never reattempts cached not-free products", () => {
    expect(shouldAttemptCandidate(candidate, cacheWith("not-free"), { force: true, retryTrials: true })).toBe(false);
  });

  it("reattempts selected cached statuses", () => {
    expect(shouldAttemptCandidate(candidate, cacheWith("error"), { revisitStatuses: ["error"] })).toBe(true);
  });
});
