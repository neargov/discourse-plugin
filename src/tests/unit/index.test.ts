import { describe, expect, it, vi, beforeEach } from "vitest";
import { Effect } from "every-plugin/effect";
import DiscoursePlugin, {
  createWithErrorLogging,
  sanitizeErrorForLog,
  resolveBodySnippet,
  resolveCause,
  mapDiscourseApiError,
  normalizeUserApiScopes,
  createRouter,
  mapValidateUserApiKeyResult,
  VariablesSchema,
  RouterConfigError,
  __internalCreateRouterHelpers,
  __internalCreateCache,
  __internalCreateRateLimiter,
} from "../../index";
import { DEFAULT_BODY_SNIPPET_LENGTH } from "../../constants";
import {
  ListTopicListInputSchema,
  TopicNotificationLevelSchema,
} from "../../contract";
import {
  createSafeLogger,
  DiscourseApiError,
  NonceManager,
  noopLogger,
} from "../../service";
import { effectHelpers } from "../../utils";
import { uploadPayload } from "../fixtures";

const buildMockContext = () => ({
  discourseService: {},
  cryptoService: {},
  nonceManager: new NonceManager({ ttlMs: 1000 }),
  config: {
    variables: {
      discourseBaseUrl: "https://example.com",
      discourseApiUsername: "system",
      clientId: "client",
      requestTimeoutMs: 1000,
      requestsPerSecond: 5,
      rateLimitStrategy: "global",
      rateLimitBucketTtlMs: 1000,
      rateLimitMaxBuckets: 10,
      cacheMaxSize: 10,
      cacheTtlMs: 1000,
      nonceTtlMs: 1000,
      nonceCleanupIntervalMs: 1000,
      userApiScopes: normalizeUserApiScopes(["read"]),
      logBodySnippetLength: DEFAULT_BODY_SNIPPET_LENGTH,
    },
    secrets: { discourseApiKey: "key" },
  },
  logger: createSafeLogger(noopLogger),
  normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
  cleanupFiber: null,
  bodySnippetLength: DEFAULT_BODY_SNIPPET_LENGTH,
  metrics: { retryAttempts: 0, nonceEvictions: 0 },
});

describe("sanitizeErrorForLog", () => {
  it("returns a message payload when serialization yields a string", () => {
    const sanitized = sanitizeErrorForLog("plain failure");

    expect(sanitized).toEqual({ message: "plain failure", name: undefined });
  });

  it("captures the error name when available", () => {
    const error = new Error("boom");
    error.name = "CustomError";

    const sanitized = sanitizeErrorForLog(error);

    expect(sanitized).toEqual({ message: "boom", name: "CustomError" });
  });

  it("surfaces a cause message when present", () => {
    const error = new Error("outer");
    (error as any).cause = new Error("inner");

    const sanitized = sanitizeErrorForLog(error);

    expect(sanitized).toEqual(
      expect.objectContaining({ message: "outer", cause: "inner" })
    );
  });

  it("stringifies cause values when they are not Error instances", () => {
    const error = new Error("outer");
    (error as any).cause = "inner-string";

    expect(sanitizeErrorForLog(error)).toEqual(
      expect.objectContaining({ message: "outer", cause: "inner-string" })
    );
  });

  it("retains Discourse API metadata for richer logs", () => {
    const error = new DiscourseApiError({
      status: 429,
      path: "/rate-limit",
      method: "GET",
      retryAfterMs: 1500,
      requestId: "req-123",
      bodySnippet: "too many requests",
    });

    const sanitized = sanitizeErrorForLog(error);

    expect(sanitized).toEqual(
      expect.objectContaining({
        message: error.message,
        name: "DiscourseApiError",
        status: 429,
        path: "/rate-limit",
        method: "GET",
        retryAfterMs: 1500,
        requestId: "req-123",
        bodySnippet: "too many requests",
      })
    );
  });

  it("omits body snippet when it is not provided", () => {
    const error = new DiscourseApiError({
      status: 500,
      path: "/missing-snippet",
      method: "GET",
    });

    expect(sanitizeErrorForLog(error)).toEqual(
      expect.objectContaining({
        message: error.message,
        bodySnippet: undefined,
      })
    );
  });

  it("respects a custom body snippet length override", () => {
    const error = new DiscourseApiError({
      status: 500,
      path: "/long-snippet",
      method: "GET",
      bodySnippet: "averylongsnippet",
    });

    expect(sanitizeErrorForLog(error, 5)).toEqual(
      expect.objectContaining({ bodySnippet: "avery" })
    );
  });

  it("delegates to helpers for generic and Discourse errors", () => {
    const generic = new Error("generic boom");
    (generic as any).cause = new Error("root cause");
    const discourse = new DiscourseApiError({
      status: 429,
      path: "/limited",
      method: "GET",
      retryAfterMs: 1000,
      bodySnippet: "limited payload",
    });

    const cause = (generic as any).cause;
    expect(resolveCause(cause)).toBe("root cause");
    expect(resolveBodySnippet(generic, 5)).toBeUndefined();
    expect(resolveBodySnippet(discourse, 6)).toBe("limite");
    expect(sanitizeErrorForLog(discourse, 6)).toEqual(
      expect.objectContaining({
        bodySnippet: "limite",
        status: 429,
      })
    );
  });
});

describe("VariablesSchema", () => {
  const base = {
    discourseBaseUrl: "https://discuss.example.com",
    requestTimeoutMs: 1500,
    nonceTtlMs: 1000,
    nonceCleanupIntervalMs: 1000,
  };

  it("rejects blank scopes during validation", () => {
    const result = VariablesSchema.safeParse({
      ...base,
      userApiScopes: ["read", " "],
    });

    expect(result.success).toBe(false);
  });

  it("trims scopes provided as a comma-delimited string", () => {
    const result = VariablesSchema.parse({
      ...base,
      userApiScopes: " read , write ",
    });

    expect(result.userApiScopes).toEqual({
      joined: "read,write",
      scopes: ["read", "write"],
    });
  });

  it("allows zero nonce limits to explicitly disable caps", () => {
    const result = VariablesSchema.parse({
      ...base,
      nonceMaxPerClient: 0,
      nonceMaxTotal: 0,
    });

    expect(result.nonceMaxPerClient).toBe(0);
    expect(result.nonceMaxTotal).toBe(0);
  });

  it("rejects non-string scope inputs", () => {
    const result = VariablesSchema.safeParse({
      ...base,
      userApiScopes: 123 as any,
    });

    expect(result.success).toBe(false);
  });
});

describe("contract schema validation", () => {
  it("maps topic notification level string aliases to numeric levels", () => {
    const parsed = TopicNotificationLevelSchema.parse("tracking");

    expect(parsed).toBe(2);
  });

  it("returns numeric levels unchanged for notification schema", () => {
    const parsed = TopicNotificationLevelSchema.parse(3);

    expect(parsed).toBe(3);
  });

  it("rejects unknown notification aliases", () => {
    const result = TopicNotificationLevelSchema.safeParse("unknown" as any);

    expect(result.success).toBe(false);
  });

  it("rejects top topic lists with blank period", () => {
    const result = ListTopicListInputSchema.safeParse({
      type: "top",
      period: "" as any,
    });

    expect(result.success).toBe(false);
  });

  it("applies default period when top topics period is missing", () => {
    const parsed = ListTopicListInputSchema.parse({ type: "top" });

    expect(parsed.period).toBe("monthly");
  });
});

