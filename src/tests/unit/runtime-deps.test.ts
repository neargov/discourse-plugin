import { describe, expect, it } from "vitest";
import { createDiscourseDeps } from "../../runtime/deps";

const baseConfig = {
  variables: {
    discourseBaseUrl: "https://example.com",
    discourseApiUsername: "system",
    clientId: "client",
    requestTimeoutMs: 1_000,
    requestsPerSecond: 5,
    rateLimitStrategy: "global" as const,
    rateLimitMaxBuckets: 10,
    rateLimitBucketTtlMs: 1_000,
    cacheMaxSize: 0,
    cacheTtlMs: 0,
    nonceTtlMs: 1_000,
    nonceCleanupIntervalMs: 1_000,
    userApiScopes: ["read"],
    logBodySnippetLength: 50,
  },
  secrets: { discourseApiKey: "key" },
};

describe("runtime deps", () => {
  it("defaults write retries to zero when write overrides are absent", () => {
    const config = { ...baseConfig };
    const { discourseService } = createDiscourseDeps(config as any, {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any, { retryAttempts: 0, nonceEvictions: 0 });

    expect((discourseService as any).retryPolicies.writes.maxRetries).toBe(0);
  });

  it("preserves provided write retry overrides when specified", () => {
    const config = {
      ...baseConfig,
      operationRetryPolicy: { writes: { maxRetries: 3 } },
    };
    const { discourseService } = createDiscourseDeps(config as any, {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any, { retryAttempts: 0, nonceEvictions: 0 });

    expect((discourseService as any).retryPolicies.writes.maxRetries).toBe(3);
  });
});
