import { describe, expect, it, vi } from "vitest";
import { createRouterHelpers, RouterConfigError } from "../../router-helpers";
import { createRateLimiter } from "../../rate-limit";
import { createCache } from "../../cache";
import { createSafeLogger, NonceManager, noopLogger } from "../../service";

const baseConfig = {
  variables: {
    discourseBaseUrl: "https://example.com",
    discourseApiUsername: "system",
    clientId: "client",
    requestTimeoutMs: 1_000,
    requestsPerSecond: 5,
    rateLimitStrategy: "global" as const,
    rateLimitBucketTtlMs: 1_000,
    rateLimitMaxBuckets: 10,
    cacheMaxSize: 10,
    cacheTtlMs: 1_000,
    nonceTtlMs: 1_000,
    nonceCleanupIntervalMs: 1_000,
    userApiScopes: { joined: "read", scopes: ["read"] },
    logBodySnippetLength: 200,
  },
  secrets: { discourseApiKey: "key" },
};

type HelperContext = Parameters<typeof createRouterHelpers>[0];
const makeContext = (overrides: Partial<HelperContext> = {}): HelperContext => ({
  logger: createSafeLogger(noopLogger),
  bodySnippetLength: 200,
  nonceManager: new NonceManager({ ttlMs: 1_000 }),
  config: baseConfig as any,
  metrics: { retryAttempts: 0, nonceEvictions: 0 },
  rateLimiter: createRateLimiter({ requestsPerSecond: 2 }),
  cache: createCache(5, 1_000),
  ...overrides,
});

describe("router helpers", () => {
  it("throws RouterConfigError when rate limit error constructor is missing", () => {
    const helpers = createRouterHelpers(
      makeContext({
        rateLimiter: { take: () => ({ allowed: false, retryAfterMs: 50 }) } as any,
      })
    );
    expect(() => helpers.enforceRateLimit("action", {} as any)).toThrow(RouterConfigError);
  });

  it("passes rate limit key derived from username to limiter", async () => {
    const take = vi.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 });
    const helpers = createRouterHelpers({
      ...makeContext(),
      rateLimiter: { take } as any,
    });

    const handler = helpers.makeHandler(
      "do-thing",
      async ({ input }: any) => ({ value: input.value })
    );

    await handler({ input: { value: 42, username: "alice" }, errors: {} as any });

    expect(take).toHaveBeenCalledWith("do-thing", "alice");
  });

  it("prefers explicit rate limit key overrides when provided", async () => {
    const take = vi.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 });
    const helpers = createRouterHelpers({
      ...makeContext(),
      rateLimiter: { take } as any,
    });

    const handler = helpers.wrapRoute({
      action: "custom-key-action",
      handler: async () => ({ value: 1 }),
      rateLimitKey: () => "explicit-key",
    });

    await handler({ input: { username: "alice" }, errors: {} as any });

    expect(take).toHaveBeenCalledWith("custom-key-action", "explicit-key");
  });

  it("caches results via withCache", async () => {
    const helpers = createRouterHelpers(makeContext());
    const fetch = vi.fn().mockResolvedValue(99);

    const first = await helpers.withCache({ action: "fetch", key: "k", fetch });
    const second = await helpers.withCache({ action: "fetch", key: "k", fetch });

    expect(first).toBe(99);
    expect(second).toBe(99);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