describe("withErrorLogging", () => {
  const makeConfig = () =>
    ({
      variables: {
        discourseBaseUrl: "https://example.com",
        discourseApiUsername: "system",
        clientId: "client",
        requestTimeoutMs: 1000,
        requestsPerSecond: 5,
        rateLimitStrategy: "global",
        rateLimitBucketTtlMs: 1000,
        rateLimitMaxBuckets: 10,
        cacheMaxSize: 10,
        cacheTtlMs: 1000,
        nonceTtlMs: 2000,
        nonceCleanupIntervalMs: 1000,
        userApiScopes: normalizeUserApiScopes(["read", "write"]),
        logBodySnippetLength: 500,
      },
      secrets: { discourseApiKey: "secret" },
    } as const);

  const makeLogger = () => {
    const logSpy =
      vi.fn<
        (payload: {
          level: string;
          message: string;
          meta?: Record<string, unknown>;
        }) => void
      >();
    const log = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      meta?: Record<string, unknown>
    ) => logSpy({ level, message, meta });
    return { log, logSpy };
  };

  it("does not retry Discourse errors without an explicit retry policy", async () => {
    const { log, logSpy } = makeLogger();
    const nonceManager = new NonceManager();
    const error = new DiscourseApiError({
      status: 503,
      path: "/retry",
      method: "GET",
      retryAfterMs: 2500,
    });
    const fn = vi.fn().mockImplementationOnce(() => {
      throw error;
    });

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
    });

    await expect(withErrorLogging("retry-action", () => fn(), {})).rejects.toBe(
      error
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "retry-action failed",
        meta: expect.objectContaining({
          action: "retry-action",
          attempt: 1,
        }),
      })
    );
  });

  it("logs and maps errors when retry is not available", async () => {
    const { log, logSpy } = makeLogger();
    const nonceManager = new NonceManager();
    const boom = new Error("boom");

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
    });

    await expect(
      withErrorLogging(
        "failing-action",
        () => {
          throw boom;
        },
        {}
      )
    ).rejects.toBe(boom);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "failing-action failed",
        meta: expect.objectContaining({
          action: "failing-action",
          error: expect.objectContaining({ message: "boom" }),
        }),
      })
    );
  });

  it("unwraps nested candidates returned from run failures", async () => {
    const { logSpy, log } = makeLogger();
    const nonceManager = new NonceManager();
    const inner = new Error("inner");

    const withErrorLogging = createWithErrorLogging({
      log,
      run: () => Promise.reject({ defect: inner }),
      nonceManager,
      config: makeConfig(),
    });

    await expect(
      withErrorLogging("unwrap-action", async () => "ok", {})
    ).rejects.toBe(inner);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("rethrows the original error when no unwrap candidates exist", async () => {
    const { logSpy, log } = makeLogger();
    const nonceManager = new NonceManager();
    const outer = new Error("outer");

    const withErrorLogging = createWithErrorLogging({
      log,
      run: () => Promise.reject(outer),
      nonceManager,
      config: makeConfig(),
    });

    await expect(
      withErrorLogging("no-candidate", async () => "ok", {})
    ).rejects.toBe(outer);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not retry when transport-level failures occur", async () => {
    const { logSpy, log } = makeLogger();
    const nonceManager = new NonceManager();
    const fn = vi.fn().mockImplementationOnce(() => {
      throw new Error("network blip");
    });

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
    });

    await expect(
      withErrorLogging("transport-retry", () => fn(), {})
    ).rejects.toThrow("network blip");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        meta: expect.objectContaining({
          action: "transport-retry",
          attempt: 1,
        }),
      })
    );
  });

  it("logs failure metadata when the handler rejects asynchronously", async () => {
    const { logSpy, log } = makeLogger();
    const nonceManager = new NonceManager();
    const boom = new Error("async-fail");

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
    });

    await expect(
      withErrorLogging(
        "async-action",
        async () => {
          return Promise.reject(boom);
        },
        {}
      )
    ).rejects.toBe(boom);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "async-action failed",
        meta: expect.objectContaining({
          action: "async-action",
          attempt: 1,
          error: expect.objectContaining({ message: "async-fail" }),
        }),
      })
    );
  });

  it("increments retry metrics on subsequent attempts", async () => {
    const { logSpy, log } = makeLogger();
    const nonceManager = new NonceManager();
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    let call = 0;

    const withErrorLogging = createWithErrorLogging({
      log,
      // Simulate a single retry by re-running the effect once when it fails.
      run: (eff) => Effect.runPromise(eff.pipe(Effect.catchAll(() => eff))),
      nonceManager,
      config: makeConfig(),
      metrics,
    });

    const result = await withErrorLogging(
      "retryable-action",
      () => {
        call += 1;
        if (call === 1) {
          return Promise.reject(new Error("first-fail"));
        }
        return Promise.resolve("ok");
      },
      {}
    );

    expect(result).toBe("ok");
    expect(metrics.retryAttempts).toBe(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "retryable-action failed",
        meta: expect.objectContaining({ attempt: 1 }),
      })
    );
  });
});

