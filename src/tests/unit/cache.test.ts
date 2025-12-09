import { describe, expect, it } from "vitest";
import { createCache } from "../../cache";

describe("cache helper", () => {
  it("stores and expires entries based on ttl", () => {
    let now = 0;
    const cache = createCache(2, 1000, { now: () => now });

    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);

    now = 1500;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("evicts oldest entry when capacity is exceeded", () => {
    const cache = createCache(2, 1000, { now: () => 0 });

    cache.set("a", "first");
    cache.set("b", "second");
    cache.set("c", "third");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("second");
    expect(cache.get("c")).toBe("third");
  });

  it("supports prefix invalidation and disabled configuration", () => {
    const cache = createCache(2, 1000, { now: () => 0 });
    cache.set("x:1", 1);
    cache.set("x:2", 2);
    expect(cache.deleteByPrefix?.("x:")).toBe(2);

    const disabled = createCache(0, 1000);
    disabled.set("a", 1);
    expect(disabled.get("a")).toBeUndefined();
    expect(disabled.stats().size).toBe(0);
  });
});
