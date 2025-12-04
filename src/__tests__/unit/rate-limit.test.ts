import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../../rate-limit";

describe("rate limiter", () => {
  it("denies when bucket is empty and reports retryAfterMs", () => {
    const limiter = createRateLimiter({ requestsPerSecond: 1 });

    expect(limiter.take("action")).toEqual({ allowed: true, retryAfterMs: 0 });
    const second = limiter.take("action");

    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it("isolates buckets by client when configured", () => {
    const limiter = createRateLimiter({ requestsPerSecond: 1, strategy: "perClient" });

    expect(limiter.take("action", "a").allowed).toBe(true);
    expect(limiter.take("action", "b").allowed).toBe(true);
    expect(limiter.take("action", "a").allowed).toBe(false);
  });

  it("isolates buckets by action and client for perActionClient strategy", () => {
    const limiter = createRateLimiter({ requestsPerSecond: 1, strategy: "perActionClient" });

    expect(limiter.take("read", "client-1").allowed).toBe(true);
    expect(limiter.take("write", "client-1").allowed).toBe(true);
    expect(limiter.take("read", "client-1").allowed).toBe(false);
  });

  it("evicts oldest buckets when maxBuckets is reached", () => {
    const limiter = createRateLimiter({
      requestsPerSecond: 1,
      strategy: "perClient",
      maxBuckets: 2,
    });

    limiter.take("action", "first");
    limiter.take("action", "second");
    limiter.take("action", "third");

    const reused = limiter.take("action", "first");
    expect(reused.allowed).toBe(true);
  });

  it("evicts the stalest bucket instead of the most recently used", () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;

    const limiter = createRateLimiter({
      requestsPerSecond: 1,
      strategy: "perClient",
      maxBuckets: 2,
    });

    limiter.take("action", "first"); // first bucket at t0
    now = 10;
    limiter.take("action", "second"); // second bucket at t10
    now = 20;
    limiter.take("action", "first"); // refresh first bucket recency at t20
    now = 30;
    limiter.take("action", "third"); // should evict "second" as stalest
    now = 40;
    const reused = limiter.take("action", "second");

    expect(reused.allowed).toBe(true);

    Date.now = originalNow;
  });

  it("falls back to default TTL when bucketTtlMs is invalid", () => {
    const originalNow = Date.now;
    let now = 0;
    Date.now = () => now;

    const limiter = createRateLimiter({ requestsPerSecond: 1, bucketTtlMs: -1 });

    const first = limiter.take("action");
    expect(first.allowed).toBe(true);

    now = 600_000; // advance beyond default TTL to trigger purge
    const second = limiter.take("action");
    expect(second.allowed).toBe(true);

    Date.now = originalNow;
  });

  it("treats non-positive maxBuckets as unlimited", () => {
    const limiter = createRateLimiter({ requestsPerSecond: 1, maxBuckets: 0 });

    limiter.take("action", "first");
    limiter.take("action", "second");
    limiter.take("action", "third");

    expect(limiter.take("action", "first").allowed).toBe(false);
  });
});