describe("rate limiting and caching helpers", () => {
  it("throttles and reports retry-after when the bucket is empty", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const limiter = __internalCreateRateLimiter(Number.NaN as any);

    expect(limiter.take("test")).toEqual({ allowed: true, retryAfterMs: 0 });

    now.mockReturnValue(1);
    const limited = limiter.take("test");
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterMs).toBeGreaterThanOrEqual(999);

    now.mockReturnValue(1001);

    expect(limiter.take("test").allowed).toBe(true);
    now.mockRestore();
  });

  it("uses a safe default rate when requestsPerSecond is invalid", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const limiter = __internalCreateRateLimiter({
      requestsPerSecond: -5,
      strategy: "perAction",
    });

    expect(limiter.take("action").allowed).toBe(true);
    now.mockReturnValue(100);
    const limited = limiter.take("action");
    expect(limited.allowed).toBe(false);
    expect(limited.retryAfterMs).toBeGreaterThanOrEqual(900);
    now.mockRestore();
  });

  it("falls back to a global bucket when strategy is unknown", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const limiter = __internalCreateRateLimiter({
      requestsPerSecond: 1,
      strategy: "invalid" as any,
    });

    expect(limiter.take("one").allowed).toBe(true);
    now.mockReturnValue(500);
    expect(limiter.take("two").allowed).toBe(false);
    now.mockRestore();
  });

  it("evicts idle buckets after the configured TTL", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(0);
    const limiter = __internalCreateRateLimiter({
      requestsPerSecond: 1,
      strategy: "perAction",
      bucketTtlMs: 100,
    });

    expect(limiter.take("a").allowed).toBe(true); // consume token
    expect(limiter.take("a").allowed).toBe(false); // limited at t=0

    now.mockReturnValue(200); // beyond TTL, should drop old bucket
    expect(limiter.take("a").allowed).toBe(true); // new bucket allowed
    now.mockRestore();
  });

  it("evicts oldest buckets when exceeding maxBuckets", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const limiter = __internalCreateRateLimiter({
      requestsPerSecond: 1,
      strategy: "perAction",
      maxBuckets: 2,
    });

    expect(limiter.take("a").allowed).toBe(true); // bucket a created
    expect(limiter.take("a").allowed).toBe(false); // now empty
    expect(limiter.take("b").allowed).toBe(true); // bucket b created, size 2
    expect(limiter.take("c").allowed).toBe(true); // should evict oldest (a)

    expect(limiter.take("a").allowed).toBe(true); // a gets a fresh bucket despite no time passing
    now.mockRestore();
  });

  it("isolates buckets per action and client when configured", () => {
    const limiter = __internalCreateRateLimiter({
      requestsPerSecond: 1,
      strategy: "perActionClient",
    });

    expect(limiter.take("action", "client").allowed).toBe(true);
    expect(limiter.take("action", "client").allowed).toBe(false);
    expect(limiter.take("action", "other").allowed).toBe(true);
    expect(limiter.take("other", "client").allowed).toBe(true);
  });

  it("evicts expired and oldest cache entries while tracking stats", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const cache = __internalCreateCache(1, 50);

    cache.set("a", "one");
    now.mockReturnValue(25);
    expect(cache.get("a")).toBe("one");

    cache.set("b", "two");
    expect(cache.get("a")).toBeUndefined();

    now.mockReturnValue(80);
    expect(cache.get("b")).toBeUndefined();

    expect(cache.stats()).toEqual({
      size: 0,
      hits: 1,
      misses: 2,
      evictions: 2,
      ttlMs: 50,
    });
    now.mockRestore();
  });

  it("evicts entries that expire between purge and access", () => {
    let call = 0;
    const cache = __internalCreateCache(1, 50, {
      now: () => {
        call += 1;
        if (call <= 2) return 0; // set() purge + timestamp
        if (call === 3) return 40; // purgeExpired()
        return 60; // expiration check and beyond
      },
    });
    cache.set("a", "one");

    const value = cache.get("a");

    expect(call).toBeGreaterThanOrEqual(3);
    expect(value).toBeUndefined();
    expect(cache.stats()).toEqual({
      size: 0,
      hits: 0,
      misses: 1,
      evictions: 1,
      ttlMs: 50,
    });
  });

  it("no-ops when cache capacity is zero", () => {
    const cache = __internalCreateCache(0, 1000);

    cache.set("a", "one");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats()).toEqual({
      size: 0,
      hits: 0,
      misses: 1,
      evictions: 0,
      ttlMs: 1000,
    });
  });

  it("no-ops when cache TTL is non-positive", () => {
    const cache = __internalCreateCache(5, -10);

    cache.set("a", "one");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats()).toEqual({
      size: 0,
      hits: 0,
      misses: 1,
      evictions: 0,
      ttlMs: 0,
    });
  });

  it("logs cache hits and fills via router helpers", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const context = {
      ...buildMockContext(),
      logger,
      rateLimiter: { take: () => ({ allowed: true, retryAfterMs: 0 }) },
      cache: __internalCreateCache(2, 1000),
    };
    const helpers = __internalCreateRouterHelpers(context as any);
    const fetch = vi.fn().mockResolvedValue("cached-value");

    const first = await helpers.withCache({
      action: "cached",
      key: "cache-key",
      fetch,
    });
    const second = await helpers.withCache({
      action: "cached",
      key: "cache-key",
      fetch,
    });

    expect(first).toBe("cached-value");
    expect(second).toBe("cached-value");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith("Cache filled", {
      action: "cached",
      cacheKey: "cache-key",
    });
    expect(logger.debug).toHaveBeenCalledWith("Cache hit", {
      action: "cached",
      cacheKey: "cache-key",
    });
    expect(helpers.cacheStats()).toEqual(
      expect.objectContaining({
        hits: 1,
        misses: 1,
        size: 1,
        evictions: 0,
        ttlMs: 1000,
      })
    );
  });

  it("refreshes existing cache entries without increasing size", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const cache = __internalCreateCache(2, 100, { logger });

    cache.set("a", "one");
    cache.set("a", "two");

    expect(cache.get("a")).toBe("two");
    expect(cache.stats()).toEqual({
      size: 1,
      hits: 1,
      misses: 0,
      evictions: 0,
      ttlMs: 100,
    });
    expect(logger.debug).not.toHaveBeenCalledWith(
      "Cache eviction",
      expect.objectContaining({ key: "a" })
    );
  });

  it("tracks manual cache deletes as evictions", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const cache = __internalCreateCache(2, 1000, { logger });

    cache.set("a", "one");
    cache.delete("a");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats()).toEqual({
      size: 0,
      hits: 0,
      misses: 1,
      evictions: 1,
      ttlMs: 1000,
    });
    expect(logger.debug).toHaveBeenCalledWith("Cache eviction", {
      action: "cache-evict",
      reason: "manual",
      key: "a",
    });
  });

  it("drops expired entries before enforcing capacity and tracks stats", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(0);
    const cache = __internalCreateCache(1, 50);

    cache.set("a", "one");
    now.mockReturnValue(60); // expired
    cache.set("b", "two"); // should purge expired "a" before size check

    expect(cache.get("b")).toBe("two");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.stats()).toEqual({
      size: 1,
      hits: 1,
      misses: 1,
      evictions: 1,
      ttlMs: 50,
    });

    now.mockRestore();
  });

  it("isolates rate limits per action when configured", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(0);
    const limiter = __internalCreateRateLimiter({
      requestsPerSecond: 1,
      strategy: "perAction",
    });

    expect(limiter.take("one").allowed).toBe(true);
    expect(limiter.take("one").allowed).toBe(false);
    expect(limiter.take("two").allowed).toBe(true);
    now.mockRestore();
  });

  it("tracks retryAfter per client bucket", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(0);
    const limiter = __internalCreateRateLimiter({
      requestsPerSecond: 1,
      strategy: "perClient",
    });

    expect(limiter.take("action", "client-a")).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    now.mockReturnValue(500);
    expect(limiter.take("action", "client-a")).toEqual({
      allowed: false,
      retryAfterMs: 500,
    });
    expect(limiter.take("action", "client-b")).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    now.mockRestore();
  });

  it("uses default bucket keys when action is blank", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const limiter = __internalCreateRateLimiter({
      requestsPerSecond: 1,
      strategy: "perAction",
    });

    expect(limiter.take("").allowed).toBe(true);
    expect(limiter.take("").allowed).toBe(false); // shares the default bucket
    now.mockRestore();
  });

  it("maps rate limit overflow to TOO_MANY_REQUESTS and logs metadata", () => {
    const warn = vi.fn();
    const context = {
      ...buildMockContext(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
      rateLimiter: { take: () => ({ allowed: false, retryAfterMs: 250 }) },
      cache: __internalCreateCache(1, 1000),
    };
    const helpers = __internalCreateRouterHelpers(context as any);
    const errors = {
      TOO_MANY_REQUESTS: vi.fn(
        ({ message, data }) => new Error(`${message}:${data.retryAfterMs}`)
      ),
    };

    expect(() =>
      helpers.enforceRateLimit("limited-action", errors as any)
    ).toThrow("Rate limit exceeded:250");
    expect(errors.TOO_MANY_REQUESTS).toHaveBeenCalledWith({
      message: "Rate limit exceeded",
      data: {
        retryAfter: 1,
        retryAfterMs: 250,
        remainingRequests: 0,
        limitType: "requests",
      },
    });
    expect(warn).toHaveBeenCalledWith("Rate limit exceeded", {
      action: "limited-action",
      rateLimitKey: undefined,
      retryAfterMs: 250,
    });
  });

  it("throws a RouterConfigError when rate-limit constructors are missing", () => {
    const context = {
      ...buildMockContext(),
      rateLimiter: { take: () => ({ allowed: false, retryAfterMs: 0 }) },
      cache: __internalCreateCache(1, 1000),
    };
    const helpers = __internalCreateRouterHelpers(context as any);

    expect(() => helpers.enforceRateLimit("limited-action", {} as any)).toThrow(
      new RouterConfigError(
        "TOO_MANY_REQUESTS constructor missing for rate limiting"
      )
    );
  });

  it("passes username as rate limit key when available", async () => {
    const take = vi.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 });
    const context = {
      ...buildMockContext(),
      rateLimiter: { take },
      cache: __internalCreateCache(1, 1000),
    };
    const helpers = __internalCreateRouterHelpers(context as any);
    const handler = helpers.makeHandler<{ username: string }, { ok: string }>(
      "user-action",
      async ({ input }) => ({ ok: input.username }),
      () => ({})
    );

    const result = await handler({
      input: { username: "alice" },
      errors: {},
    } as any);

    expect(result).toEqual({ ok: "alice" });
    expect(take).toHaveBeenCalledWith("user-action", "alice");
  });

  it("falls back to clientId for rate limit key when username is missing", async () => {
    const take = vi.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 });
    const context = {
      ...buildMockContext(),
      rateLimiter: { take },
      cache: __internalCreateCache(1, 1000),
    };
    const helpers = __internalCreateRouterHelpers(context as any);
    const handler = helpers.makeHandler<{ clientId: string }, { ok: string }>(
      "client-action",
      async ({ input }) => ({ ok: input.clientId }),
      () => ({})
    );

    const result = await handler({
      input: { clientId: "client-123" },
      errors: {},
    } as any);

    expect(result).toEqual({ ok: "client-123" });
    expect(take).toHaveBeenCalledWith("client-action", "client-123");
  });

  it("falls back to hashed userApiKey for rate limit keys without logging secrets", async () => {
    const warn = vi.fn();
    const take = vi.fn().mockReturnValue({ allowed: false, retryAfterMs: 75 });
    const context = {
      ...buildMockContext(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
      rateLimiter: { take },
      cache: __internalCreateCache(1, 1000),
    };
    const helpers = __internalCreateRouterHelpers(context as any);
    const errors = {
      TOO_MANY_REQUESTS: vi.fn(() => new Error("limited")),
    };

    const handler = helpers.makeHandler(
      "user-api-action",
      async () => ({ ok: true }),
      () => ({})
    );

    await expect(
      handler({
        input: { userApiKey: "super-secret-key" },
        errors,
      } as any)
    ).rejects.toThrow("limited");

    const calledWith = take.mock.calls[0]?.[1] as string | undefined;
    expect(calledWith).toMatch(/^userApiKey:/);
    expect(calledWith).not.toContain("super-secret-key");
    expect(warn).toHaveBeenCalledWith("Rate limit exceeded", {
      action: "user-api-action",
      rateLimitKey: calledWith,
      retryAfterMs: 75,
    });
    expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("userApiKey");
  });
});

