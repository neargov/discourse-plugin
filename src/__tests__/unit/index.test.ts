import { describe, expect, it, vi, beforeEach } from "vitest";
import { Effect } from "every-plugin/effect";
import DiscoursePlugin, {
  createWithErrorLogging,
  sanitizeErrorForLog,
  mapDiscourseApiError,
  normalizeUserApiScopes,
  createRouter,
  mapValidateUserApiKeyResult,
  VariablesSchema,
  RouterConfigError,
} from "../../index";
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
import { uploadPayload } from "../../tests/fixtures";

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

  it("retries once when retry-after metadata is present", async () => {
    const { log, logSpy } = makeLogger();
    const nonceManager = new NonceManager();
    const error = new DiscourseApiError({
      status: 503,
      path: "/retry",
      method: "GET",
      retryAfterMs: 2500,
    });
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce("ok");
    const sleepSpy = vi
      .spyOn(effectHelpers, "sleep")
      .mockImplementation((ms) => Effect.succeed(ms));

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
    });

    const result = await withErrorLogging("retry-action", () => fn(), {});

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledWith(1000);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: "Discourse request retrying after retry-after",
        meta: expect.objectContaining({
          action: "retry-action",
          retryAfterMs: 1000,
          status: 503,
          path: "/retry",
        }),
      })
    );

    sleepSpy.mockRestore();
  });

  it("retries server errors above 500 using retry-after metadata", async () => {
    const { log, logSpy } = makeLogger();
    const nonceManager = new NonceManager();
    const error = new DiscourseApiError({
      status: 500,
      path: "/retry",
      method: "GET",
      retryAfterMs: 2500,
    });
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce("ok");
    const sleepSpy = vi
      .spyOn(effectHelpers, "sleep")
      .mockImplementation((ms) => Effect.succeed(ms));

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
    });

    const result = await withErrorLogging("retry-server", () => fn(), {});

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledWith(1000);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: "Discourse request retrying after retry-after",
        meta: expect.objectContaining({
          action: "retry-server",
          retryAfterMs: 1000,
          status: 500,
          path: "/retry",
        }),
      })
    );

    sleepSpy.mockRestore();
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

  it("retries transport errors when configured", async () => {
    const { log, logSpy } = makeLogger();
    const nonceManager = new NonceManager();
    const sleepSpy = vi
      .spyOn(effectHelpers, "sleep")
      .mockImplementation((ms) => Effect.succeed(ms));
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("network blip");
      })
      .mockResolvedValueOnce("ok");

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
      retryPolicy: {
        retryOnTransportError: true,
        minDelayMs: 10,
        maxAttempts: 3,
      },
    });

    const result = await withErrorLogging("transport-retry", () => fn(), {});

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledWith(10);
    expect(logSpy).toHaveBeenCalledWith({
      level: "warn",
      message: "Discourse request retrying after transport error",
      meta: {
        action: "transport-retry",
        retryAfterMs: 10,
        status: undefined,
        path: undefined,
        attempt: 1,
        transportRetry: true,
      },
    });

    sleepSpy.mockRestore();
  });

  it("records retry attempts through metrics hooks", async () => {
    const { log } = makeLogger();
    const nonceManager = new NonceManager();
    const sleepSpy = vi
      .spyOn(effectHelpers, "sleep")
      .mockImplementation((ms) => Effect.succeed(ms));
    const metrics = { attempts: 0 };
    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
      retryPolicy: {
        retryOnTransportError: true,
        minDelayMs: 5,
        maxAttempts: 2,
      },
      metrics: {
        recordRetryAttempt: ({ attempt, delayMs, status }) => {
          metrics.attempts += 1;
          expect(attempt).toBe(1);
          expect(delayMs).toBe(5);
          expect(status).toBeUndefined();
        },
      },
    });

    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("network blip");
      })
      .mockResolvedValueOnce("ok");

    const result = await withErrorLogging("metrics-retry", () => fn(), {});

    expect(result).toBe("ok");
    expect(metrics.attempts).toBe(1);

    sleepSpy.mockRestore();
  });

  it("records retry attempts with Discourse status metadata", async () => {
    const { log } = makeLogger();
    const nonceManager = new NonceManager();
    const sleepSpy = vi
      .spyOn(effectHelpers, "sleep")
      .mockImplementation((ms) => Effect.succeed(ms));
    const metrics = { attempts: 0 };
    const error = new DiscourseApiError({
      status: 429,
      path: "/limited",
      method: "GET",
      retryAfterMs: 500,
    });

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
      metrics: {
        recordRetryAttempt: ({ status }) => {
          metrics.attempts += 1;
          expect(status).toBe(429);
        },
      },
    });

    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce("ok");

    const result = await withErrorLogging("retry-limited", () => fn(), {});

    expect(result).toBe("ok");
    expect(metrics.attempts).toBe(1);
    expect(sleepSpy).toHaveBeenCalledWith(500);

    sleepSpy.mockRestore();
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

  it("derives read retry policy and records retry attempts", async () => {
    let attempts = 0;
    const searchMock = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        return Effect.fail(new Error("transport"));
      }
      return Effect.succeed({
        posts: [],
        topics: [],
        users: [],
        categories: [],
        totalResults: 0,
        hasMore: false,
      });
    });
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
    expect(metrics.retryAttempts).toBe(1);
    expect(sleepSpy).toHaveBeenCalledWith(0);

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

  it("uses default retry overrides when specific policies are missing", async () => {
    let attempts = 0;
    const searchMock = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) {
        return Effect.fail(new Error("blip"));
      }
      return Effect.succeed({
        posts: [],
        topics: [],
        users: [],
        categories: [],
        totalResults: 0,
        hasMore: false,
      });
    });
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
    expect(metrics.retryAttempts).toBe(1);
    expect(sleepSpy).toHaveBeenCalledWith(0);

    sleepSpy.mockRestore();
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
        nonceTtlMs: 2000,
        nonceCleanupIntervalMs: 1000,
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