describe("mapDiscourseApiError", () => {
  it("includes retry-after metadata in mapped errors", () => {
    const error = new DiscourseApiError({
      status: 429,
      path: "/limited",
      method: "GET",
      retryAfterMs: 1500,
      requestId: "req-789",
      bodySnippet: "too many",
    });

    const errors = {
      TOO_MANY_REQUESTS: vi.fn(({ message, data }) => ({ message, data })),
    };

    const mapped = mapDiscourseApiError(error, errors);

    expect(errors.TOO_MANY_REQUESTS).toHaveBeenCalledWith(
      expect.objectContaining({
        message: error.message,
        data: expect.objectContaining({
          retryAfterMs: 1500,
          status: 429,
          path: "/limited",
          method: "GET",
          requestId: "req-789",
        }),
      })
    );

    expect(mapped).toEqual(
      expect.objectContaining({
        message: error.message,
        data: expect.objectContaining({
          retryAfterMs: 1500,
          status: 429,
          path: "/limited",
          method: "GET",
          requestId: "req-789",
        }),
      })
    );
  });

  it("maps gateway and timeout responses as transient", () => {
    const error = new DiscourseApiError({
      status: 504,
      path: "/gateway",
      method: "GET",
    });

    const errors = {
      TOO_MANY_REQUESTS: vi.fn(() => "retryable"),
      SERVICE_UNAVAILABLE: vi.fn(),
    };

    const mapped = mapDiscourseApiError(error, errors);

    expect(errors.TOO_MANY_REQUESTS).toHaveBeenCalled();
    expect(errors.SERVICE_UNAVAILABLE).not.toHaveBeenCalled();
    expect(mapped).toBe("retryable");
  });

  it("maps non-transient server errors to service unavailable", () => {
    const error = new DiscourseApiError({
      status: 500,
      path: "/server-error",
      method: "GET",
    });

    const errors = {
      SERVICE_UNAVAILABLE: vi.fn(() => "unavailable"),
    };

    const mapped = mapDiscourseApiError(error, errors);

    expect(errors.SERVICE_UNAVAILABLE).toHaveBeenCalled();
    expect(mapped).toBe("unavailable");
  });
});

describe("createRouter retry policy wiring", () => {
  const handler = (fn: any) => fn;
  const builder: any = new Proxy(
    {},
    {
      get: () => ({ handler }),
    }
  );
  const makeRouter = (context: any) =>
    createRouter(context as any, builder as any) as any;

  it("defers retries to the service layer", async () => {
    const searchMock = vi.fn(() => Effect.fail(new Error("transport")));
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const sleepSpy = vi.spyOn(effectHelpers, "sleep");

    const context: any = {
      discourseService: { search: searchMock },
      cryptoService: {},
      nonceManager: new NonceManager({ ttlMs: 1000 }),
      config: {
        variables: {
          discourseBaseUrl: "https://example.com",
          discourseApiUsername: "system",
          clientId: "client",
          requestTimeoutMs: 1000,
          nonceTtlMs: 1000,
          nonceCleanupIntervalMs: 1000,
          userApiScopes: normalizeUserApiScopes(["read"]),
          logBodySnippetLength: 50,
          operationRetryPolicy: { reads: { maxRetries: 1, baseDelayMs: 0 } },
        },
        secrets: { discourseApiKey: "key" },
      },
      logger: createSafeLogger(noopLogger),
      normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
      cleanupFiber: null,
      bodySnippetLength: 50,
      metrics,
    };

    const router = makeRouter(context);

    await expect(
      router.search({
        input: { query: "foo" },
        errors: {},
      })
    ).rejects.toThrow("transport");

    expect(metrics.retryAttempts).toBe(0);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(searchMock).toHaveBeenCalledTimes(1);

    sleepSpy.mockRestore();
  });

  it("throws when BAD_REQUEST error constructor is missing for nonce validation", async () => {
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const context: any = {
      discourseService: {},
      cryptoService: {},
      nonceManager: new NonceManager({ ttlMs: 1000 }),
      config: {
        variables: {
          discourseBaseUrl: "https://example.com",
          discourseApiUsername: "system",
          clientId: "client",
          requestTimeoutMs: 1000,
          nonceTtlMs: 1000,
          nonceCleanupIntervalMs: 1000,
          userApiScopes: normalizeUserApiScopes(["read"]),
          logBodySnippetLength: 50,
        },
        secrets: { discourseApiKey: "key" },
      },
      logger: createSafeLogger(noopLogger),
      normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
      cleanupFiber: null,
      bodySnippetLength: 50,
      metrics,
    };

    const router = makeRouter(context);

    await expect(
      router.completeLink({
        input: { nonce: "missing", payload: "payload" },
        errors: {},
      })
    ).rejects.toBeInstanceOf(RouterConfigError);
    await expect(
      router.completeLink({
        input: { nonce: "missing", payload: "payload" },
        errors: {},
      })
    ).rejects.toThrow("BAD_REQUEST constructor missing");
  });

  it("requires clientId to match nonce owner when completing link", async () => {
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const nonceManager = new NonceManager({ ttlMs: 1000 });
    const nonce = nonceManager.create("client-123", "private-key");
    const context: any = {
      discourseService: {
        getCurrentUser: vi.fn().mockResolvedValue({ username: "user", id: 1 }),
      },
      cryptoService: {
        decryptPayload: vi.fn().mockResolvedValue("user-api-key"),
      },
      nonceManager,
      config: {
        variables: {
          discourseBaseUrl: "https://example.com",
          discourseApiUsername: "system",
          clientId: "client",
          requestTimeoutMs: 1000,
          nonceTtlMs: 1000,
          nonceCleanupIntervalMs: 1000,
          userApiScopes: normalizeUserApiScopes(["read"]),
          logBodySnippetLength: 50,
        },
        secrets: { discourseApiKey: "key" },
      },
      logger: createSafeLogger(noopLogger),
      normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
      cleanupFiber: null,
      bodySnippetLength: 50,
      metrics,
    };

    const errors = {
      BAD_REQUEST: vi.fn(({ message }) => new Error(message)),
    };
    const router = makeRouter(context);

    await expect(
      router.completeLink({
        input: { nonce, payload: "enc", clientId: "wrong-client" },
        errors,
      })
    ).rejects.toThrow("Invalid or expired nonce");

    const result = await router.completeLink({
      input: { nonce, payload: "enc", clientId: "client-123" },
      errors,
    });

    expect(result).toEqual({
      userApiKey: "user-api-key",
      discourseUsername: "user",
      discourseUserId: 1,
    });
    expect(context.cryptoService.decryptPayload).toHaveBeenCalledTimes(1);
  });

  it("rejects replay of consumed nonce", async () => {
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const nonceManager = new NonceManager({ ttlMs: 1000 });
    const nonce = nonceManager.create("client-123", "private-key");
    const context: any = {
      discourseService: {
        getCurrentUser: vi.fn().mockResolvedValue({ username: "user", id: 1 }),
      },
      cryptoService: {
        decryptPayload: vi.fn().mockResolvedValue("user-api-key"),
      },
      nonceManager,
      config: {
        variables: {
          discourseBaseUrl: "https://example.com",
          discourseApiUsername: "system",
          clientId: "client",
          requestTimeoutMs: 1000,
          nonceTtlMs: 1000,
          nonceCleanupIntervalMs: 1000,
          userApiScopes: normalizeUserApiScopes(["read"]),
          logBodySnippetLength: 50,
        },
        secrets: { discourseApiKey: "key" },
      },
      logger: createSafeLogger(noopLogger),
      normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
      cleanupFiber: null,
      bodySnippetLength: 50,
      metrics,
    };

    const errors = {
      BAD_REQUEST: vi.fn(({ message }) => new Error(message)),
    };
    const router = makeRouter(context);

    await router.completeLink({
      input: { nonce, payload: "enc", clientId: "client-123" },
      errors,
    });

    await expect(
      router.completeLink({
        input: { nonce, payload: "enc", clientId: "client-123" },
        errors,
      })
    ).rejects.toThrow("Invalid or expired nonce");
  });

  it("normalizes invalid retry overrides to safe defaults", async () => {
    const searchMock = vi.fn(() => Effect.fail(new Error("transport")));
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const sleepSpy = vi
      .spyOn(effectHelpers, "sleep")
      .mockImplementation((ms) => Effect.succeed(ms));
    const context: any = {
      discourseService: { search: searchMock },
      cryptoService: {},
      nonceManager: new NonceManager({ ttlMs: 1000 }),
      config: {
        variables: {
          discourseBaseUrl: "https://example.com",
          discourseApiUsername: "system",
          clientId: "client",
          requestTimeoutMs: 1000,
          nonceTtlMs: 1000,
          nonceCleanupIntervalMs: 1000,
          userApiScopes: normalizeUserApiScopes(["read"]),
          logBodySnippetLength: 50,
          operationRetryPolicy: {
            reads: { maxRetries: -1, baseDelayMs: -5 },
            writes: { maxRetries: -2, baseDelayMs: -10 },
          },
        },
        secrets: { discourseApiKey: "key" },
      },
      logger: createSafeLogger(noopLogger),
      normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
      cleanupFiber: null,
      bodySnippetLength: 50,
      metrics,
    };

    const router = makeRouter(context);

    await expect(
      router.search({
        input: { query: "foo" },
        errors: {},
      })
    ).rejects.toThrow("transport");

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(metrics.retryAttempts).toBe(0);
    expect(sleepSpy).not.toHaveBeenCalled();

    sleepSpy.mockRestore();
  });

  it("uses defaults when operation retry policy is absent", async () => {
    const searchMock = vi.fn(() =>
      Effect.succeed({
        posts: [],
        topics: [],
        users: [],
        categories: [],
        totalResults: 0,
        hasMore: false,
      })
    );
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const context: any = {
      discourseService: { search: searchMock },
      cryptoService: {},
      nonceManager: new NonceManager({ ttlMs: 1000 }),
      config: {
        variables: {
          discourseBaseUrl: "https://example.com",
          discourseApiUsername: "system",
          clientId: "client",
          requestTimeoutMs: 1000,
          nonceTtlMs: 1000,
          nonceCleanupIntervalMs: 1000,
          userApiScopes: normalizeUserApiScopes(["read"]),
          logBodySnippetLength: 50,
        },
        secrets: { discourseApiKey: "key" },
      },
      logger: createSafeLogger(noopLogger),
      normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
      cleanupFiber: null,
      bodySnippetLength: 50,
      metrics,
    };

    const router = makeRouter(context);

    const result = await router.search({
      input: { query: "foo" },
      errors: {},
    });

    expect(result).toEqual({
      posts: [],
      topics: [],
      users: [],
      categories: [],
      totalResults: 0,
      hasMore: false,
    });
    expect(metrics.retryAttempts).toBe(0);
  });

  it("ignores operation retry overrides at the router level", async () => {
    const searchMock = vi.fn(() => Effect.fail(new Error("blip")));
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const sleepSpy = vi.spyOn(effectHelpers, "sleep");
    const context: any = {
      discourseService: { search: searchMock },
      cryptoService: {},
      nonceManager: new NonceManager({ ttlMs: 1000 }),
      config: {
        variables: {
          discourseBaseUrl: "https://example.com",
          discourseApiUsername: "system",
          clientId: "client",
          requestTimeoutMs: 1000,
          nonceTtlMs: 1000,
          nonceCleanupIntervalMs: 1000,
          userApiScopes: normalizeUserApiScopes(["read"]),
          logBodySnippetLength: 50,
          operationRetryPolicy: {
            default: { maxRetries: 1, baseDelayMs: "not-a-number" as any },
          },
        },
        secrets: { discourseApiKey: "key" },
      },
      logger: createSafeLogger(noopLogger),
      normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
      cleanupFiber: null,
      bodySnippetLength: 50,
      metrics,
    };

    const router = makeRouter(context);

    await expect(
      router.search({
        input: { query: "foo" },
        errors: {},
      })
    ).rejects.toThrow("blip");
    expect(metrics.retryAttempts).toBe(0);
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it("makeHandler executes Effect-based handlers through run()", async () => {
    const { makeHandler } = __internalCreateRouterHelpers(
      buildMockContext() as any
    );
    const handler = makeHandler(
      "effect-action",
      ({ input }) => Effect.succeed({ echoed: input }),
      () => ({ meta: true })
    );

    const result = await handler({
      input: { value: 1 },
      errors: {
        BAD_REQUEST: vi.fn(),
      } as any,
    });

    expect(result).toEqual({ echoed: { value: 1 } });
  });

  it("disables cache storage when ttlMs is non-positive", () => {
    const cache = __internalCreateCache(5, 0);

    cache.set("key", "value");
    const fetched = cache.get("key");
    const stats = cache.stats();

    expect(fetched).toBeUndefined();
    expect(stats).toEqual({
      size: 0,
      hits: 0,
      misses: 1,
      evictions: 0,
      ttlMs: 0,
    });
  });

  it("treats invalid cache size as disabled while preserving ttl metadata", () => {
    const cache = __internalCreateCache(-5, 100);

    cache.set("key", "value");
    const fetched = cache.get("key");
    const stats = cache.stats();

    expect(fetched).toBeUndefined();
    expect(stats).toEqual({
      size: 0,
      hits: 0,
      misses: 1,
      evictions: 0,
      ttlMs: 100,
    });
  });

  it("exposes cache stats when cache is omitted", () => {
    const helpers = __internalCreateRouterHelpers({
      ...buildMockContext(),
      // omit cache to trigger default stub
      cache: undefined,
    } as any);

    expect(helpers.cacheStats()).toEqual({
      size: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      ttlMs: 0,
    });
  });

  it("evicts cache entries by prefix when supported", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const cache = __internalCreateCache(3, 1000, { logger });

    cache.set("posts:1", "one");
    cache.set("posts:2", "two");
    cache.set("topics:1", "topic");

    const removed = cache.deleteByPrefix?.("posts:") ?? 0;

    expect(removed).toBe(2);
    expect(cache.get("topics:1")).toBe("topic");
    expect(cache.stats()).toEqual({
      size: 1,
      hits: 1,
      misses: 0,
      evictions: 2,
      ttlMs: 1000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      "Cache eviction",
      expect.objectContaining({ reason: "prefix", prefix: "posts:" })
    );
  });

  it("skips prefix invalidation when cache does not support it", () => {
    const cache = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      stats: vi.fn(() => ({
        size: 0,
        hits: 0,
        misses: 0,
        evictions: 0,
        ttlMs: 0,
      })),
    };
    const helpers = __internalCreateRouterHelpers({
      ...buildMockContext(),
      cache,
    } as any);

    expect(() => helpers.invalidateCacheByPrefix(["posts:"])).not.toThrow();
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it("returns undefined rate limit key for non-object inputs", () => {
    const helpers = __internalCreateRouterHelpers(buildMockContext() as any);

    expect(helpers.resolveRateLimitKey(null as any)).toBeUndefined();
    expect(helpers.resolveRateLimitKey(42 as any)).toBeUndefined();
  });
});

describe("normalizeUserApiScopes", () => {
  it("deduplicates, lowercases, and joins valid scopes", () => {
    const normalized = normalizeUserApiScopes([
      " Read ",
      "write",
      "READ",
      "custom_scope",
    ]);

    expect(normalized.joined).toBe("custom_scope,read,write");
    expect(normalized.scopes).toEqual(["custom_scope", "read", "write"]);
  });

  it("throws for non-array input", () => {
    expect(() => normalizeUserApiScopes(null as unknown as string[])).toThrow();
  });

  it("throws for blank scopes", () => {
    expect(() => normalizeUserApiScopes([" "])).toThrow(/at least one/i);
  });

  it("throws for invalid characters", () => {
    expect(() => normalizeUserApiScopes(["read", "WRONG!"])).toThrow(
      /invalid user api scope/i
    );
  });

  it("drops non-string entries while keeping valid scopes", () => {
    expect(normalizeUserApiScopes(["read", 123 as any, "Write"]).joined).toBe(
      "read,write"
    );
  });

  it("supports comma-delimited scope strings", () => {
    expect(normalizeUserApiScopes("read, write").scopes).toEqual([
      "read",
      "write",
    ]);
  });
});

describe("createRouter handlers", () => {
  const handler = (fn: any) => fn;
  const builder: any = new Proxy(
    {},
    {
      get: () => ({ handler }),
    }
  );
  const makeRouter = (context: any) =>
    createRouter(context as any, builder as any) as any;

  const makeContext = () => {
    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const service: any = {
      buildUploadRequest: vi.fn(() => ({ url: "/uploads", method: "POST" })),
      presignUpload: vi.fn(() =>
        Effect.succeed({
          method: "PUT" as const,
          uploadUrl: "https://uploads.example.com/key",
          headers: {},
          key: "uploads/key",
          uniqueIdentifier: "abc",
        })
      ),
      batchPresignMultipartUpload: vi.fn(() =>
        Effect.succeed({
          uploadId: "upload-1",
          key: "uploads/key",
          uniqueIdentifier: "abc",
          parts: [{ partNumber: 1, url: "https://upload/part1", headers: {} }],
        })
      ),
      completeMultipartUpload: vi.fn(() =>
        Effect.succeed({ upload: { id: 1, url: "/uploads/1" } })
      ),
      abortMultipartUpload: vi.fn(() => Effect.succeed(true)),
      editPost: vi.fn(() =>
        Effect.succeed({
          id: 10,
          topicId: undefined,
          topicSlug: undefined,
          postUrl: null,
        })
      ),
      lockPost: vi.fn(() => Effect.succeed({ locked: true })),
      performPostAction: vi.fn(() =>
        Effect.succeed({
          success: true,
          action: "like",
          postActionTypeId: 2,
          postActionId: 1,
        })
      ),
      deletePost: vi.fn(() => Effect.succeed({ success: true })),
      getPostReplies: vi.fn(() => Effect.succeed([{ id: 1 }])),
      getRevision: vi.fn(() =>
        Effect.succeed({ revision: { number: 1 }, raw: "body" })
      ),
      updateRevision: vi.fn(() => Effect.succeed({ revision: { number: 2 } })),
      deleteRevision: vi.fn(() => Effect.succeed({ success: true })),
      getUser: vi.fn(() => Effect.succeed({ username: "alice" })),
      createUser: vi.fn(() => Effect.succeed({ success: true, userId: 1 })),
      updateUser: vi.fn(() => Effect.succeed({ success: true })),
      deleteUser: vi.fn(() => Effect.succeed({ success: true })),
      listUsers: vi.fn(() => Effect.succeed([{ username: "alice" }])),
      listAdminUsers: vi.fn(() => Effect.succeed([{ username: "admin" }])),
      getUserByExternal: vi.fn(() => Effect.succeed({ username: "external" })),
      getDirectory: vi.fn(() => Effect.succeed({ items: [], totalRows: 0 })),
      forgotPassword: vi.fn(() => Effect.succeed({ success: true })),
      changePassword: vi.fn(() => Effect.succeed({ success: true })),
      logoutUser: vi.fn(() => Effect.succeed({ success: true })),
      syncSso: vi.fn(() => Effect.succeed({ success: true, userId: 5 })),
      getUserStatus: vi.fn(() => Effect.succeed({ status: null })),
      updateUserStatus: vi.fn(() =>
        Effect.succeed({
          status: { emoji: "ok", description: null, endsAt: null },
        })
      ),
      getSiteInfo: vi.fn(() =>
        Effect.succeed({ title: "site", categories: [] })
      ),
      getSiteBasicInfo: vi.fn(() =>
        Effect.succeed({
          title: "site",
          description: null,
          logoUrl: null,
          mobileLogoUrl: null,
          faviconUrl: null,
          contactEmail: null,
          canonicalHostname: null,
          defaultLocale: null,
        })
      ),
    };

    const context: any = {
      discourseService: service,
      cryptoService: {},
      nonceManager: new NonceManager({ ttlMs: 1000 }),
      config: {
        variables: {
          discourseBaseUrl: "https://example.com",
          discourseApiUsername: "system",
          clientId: "client",
          requestTimeoutMs: 1000,
          nonceTtlMs: 1000,
          nonceCleanupIntervalMs: 1000,
          userApiScopes: normalizeUserApiScopes(["read"]),
          logBodySnippetLength: 50,
        },
        secrets: { discourseApiKey: "key" },
      },
      logger: createSafeLogger(noopLogger),
      normalizedUserApiScopes: normalizeUserApiScopes(["read"]),
      cleanupFiber: null,
      bodySnippetLength: 50,
      metrics,
    };

    return { context, service, metrics };
  };

  const makeLoggingContext = () => {
    const logSpy =
      vi.fn<
        (payload: {
          level: string;
          message: string;
          meta?: Record<string, unknown>;
        }) => void
      >();
    const logger = {
      error: (message: string, meta?: Record<string, unknown>) =>
        logSpy({ level: "error", message, meta }),
      warn: (message: string, meta?: Record<string, unknown>) =>
        logSpy({ level: "warn", message, meta }),
      info: (message: string, meta?: Record<string, unknown>) =>
        logSpy({ level: "info", message, meta }),
      debug: (message: string, meta?: Record<string, unknown>) =>
        logSpy({ level: "debug", message, meta }),
    };

    const base = makeContext();
    base.context.logger = logger as any;

    return { ...base, logSpy };
  };

  it("routes upload handlers through to the service", async () => {
    const { context, service } = makeContext();
    const router = makeRouter(context);
    const upload = uploadPayload();

    const request = await router.prepareUpload({
      input: { uploadType: upload.uploadType, username: upload.username },
      errors: {},
    });
    const presign = await router.presignUpload({
      input: {
        filename: upload.filename,
        byteSize: upload.byteSize,
        contentType: upload.contentType,
        uploadType: upload.uploadType,
      },
      errors: {},
    });
    const multipart = await router.batchPresignMultipartUpload({
      input: {
        uniqueIdentifier: upload.uniqueIdentifier,
        partNumbers: upload.parts.map((part) => part.partNumber),
        uploadId: upload.uploadId,
        key: upload.key,
      },
      errors: {},
    });
    const completion = await router.completeMultipartUpload({
      input: {
        uniqueIdentifier: upload.uniqueIdentifier,
        uploadId: upload.uploadId,
        key: upload.key,
        parts: upload.parts,
        filename: upload.filename,
        uploadType: upload.uploadType,
      },
      errors: {},
    });
    const aborted = await router.abortMultipartUpload({
      input: {
        uniqueIdentifier: upload.uniqueIdentifier,
        uploadId: upload.uploadId,
        key: upload.key,
      },
      errors: {},
    });

    expect(request).toEqual({ request: { url: "/uploads", method: "POST" } });
    expect(presign).toHaveProperty(
      "uploadUrl",
      "https://uploads.example.com/key"
    );
    expect(multipart.parts[0]).toEqual(
      expect.objectContaining({ partNumber: 1, url: "https://upload/part1" })
    );
    expect(completion).toEqual({ upload: { id: 1, url: "/uploads/1" } });
    expect(aborted).toEqual({ aborted: true });
    expect(service.presignUpload).toHaveBeenCalled();
    expect(service.completeMultipartUpload).toHaveBeenCalled();
  });

  it("defaults upload types when omitted for upload handlers", async () => {
    const { context, service } = makeContext();
    const router = makeRouter(context);

    await router.prepareUpload({
      input: { username: "alice" },
      errors: {},
    });

    await router.completeMultipartUpload({
      input: {
        uniqueIdentifier: "abc",
        uploadId: "upload-1",
        key: "uploads/key",
        parts: [],
        filename: "file.txt",
      },
      errors: {},
    });

    expect(service.buildUploadRequest).toHaveBeenCalledWith(
      expect.objectContaining({ uploadType: "composer" })
    );
    expect(service.completeMultipartUpload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadType: "composer" })
    );
  });

  it("handles moderation and revision routes", async () => {
    const { context, service } = makeContext();
    const router = makeRouter(context);

    const lock = await router.lockPost({
      input: { postId: 1, locked: true, username: "alice" },
      errors: {},
    });
    const action = await router.performPostAction({
      input: {
        postId: 1,
        action: "like",
        username: "alice",
        postActionTypeId: 2,
      },
      errors: {},
    });
    const deleted = await router.deletePost({
      input: { postId: 1, forceDestroy: false, username: "alice" },
      errors: {},
    });
    const replies = await router.getPostReplies({
      input: { postId: 1 },
      errors: {},
    });
    const revision = await router.getRevision({
      input: { postId: 1, revision: 1, includeRaw: true },
      errors: {},
    });
    const updatedRevision = await router.updateRevision({
      input: { postId: 1, revision: 2, raw: "body", username: "alice" },
      errors: {},
    });
    const deletedRevision = await router.deleteRevision({
      input: { postId: 1, revision: 1, username: "alice" },
      errors: {},
    });
    const user = await router.getUser({
      input: { username: "alice" },
      errors: {},
    });
    const createdUser = await router.createUser({
      input: { username: "alice", email: "a@example.com", password: "pass" },
      errors: {},
    });
    const updatedUser = await router.updateUser({
      input: { username: "alice", name: "Alice" },
      errors: {},
    });
    const removedUser = await router.deleteUser({
      input: { userId: 1, deletePosts: true },
      errors: {},
    });
    const users = await router.listUsers({ input: { page: 1 }, errors: {} });
    const adminUsers = await router.listAdminUsers({
      input: { filter: "active", page: 1, showEmails: true },
      errors: {},
    });
    const externalUser = await router.getUserByExternal({
      input: { externalId: "id", provider: "oidc" },
      errors: {},
    });
    const directory = await router.getDirectory({
      input: { period: "weekly", order: "likes_received", page: 1 },
      errors: {},
    });
    const forgot = await router.forgotPassword({
      input: { login: "user@example.com" },
      errors: {},
    });
    const changed = await router.changePassword({
      input: { token: "tok", password: "newpass" },
      errors: {},
    });

    expect(lock.locked).toBe(true);
    expect(action.action).toBe("like");
    expect(deleted.success).toBe(true);
    expect(replies).toEqual({ replies: [{ id: 1 }] });
    expect(revision).toEqual({ revision: { number: 1 }, raw: "body" });
    expect(updatedRevision).toEqual({ revision: { number: 2 } });
    expect(deletedRevision).toEqual({ success: true });
    expect(user).toEqual({ user: { username: "alice" } });
    expect(createdUser).toEqual({ success: true, userId: 1 });
    expect(updatedUser).toEqual({ success: true });
    expect(removedUser).toEqual({ success: true });
    expect(users).toEqual({ users: [{ username: "alice" }] });
    expect(adminUsers).toEqual({ users: [{ username: "admin" }] });
    expect(externalUser).toEqual({ user: { username: "external" } });
    expect(directory).toEqual({ items: [], totalRows: 0 });
    expect(forgot).toEqual({ success: true });
    expect(changed).toEqual({ success: true });
    expect(service.lockPost).toHaveBeenCalled();
    expect(service.performPostAction).toHaveBeenCalled();
    expect(service.getRevision).toHaveBeenCalled();
    expect(service.createUser).toHaveBeenCalled();
  });

  it("does not cache getRevision across users", async () => {
    const { context, service } = makeContext();
    const cache = {
      get: vi.fn(),
      set: vi.fn(),
      stats: vi.fn(() => ({ size: 0, hits: 0, misses: 0, ttlMs: 0 })),
    };

    context.cache = cache as any;
    const router = makeRouter(context);

    await router.getRevision({
      input: {
        postId: 1,
        revision: 1,
        username: "alice",
        userApiKey: "token-a",
      },
      errors: {},
    });
    await router.getRevision({
      input: { postId: 1, revision: 1, username: "bob", userApiKey: "token-b" },
      errors: {},
    });

    expect(service.getRevision).toHaveBeenCalledTimes(2);
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("logs deletePost with default forceDestroy when omitted", async () => {
    const { context, service } = makeContext();
    const logSpy = vi.fn();
    context.logger = createSafeLogger({
      info: logSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });
    const router = makeRouter(context);

    await router.deletePost({
      input: { postId: 12, username: "alice" },
      errors: {},
    });

    expect(service.deletePost).toHaveBeenCalledWith(
      expect.objectContaining({ forceDestroy: false })
    );
    expect(logSpy).toHaveBeenCalledWith(
      "Deleted Discourse post",
      expect.objectContaining({ forceDestroy: false })
    );
  });

  it("logs delete post metadata consistently", async () => {
    const { context, service, logSpy } = makeLoggingContext();
    const router = makeRouter(context);

    await router.deletePost({
      input: { postId: 7, username: "alice" },
      errors: {},
    });

    expect(service.deletePost).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: 7,
        forceDestroy: false,
        username: "alice",
      })
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        message: "Deleted Discourse post",
        meta: expect.objectContaining({
          action: "delete-post",
          postId: 7,
          forceDestroy: false,
          discourseUsername: "alice",
        }),
      })
    );

    service.deletePost.mockImplementationOnce(() =>
      Effect.fail(new Error("delete failed"))
    );

    await expect(
      router.deletePost({
        input: { postId: 7, username: "alice" },
        errors: {},
      })
    ).rejects.toThrow("delete failed");

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "delete-post failed",
        meta: expect.objectContaining({
          action: "delete-post",
          postId: 7,
          forceDestroy: false,
          discourseUsername: "alice",
          attempt: 1,
          error: expect.objectContaining({ message: "delete failed" }),
        }),
      })
    );
  });

  it("logs resolved upload metadata for success and failure", async () => {
    const { context, service, logSpy } = makeLoggingContext();
    const router = makeRouter(context);

    await router.presignUpload({
      input: {
        filename: "file.png",
        byteSize: 10,
        contentType: "image/png",
      },
      errors: {},
    });

    expect(service.presignUpload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadType: "composer" })
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        message: "Generated presigned upload",
        meta: expect.objectContaining({
          action: "presign-upload",
          uploadType: "composer",
          filename: "file.png",
        }),
      })
    );

    service.presignUpload.mockImplementationOnce(() =>
      Effect.fail(new Error("presign boom"))
    );

    await expect(
      router.presignUpload({
        input: { filename: "file.png", byteSize: 10, contentType: "image/png" },
        errors: {},
      })
    ).rejects.toThrow("presign boom");

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "presign-upload failed",
        meta: expect.objectContaining({
          action: "presign-upload",
          uploadType: "composer",
          filename: "file.png",
          attempt: 1,
          error: expect.objectContaining({ message: "presign boom" }),
        }),
      })
    );
  });

  it("returns service unavailable when edit post response lacks topic metadata", async () => {
    const { context } = makeContext();
    const router = makeRouter(context);
    const errors = {
      SERVICE_UNAVAILABLE: vi.fn((payload: any) => {
        const err = new Error("503");
        (err as any).payload = payload;
        return err;
      }),
    };

    await expect(
      router.editPost({
        input: { postId: 1, raw: "content", username: "alice" },
        errors,
      })
    ).rejects.toHaveProperty("payload");

    expect(errors.SERVICE_UNAVAILABLE).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Discourse response missing topicSlug/topicId",
        data: expect.objectContaining({
          topicId: undefined,
          topicSlug: undefined,
        }),
      })
    );
  });

  it("handles user status and site info routes", async () => {
    const { context, service } = makeContext();
    const router = makeRouter(context);

    const logout = await router.logoutUser({
      input: { userId: 1 },
      errors: {},
    });
    const sync = await router.syncSso({
      input: { sso: "payload", sig: "sig" },
      errors: {},
    });
    const status = await router.getUserStatus({
      input: { username: "alice" },
      errors: {},
    });
    const updatedStatus = await router.updateUserStatus({
      input: { username: "alice", emoji: "ok" },
      errors: {},
    });
    const site = await router.getSiteInfo({ errors: {} });
    const basic = await router.getSiteBasicInfo({ errors: {} });

    expect(logout).toEqual({ success: true });
    expect(sync).toEqual({ success: true, userId: 5 });
    expect(status).toEqual({ status: null });
    expect(updatedStatus.status).toEqual(
      expect.objectContaining({ emoji: "ok" })
    );
    expect(site).toEqual(expect.objectContaining({ categories: [] }));
    expect(basic).toEqual(expect.objectContaining({ title: "site" }));
    expect(service.logoutUser).toHaveBeenCalled();
    expect(service.getSiteBasicInfo).toHaveBeenCalled();
  });
});

describe("mapValidateUserApiKeyResult", () => {
  const errors = {
    TOO_MANY_REQUESTS: vi.fn((payload: any) => {
      const err = new Error("429");
      (err as any).payload = payload;
      return err;
    }),
    UNAUTHORIZED: vi.fn((payload: any) => {
      const err = new Error("401");
      (err as any).payload = payload;
      return err;
    }),
  };

  beforeEach(() => {
    errors.TOO_MANY_REQUESTS.mockClear();
    errors.UNAUTHORIZED.mockClear();
  });

  it("returns the result when validation succeeds", () => {
    const result = { valid: true as const, user: { id: 1 } };
    expect(mapValidateUserApiKeyResult(result, errors)).toBe(result);
  });

  it("throws when required error constructors are missing", () => {
    expect(() =>
      mapValidateUserApiKeyResult({ valid: false, retryable: true }, {})
    ).toThrow("Required error constructors missing");
  });

  it("throws TOO_MANY_REQUESTS when retryable is true", () => {
    expect(() =>
      mapValidateUserApiKeyResult(
        { valid: false, retryable: true, error: "try later" },
        errors
      )
    ).toThrow("429");
    expect(errors.TOO_MANY_REQUESTS).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "try later",
        data: expect.objectContaining({ retryable: true }),
      })
    );
  });

  it("throws UNAUTHORIZED when retryable is false", () => {
    expect(() =>
      mapValidateUserApiKeyResult(
        { valid: false, retryable: false, error: "bad key" },
        errors
      )
    ).toThrow("401");
    expect(errors.UNAUTHORIZED).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "bad key",
        data: expect.objectContaining({ retryable: false }),
      })
    );
  });

  it("uses default messages when validation errors are missing", () => {
    expect(() =>
      mapValidateUserApiKeyResult({ valid: false, retryable: true }, errors)
    ).toThrow("429");
    expect(errors.TOO_MANY_REQUESTS).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Validation retry suggested",
        data: expect.objectContaining({ retryable: true }),
      })
    );

    expect(() =>
      mapValidateUserApiKeyResult({ valid: false, retryable: false }, errors)
    ).toThrow("401");
    expect(errors.UNAUTHORIZED).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "User API key invalid",
        data: expect.objectContaining({ retryable: false }),
      })
    );
  });
});

describe("validateUserApiKey router mapping", () => {
  const makeConfig = () =>
    ({
      variables: {
        discourseBaseUrl: "https://example.com",
        discourseApiUsername: "system",
        clientId: "client",
        requestTimeoutMs: 1000,
        requestsPerSecond: 5,
        rateLimitStrategy: "global",
        rateLimitBucketTtlMs: 1000,
        rateLimitMaxBuckets: 10,
        cacheMaxSize: 10,
        cacheTtlMs: 1000,
        nonceTtlMs: 2000,
        nonceCleanupIntervalMs: 1000,
        userApiScopes: normalizeUserApiScopes(["read"]),
        logBodySnippetLength: DEFAULT_BODY_SNIPPET_LENGTH,
      },
      secrets: { discourseApiKey: "secret" },
      logger: noopLogger,
    } as const);

  const builder = new Proxy(
    {},
    {
      get: () => ({ handler: (fn: any) => fn }),
    }
  ) as any;
  const makeRouter = (context: any) =>
    createRouter(context as any, builder as any) as any;

  const makeHandler = (result: {
    valid: boolean;
    retryable?: boolean;
    error?: string;
  }) => {
    const config = makeConfig();
    const nonceManager = new NonceManager({
      ttlMs: config.variables.nonceTtlMs,
    });
    const context = {
      discourseService: {
        validateUserApiKey: vi.fn().mockReturnValue(Effect.succeed(result)),
      } as any,
      cryptoService: {} as any,
      nonceManager,
      config,
      logger: createSafeLogger(),
      normalizedUserApiScopes: {
        joined: "read,write",
        scopes: ["read", "write"],
      },
      cleanupFiber: {} as any,
    } as any;

    const router = makeRouter(context);
    return {
      handler: router.validateUserApiKey,
      service: context.discourseService,
    };
  };

  it("maps retryable validation failures to TOO_MANY_REQUESTS", async () => {
    const { handler } = makeHandler({
      valid: false,
      retryable: true,
      error: "try again",
    });

    const errors = {
      TOO_MANY_REQUESTS: vi.fn((payload: any) => {
        const err = new Error("429");
        (err as any).payload = payload;
        return err;
      }),
      UNAUTHORIZED: vi.fn(),
    };

    await expect(
      handler({
        input: { userApiKey: "key" },
        errors,
      })
    ).rejects.toHaveProperty(
      "payload",
      expect.objectContaining({
        data: expect.objectContaining({ retryable: true }),
      })
    );

    expect(errors.TOO_MANY_REQUESTS).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "try again",
        data: expect.objectContaining({ retryable: true }),
      })
    );
    expect(errors.UNAUTHORIZED).not.toHaveBeenCalled();
  });

  it("maps non-retryable validation failures to UNAUTHORIZED", async () => {
    const { handler } = makeHandler({
      valid: false,
      retryable: false,
      error: "bad key",
    });

    const errors = {
      TOO_MANY_REQUESTS: vi.fn(),
      UNAUTHORIZED: vi.fn((payload: any) => {
        const err = new Error("401");
        (err as any).payload = payload;
        return err;
      }),
    };

    await expect(
      handler({
        input: { userApiKey: "key" },
        errors,
      })
    ).rejects.toHaveProperty(
      "payload",
      expect.objectContaining({
        data: expect.objectContaining({ retryable: false }),
      })
    );

    expect(errors.UNAUTHORIZED).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "bad key",
        data: expect.objectContaining({ retryable: false }),
      })
    );
    expect(errors.TOO_MANY_REQUESTS).not.toHaveBeenCalled();
  });
});
