import { Effect } from "every-plugin/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as utils from "../../utils";
import { mapDiscourseApiError, mapPluginError } from "../../index";
import { DiscourseApiError } from "../../service";
import type { DiscourseApiError as DiscourseApiErrorType } from "../../service";
import {
  validCategoryPayload,
  validPostPayload,
  validSearchResponse,
  validTagGroupPayload,
  validTagPayload,
  validTopicPayload,
  validUserPayload,
  validAdminUserPayload,
  validDirectoryItemPayload,
  validRevisionPayload,
  uploadPayload,
} from "../fixtures";

type MockResponse = {
  ok: boolean;
  status?: number;
  headers: { get: (key: string) => string | null };
  json?: () => Promise<any>;
  text?: () => Promise<string>;
};

type FetchMock = ReturnType<typeof vi.fn>;

const makeRes = (overrides: Partial<MockResponse> = {}): MockResponse => ({
  ok: true,
  headers: { get: () => null },
  json: async () => ({}),
  text: undefined,
  ...overrides,
});

const emptyRes = (): MockResponse =>
  makeRes({
    headers: { get: (key: string) => (key === "content-length" ? "0" : null) },
    text: async () => "",
  });

type VitestWithTimers = typeof vi & {
  runAllTimers?: () => void;
  runAllTimersAsync?: () => Promise<void>;
  advanceTimersByTime?: (ms: number) => void;
  advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
};

const runAllTimersAwaitable = async () => {
  const timers = vi as VitestWithTimers;

  if (typeof timers.runAllTimersAsync === "function") {
    await timers.runAllTimersAsync();
    return;
  }

  if (typeof timers.runAllTimers === "function") {
    timers.runAllTimers();
    return;
  }

  if (typeof timers.advanceTimersByTimeAsync === "function") {
    await timers.advanceTimersByTimeAsync(2_000);
    return;
  }

  if (typeof timers.advanceTimersByTime === "function") {
    timers.advanceTimersByTime(2_000);
  }
};

type RunEffect = <A, E = unknown>(
  eff: Effect.Effect<A, E, never>
) => Promise<A>;
const run: RunEffect = (eff) => Effect.runPromise(eff);

const makeErrors = () => {
  const tooManyRequests = vi.fn((payload: any) => ({
    code: "TOO_MANY",
    payload,
  })) as any;
  const rateLimited = vi.fn((payload: any) => ({
    code: "RATE_LIMITED",
    payload,
  })) as any;
  const serviceUnavailable = vi.fn((payload: any) => ({
    code: "SERVICE_UNAVAILABLE",
    payload,
  })) as any;

  return {
    hooks: { tooManyRequests, rateLimited, serviceUnavailable },
    errors: {
      TOO_MANY_REQUESTS: tooManyRequests,
      RATE_LIMITED: rateLimited,
      SERVICE_UNAVAILABLE: serviceUnavailable,
    },
  };
};

const expectDiscourseApiError = async (
  operation: () => Promise<unknown>,
  expected: {
    status: number;
    method: string;
    pathIncludes?: string;
    bodyIncludes?: string;
    contextIncludes?: string;
  }
): Promise<DiscourseApiErrorType | undefined> => {
  const extractDiscourseError = (
    error: unknown
  ): DiscourseApiErrorType | undefined => {
    if (error instanceof DiscourseApiError) return error;
    if (error && typeof error === "object") {
      const candidate =
        (error as any).cause ??
        (error as any).failure ??
        (error as any).error ??
        (error as any).value;
      if (candidate instanceof DiscourseApiError) {
        return candidate;
      }
      const nested =
        (candidate as any)?.error ??
        (candidate as any)?.defect ??
        (candidate as any)?.value ??
        (candidate as any)?.cause;
      if (candidate && candidate !== error) {
        const resolved = extractDiscourseError(candidate);
        if (resolved) return resolved;
      }
      if (nested && nested !== candidate) {
        const resolved = extractDiscourseError(nested);
        if (resolved) return resolved;
      }
    }
    return undefined;
  };

  try {
    await operation();
    throw new Error("Expected rejection");
  } catch (error) {
    const discError = extractDiscourseError(error);
    const message = discError ? discError.message : String(error);

    if (discError) {
      expect(discError.status).toBe(expected.status);
      expect(discError.method).toBe(expected.method);
      if (expected.pathIncludes) {
        expect(String(discError.path)).toContain(expected.pathIncludes);
      }
      if (expected.bodyIncludes) {
        expect(String(discError.bodySnippet ?? "")).toContain(
          expected.bodyIncludes
        );
      }
      if (expected.contextIncludes) {
        expect(String(discError.message)).toContain(expected.contextIncludes);
      }
    } else {
      expect(message).toContain(String(expected.status));
      expect(message).toContain(expected.method);
      if (expected.pathIncludes) {
        expect(message).toContain(expected.pathIncludes);
      }
      if (expected.bodyIncludes) {
        expect(message).toContain(expected.bodyIncludes);
      }
      if (expected.contextIncludes) {
        expect(message).toContain(expected.contextIncludes);
      }
    }

    return discError;
  }
};

const withFetch = (cb: (fetchMock: FetchMock) => void) => {
  return () => {
    // define mock up front so tests can reference it during registration
    const fetchMock: FetchMock = vi.fn();
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      fetchMock.mockReset();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    cb(fetchMock);
  };
};

const {
  DiscourseService,
  CryptoService,
  NonceManager,
  NonceCapacityError,
  noopLogger,
  createSafeLogger,
} = await import("../../service");
const { createDiscourseDeps } = await import("../../runtime/deps");

describe("mapDiscourseApiError", () => {
  it("routes client errors to specific handlers with original message", () => {
    const handlers = {
      UNAUTHORIZED: vi.fn(() => ({ code: "UNAUTHORIZED" })),
      FORBIDDEN: vi.fn(() => ({ code: "FORBIDDEN" })),
      NOT_FOUND: vi.fn(() => ({ code: "NOT_FOUND" })),
      BAD_REQUEST: vi.fn(() => ({ code: "BAD_REQUEST" })),
      TOO_MANY_REQUESTS: vi.fn(),
      SERVICE_UNAVAILABLE: vi.fn(),
    };

    const errors = { ...handlers };
    const cases: Array<{ status: number; hook: keyof typeof handlers }> = [
      { status: 401, hook: "UNAUTHORIZED" },
      { status: 403, hook: "FORBIDDEN" },
      { status: 404, hook: "NOT_FOUND" },
      { status: 422, hook: "BAD_REQUEST" },
    ];

    for (const { status, hook } of cases) {
      const error = new DiscourseApiError({
        status,
        path: `/path-${status}`,
        method: "GET",
      });

      const result = mapDiscourseApiError(error, errors);
      const lastResult =
        handlers[hook].mock.results[handlers[hook].mock.results.length - 1]
          ?.value;
      expect(result).toBe(lastResult);
      expect(handlers[hook]).toHaveBeenLastCalledWith({
        message: error.message,
        data: {
          status,
          path: `/path-${status}`,
          method: "GET",
          retryAfterMs: undefined,
          requestId: undefined,
        },
      });
    }
  });

  it("maps 429 errors with retry metadata", () => {
    const { errors, hooks } = makeErrors();
    const mapped = { mapped: true };
    hooks.tooManyRequests.mockReturnValueOnce(mapped as any);

    const error = new DiscourseApiError({
      status: 429,
      path: "/path",
      method: "GET",
      retryAfterMs: 1500,
      requestId: "req-1",
    });

    const result = mapDiscourseApiError(error, errors);

    expect(result).toBe(mapped);
    expect(hooks.tooManyRequests).toHaveBeenCalledWith({
      message: error.message,
      data: {
        status: 429,
        path: "/path",
        method: "GET",
        retryAfterMs: 1500,
        requestId: "req-1",
      },
    });
    expect(hooks.serviceUnavailable).not.toHaveBeenCalled();
  });

  it("falls back to RATE_LIMITED when TOO_MANY_REQUESTS is missing", () => {
    const { errors, hooks } = makeErrors();
    const fallback = { mapped: "rate-limited" };
    hooks.rateLimited.mockReturnValueOnce(fallback as any);

    const error = new DiscourseApiError({
      status: 429,
      path: "/limited",
      method: "POST",
    });

    const result = mapDiscourseApiError(error, {
      ...errors,
      TOO_MANY_REQUESTS: undefined,
    });

    expect(result).toBe(fallback);
    expect(hooks.tooManyRequests).not.toHaveBeenCalled();
    expect(hooks.rateLimited).toHaveBeenCalledWith({
      message: error.message,
      data: {
        status: 429,
        path: "/limited",
        method: "POST",
        retryAfterMs: undefined,
        requestId: undefined,
      },
    });
  });

  it("maps client timeout-style responses to TOO_MANY_REQUESTS", () => {
    const { errors, hooks } = makeErrors();
    const error = new DiscourseApiError({
      status: 408,
      path: "/timeout",
      method: "GET",
      retryAfterMs: 500,
    });

    const result = mapDiscourseApiError(error, errors);

    expect(result).toBeDefined();
    expect(hooks.tooManyRequests).toHaveBeenCalledWith({
      message: error.message,
      data: {
        status: 408,
        path: "/timeout",
        method: "GET",
        retryAfterMs: 500,
        requestId: undefined,
      },
    });
  });

  it("maps server errors to SERVICE_UNAVAILABLE", () => {
    const { errors, hooks } = makeErrors();
    const mapped = { mapped: true };
    hooks.serviceUnavailable.mockReturnValueOnce(mapped as any);

    const error = new DiscourseApiError({
      status: 500,
      path: "/server-error",
      method: "GET",
      requestId: "req-2",
    });

    const result = mapDiscourseApiError(error, errors);

    expect(result).toBe(mapped);
    expect(hooks.serviceUnavailable).toHaveBeenCalledWith({
      message: error.message,
      data: {
        status: 500,
        path: "/server-error",
        method: "GET",
        retryAfterMs: undefined,
        requestId: "req-2",
      },
    });
    expect(hooks.tooManyRequests).not.toHaveBeenCalled();
  });

  it("falls back to the original error when handlers return undefined", () => {
    const handlers = {
      UNAUTHORIZED: vi.fn(() => undefined),
    };
    const error = new DiscourseApiError({
      status: 401,
      path: "/path",
      method: "GET",
    });

    const result = mapDiscourseApiError(error, handlers);

    expect(result).toBe(error);
    expect(handlers.UNAUTHORIZED).toHaveBeenCalledWith({
      message: error.message,
      data: {
        status: 401,
        path: "/path",
        method: "GET",
        retryAfterMs: undefined,
        requestId: undefined,
      },
    });
  });

  it("returns original error when mapping is unavailable", () => {
    const { errors } = makeErrors();
    const plain = new Error("plain");
    expect(mapDiscourseApiError(plain, errors)).toBe(plain);

    const apiError = new DiscourseApiError({
      status: 404,
      path: "/missing",
      method: "GET",
    });
    expect(
      mapDiscourseApiError(apiError, {
        ...errors,
        TOO_MANY_REQUESTS: undefined,
        RATE_LIMITED: undefined,
      })
    ).toBe(apiError);
  });

  it("returns DiscourseApiError unchanged for unmapped status codes", () => {
    const passthroughErrors = {
      UNAUTHORIZED: vi.fn(),
      FORBIDDEN: vi.fn(),
      NOT_FOUND: vi.fn(),
      BAD_REQUEST: vi.fn(),
      TOO_MANY_REQUESTS: vi.fn(),
      SERVICE_UNAVAILABLE: vi.fn(),
    };

    const apiError = new DiscourseApiError({
      status: 418,
      path: "/teapot",
      method: "BREW",
    });

    expect(mapDiscourseApiError(apiError, passthroughErrors)).toBe(apiError);
  });
});

describe("mapPluginError", () => {
  it("maps NonceCapacityError to TOO_MANY_REQUESTS with retry metadata", () => {
    const { errors, hooks } = makeErrors();
    const mapped = { mapped: true };
    hooks.tooManyRequests.mockReturnValueOnce(mapped);

    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    const nonceManager = new NonceManager({ ttlMs: 1000, maxPerClient: 1 });
    nonceManager.create("client-1", "key");

    dateSpy.mockReturnValue(200);
    const error = new NonceCapacityError({
      limitType: "client",
      limit: 1,
      clientId: "client-1",
    });

    const result = mapPluginError(error, { errors, nonceManager });

    expect(result).toBe(mapped);
    expect(hooks.tooManyRequests).toHaveBeenCalledWith({
      message: error.message,
      data: {
        limitType: "client",
        limit: 1,
        clientId: "client-1",
        retryAfterMs: 800,
      },
    });

    dateSpy.mockRestore();
  });

  it("falls back to the original error when capacity handler returns undefined", () => {
    const { errors } = makeErrors();
    errors.TOO_MANY_REQUESTS = vi.fn(() => undefined);

    const error = new NonceCapacityError({
      limitType: "global",
      limit: 1,
    });

    const result = mapPluginError(error, { errors });

    expect(result).toBe(error);
    expect(errors.TOO_MANY_REQUESTS).toHaveBeenCalledWith({
      message: error.message,
      data: {
        limitType: "global",
        limit: 1,
        clientId: undefined,
        retryAfterMs: undefined,
      },
    });
  });

  it("falls back to default retry metadata when limits are hit without active nonces", () => {
    const errors = {
      TOO_MANY_REQUESTS: vi.fn((payload) => payload),
    };
    const nonceManager: any = {
      getRetryAfterMs: vi
        .fn<() => number | null>()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null),
    };

    const error = new NonceCapacityError({
      limitType: "client",
      limit: 2,
      clientId: "client-x",
    });

    const result = mapPluginError(error, {
      errors,
      nonceManager,
      fallbackRetryAfterMs: 2500,
    });

    expect(result).toEqual({
      message: error.message,
      data: {
        limitType: "client",
        limit: 2,
        clientId: "client-x",
        retryAfterMs: 2500,
      },
    });
    expect(errors.TOO_MANY_REQUESTS).toHaveBeenCalledTimes(1);
    expect((nonceManager as any).getRetryAfterMs).toHaveBeenCalledTimes(2);
  });

  it("delegates to Discourse mapping for non-capacity errors", () => {
    const { errors, hooks } = makeErrors();
    const mapped = { mapped: true };
    hooks.serviceUnavailable.mockReturnValueOnce(mapped);
    const apiError = new DiscourseApiError({
      status: 500,
      path: "/server-error",
      method: "GET",
    });

    const result = mapPluginError(apiError, { errors });

    expect(result).toBe(mapped);
    expect(hooks.serviceUnavailable).toHaveBeenCalledTimes(1);
  });

  it("returns original error when mapping hooks are absent", () => {
    const error = new Error("plain");
    expect(mapPluginError(error, { errors: undefined })).toBe(error);
  });
});

describe("createDiscourseDeps", () => {
  it("increments eviction metrics and logs warnings when eviction occurs", () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const config = {
      variables: {
        discourseBaseUrl: "https://discuss.example.com",
        discourseApiUsername: "system",
        clientId: "client-id",
        requestTimeoutMs: 1000,
        nonceTtlMs: 1000,
        nonceCleanupIntervalMs: 1000,
        nonceMaxPerClient: undefined,
        nonceMaxTotal: 1,
        nonceLimitStrategy: { global: "evictOldest" },
        userApiScopes: ["read"],
        logBodySnippetLength: 50,
      },
      secrets: { discourseApiKey: "key" },
    };

    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const { nonceManager } = createDiscourseDeps(
      config as any,
      logger as any,
      metrics
    );

    nonceManager.create("client-a", "pk1");
    nonceManager.create("client-b", "pk2");

    expect(metrics.nonceEvictions).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Nonce eviction occurred",
      expect.objectContaining({
        action: "nonce-eviction",
        count: 1,
        type: "global",
      })
    );
  });

  it("disables retries for write operations by default", () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const config = {
      variables: {
        discourseBaseUrl: "https://discuss.example.com",
        discourseApiUsername: "system",
        clientId: "client-id",
        requestTimeoutMs: 1000,
        nonceTtlMs: 1000,
        nonceCleanupIntervalMs: 1000,
        userApiScopes: ["read"],
        logBodySnippetLength: 50,
      },
      secrets: { discourseApiKey: "key" },
    };

    const metrics = { retryAttempts: 0, nonceEvictions: 0 };
    const { discourseService } = createDiscourseDeps(
      config as any,
      logger as any,
      metrics
    );

    const writePolicy = (discourseService as any).resolveRetryPolicy("POST");
    const readPolicy = (discourseService as any).resolveRetryPolicy("GET");

    expect(writePolicy.maxRetries).toBe(0);
    expect(readPolicy.maxRetries).toBe(1);
  });
});

describe(
  "DiscourseService",
  withFetch((fetchMock) => {
    const service = new DiscourseService(
      "https://discuss.example.com",
      "test-api-key",
      "system",
      noopLogger,
      { userApiClientId: "test-client" }
    );
    const callFetch = (path = "/path", options?: any) =>
      (service as any).fetchApi(path, options);

    describe("generateAuthUrl", () => {
      it("should generate valid auth URL", async () => {
        const result = await run(
          service.generateAuthUrl({
            clientId: "test-client",
            applicationName: "Test App",
            nonce: "test-nonce",
            publicKey:
              "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            scopes: "read,write",
          })
        );

        expect(result).toContain(
          "https://discuss.example.com/user-api-key/new"
        );
        expect(result).toContain("client_id=test-client");
        expect(result).toContain("application_name=Test%20App");
        expect(result).toContain("nonce=test-nonce");
        expect(result).toContain("scopes=read%2Cwrite");
      });

      it("uses provided scopes string", async () => {
        const result = await run(
          service.generateAuthUrl({
            clientId: "test-client",
            applicationName: "Test App",
            nonce: "test-nonce",
            publicKey:
              "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            scopes: "read,message",
          })
        );

        expect(result).toContain("scopes=read%2Cmessage");
      });

      it("falls back to default scopes when input is blank", async () => {
        const result = await run(
          service.generateAuthUrl({
            clientId: "test-client",
            applicationName: "Test App",
            nonce: "test-nonce",
            publicKey:
              "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            scopes: "   ",
          })
        );

        expect(result).toContain("scopes=read%2Cwrite");
      });

      it("should include nested base paths without double slashes", async () => {
        const serviceWithPath = new DiscourseService(
          "https://discuss.example.com/community/",
          "test-api-key",
          "system"
        );

        const result = await run(
          serviceWithPath.generateAuthUrl({
            clientId: "test-client",
            applicationName: "Community App",
            nonce: "test-nonce",
            publicKey:
              "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
            scopes: "read,write",
          })
        );

        expect(result).toContain(
          "https://discuss.example.com/community/user-api-key/new"
        );
      });

      it("should reject invalid base URLs early", () => {
        expect(() => new DiscourseService("not-a-url", "k", "user")).toThrow(
          "Invalid Discourse base URL"
        );
      });
    });

    describe("checkHealth", () => {
      it("uses bounded default timeout when provided value is invalid", async () => {
        const fetchApiSpy = vi
          .spyOn(service as any, "fetchApi")
          .mockResolvedValue(undefined);

        const result = await run(service.checkHealth({ timeoutMs: -10 }));

        expect(result).toBe(true);
        expect(fetchApiSpy).toHaveBeenCalledWith("/site/status", {
          method: "HEAD",
          accept: null,
          timeoutMs: 2000,
        });

        fetchApiSpy.mockRestore();
      });

      it("falls back to GET when HEAD health probe fails", async () => {
        const fetchApiSpy = vi
          .spyOn(service as any, "fetchApi")
          .mockRejectedValueOnce(new Error("head not allowed"))
          .mockResolvedValueOnce(undefined);

        const result = await run(service.checkHealth({ timeoutMs: 1000 }));

        expect(result).toBe(true);
        expect(fetchApiSpy).toHaveBeenNthCalledWith(1, "/site/status", {
          method: "HEAD",
          accept: null,
          timeoutMs: 1000,
        });
        expect(fetchApiSpy).toHaveBeenNthCalledWith(2, "/site/status", {
          method: "GET",
          accept: null,
          timeoutMs: 1000,
        });

        fetchApiSpy.mockRestore();
      });

      it("logs a warning and returns false when all probes fail", async () => {
        const fetchApiSpy = vi
          .spyOn(service as any, "fetchApi")
          .mockRejectedValue(new Error("boom"));
        const warn = vi.fn();
        const debug = vi.fn();
        const originalLogger = (service as any).logger;
        (service as any).logger = { ...originalLogger, warn, debug };

        const result = await run(service.checkHealth({ timeoutMs: 500 }));

        expect(result).toBe(false);
        expect(fetchApiSpy).toHaveBeenCalledTimes(3);
        expect(warn).toHaveBeenCalledWith("All health probes failed", {
          action: "health-check",
          timeoutMs: 500,
        });
        expect(debug).toHaveBeenCalledTimes(3);

        fetchApiSpy.mockRestore();
        (service as any).logger = originalLogger;
      });
    });

    describe("getCurrentUser", () => {
      it("should return current user when request succeeds", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              current_user: validUserPayload(),
            }),
          })
        );

        const result = await run(service.getCurrentUser("user-key"));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/session/current.json",
          expect.objectContaining({
            method: "GET",
            headers: expect.objectContaining({
              "User-Api-Key": "user-key",
              "User-Api-Client-Id": "test-client",
            }),
          })
        );
        expect(result).toEqual({
          id: 1,
          username: "alice",
          name: "Alice",
        });
      });

      it("should throw when request fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "server error" })
        );

        await expectDiscourseApiError(
          () => run(service.getCurrentUser("bad-key")),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/session/current.json",
            bodyIncludes: "server error",
            contextIncludes: "Get user failed",
          }
        );
      });

      it("should throw on empty user response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(run(service.getCurrentUser("any"))).rejects.toThrow(
          "Get user failed: Empty or invalid user response"
        );
      });

      it("should throw on malformed user response", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ current_user: { username: "no-id" } }),
          })
        );

        await expect(run(service.getCurrentUser("any"))).rejects.toThrow(
          "Get user failed: Malformed user response"
        );
      });

      it("should default missing optional fields when current user is sparse", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              current_user: { id: 2, username: "sparse" },
            }),
          })
        );

        const result = await run(service.getCurrentUser("key"));
        expect(result).toEqual({ id: 2, username: "sparse", name: null });
      });
    });

    describe("fetchApi", () => {
      it("sends user API key and parses json", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) => {
                if (key === "content-length") return "100";
                if (key === "content-type") return "application/json";
                return null;
              },
            },
            text: async () => '{"ok":true}',
          })
        );

        const result = await callFetch("/path", { userApiKey: "user-key" });

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/path",
          expect.objectContaining({
            headers: expect.objectContaining({
              Accept: "application/json",
              "User-Api-Key": "user-key",
              "User-Api-Client-Id": "test-client",
            }),
          })
        );
        expect(result).toEqual({ ok: true });
      });

      it("sets a custom user agent and honors default timeout override", async () => {
        const serviceWithAgent = new DiscourseService(
          "https://discuss.example.com",
          "test-api-key",
          "system",
          noopLogger,
          { userAgent: "custom-agent", defaultTimeoutMs: 1500 }
        ) as any;

        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/json" : null,
            },
            text: async () => '{"ok":true}',
          })
        );

        const result = await serviceWithAgent.fetchApi("/path");

        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1500);
        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/path",
          expect.objectContaining({
            headers: expect.objectContaining({
              Accept: "application/json",
              "User-Agent": "custom-agent",
            }),
          })
        );
        expect(result).toEqual({ ok: true });
        timeoutSpy.mockRestore();
      });

      it("trims trailing slashes from base URL to avoid double slashes", async () => {
        const slashService = new DiscourseService(
          "https://discuss.example.com/",
          "test-api-key",
          "system"
        ) as any;

        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await slashService.fetchApi("/path");

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/path",
          expect.any(Object)
        );
      });

      it("omits Content-Type when no body is provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("/no-body");

        const [, options] = fetchMock.mock.calls[0];
        expect((options as any)?.headers).not.toHaveProperty("Content-Type");
        expect((options as any)?.headers).not.toHaveProperty("content-type");
      });

      it("allows overriding Accept header when requested", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("/custom-accept", { accept: "text/plain" });

        const [, options] = fetchMock.mock.calls[0];
        expect((options as any)?.headers?.Accept).toBe("text/plain");
      });

      it("honors existing headers regardless of casing to avoid duplicates", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("/custom-headers", {
          method: "POST",
          body: { value: 1 },
          userApiKey: "user-key",
          headers: {
            ACCEPT: "text/custom",
            "USER-API-KEY": "from-header",
            "content-type": "application/custom",
          },
        });

        const [, options] = fetchMock.mock.calls[0];
        const sentHeaders = (options as any)?.headers ?? {};

        expect(
          Object.keys(sentHeaders).filter(
            (key) => key.toLowerCase() === "accept"
          )
        ).toHaveLength(1);
        expect(sentHeaders.ACCEPT).toBe("text/custom");
        expect(sentHeaders["USER-API-KEY"]).toBe("from-header");
        expect(sentHeaders["User-Api-Client-Id"]).toBe("test-client");
        expect(
          Object.keys(sentHeaders).some(
            (key) => key.toLowerCase() === "api-key"
          )
        ).toBe(false);
        expect(
          Object.keys(sentHeaders).filter(
            (key) => key.toLowerCase() === "content-type"
          )
        ).toHaveLength(1);
        expect(sentHeaders["content-type"] ?? sentHeaders["Content-Type"]).toBe(
          "application/custom"
        );
      });

      it("adds a client id when the user API key is provided via headers", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("/header-user-key", {
          headers: {
            "User-Api-Key": "header-key",
          },
        });

        const [, options] = fetchMock.mock.calls[0];
        const sentHeaders = (options as any)?.headers ?? {};

        expect(sentHeaders["User-Api-Key"]).toBe("header-key");
        expect(sentHeaders["User-Api-Client-Id"]).toBe("test-client");
        expect(
          Object.keys(sentHeaders).some(
            (key) => key.toLowerCase() === "api-key"
          )
        ).toBe(false);
      });

      it("does not override provided user API client id headers", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("/existing-client-id", {
          userApiKey: "user-key",
          headers: {
            "user-api-client-id": "from-request",
          },
        });

        const [, options] = fetchMock.mock.calls[0];
        const sentHeaders = (options as any)?.headers ?? {};
        const clientIdHeaders = Object.entries(sentHeaders).filter(
          ([key]) => key.toLowerCase() === "user-api-client-id"
        );

        expect(clientIdHeaders).toHaveLength(1);
        expect(clientIdHeaders[0]?.[1]).toBe("from-request");
      });

      it("strips undefined header values before sending", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("/header-pruning", {
          headers: {
            "X-Null": null as any,
            "X-Undefined": undefined as any,
            "X-Number": 123 as any,
          },
        });

        const [, options] = fetchMock.mock.calls[0];
        const sentHeaders = (options as any)?.headers ?? {};

        expect(sentHeaders).not.toHaveProperty("X-Null");
        expect(sentHeaders).not.toHaveProperty("X-Undefined");
        expect(sentHeaders["X-Number"]).toBe("123");
      });

      it("omits Accept header when explicitly set to null", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("/no-accept", { accept: null });

        const [, options] = fetchMock.mock.calls[0];
        expect((options as any)?.headers).not.toHaveProperty("Accept");
        expect((options as any)?.headers).not.toHaveProperty("accept");
      });

      it("passes through non-JSON bodies without stringifying or forcing content type", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        const form = new FormData();
        form.append("file", new Blob(["data"], { type: "text/plain" }));

        await callFetch("/upload", { method: "POST", body: form });

        const [, options] = fetchMock.mock.calls[0];
        expect((options as any)?.body).toBe(form);
        expect((options as any)?.headers).not.toHaveProperty("Content-Type");
        expect((options as any)?.headers).not.toHaveProperty("content-type");
      });

      it("uses a custom body serializer when provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        const serializer = vi.fn().mockReturnValue("serialized");

        await callFetch("/custom-serializer", {
          method: "POST",
          body: { value: 1 },
          bodySerializer: serializer,
          headers: { "Content-Type": "text/plain" },
        });

        const [, options] = fetchMock.mock.calls[0];
        expect(serializer).toHaveBeenCalledWith({ value: 1 });
        expect((options as any)?.body).toBe("serialized");
      });

      it("adds missing leading slash to paths", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("path-without-slash");

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/path-without-slash",
          expect.any(Object)
        );
      });

      it("allows absolute URLs to pass through untouched", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => "0" },
            text: async () => "",
          })
        );

        await callFetch("https://other.host/custom");

        expect(fetchMock).toHaveBeenCalledWith(
          "https://other.host/custom",
          expect.any(Object)
        );
      });

      it("returns undefined on empty response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        const result = await callFetch();
        expect(result).toBeUndefined();
      });

      it("uses default timeout when an invalid value is provided", async () => {
        const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/json" : null,
            },
            text: async () => '{"ok":true}',
          })
        );

        const result = await callFetch("/path", { timeoutMs: 0 });

        expect(result).toEqual({ ok: true });
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
        timeoutSpy.mockRestore();
      });

      it("disables read timeout when non-positive value is provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/json" : null,
            },
            text: async () => '{"ok":true}',
          })
        );

        const result = await callFetch("/path", { readTimeoutMs: 0 });

        expect(result).toEqual({ ok: true });
      });

      it("returns raw body when not json", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ headers: undefined, text: async () => '{"data":42}' })
        );

        const result = await callFetch();
        expect(result).toBe('{"data":42}');
      });

      it("times out when reading response body is too slow", async () => {
        const delayedText = vi.fn(
          () => new Promise((resolve) => setTimeout(() => resolve("slow"), 50))
        );
        const localFetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: delayedText,
        });

        const slowService = new DiscourseService(
          "https://discuss.example.com",
          "test-api-key",
          "system",
          noopLogger,
          { userApiClientId: "test-client", fetchImpl: localFetch as any }
        );

        await expect(
          (slowService as any).fetchApi("/slow", { readTimeoutMs: 10 })
        ).rejects.toThrow(/timed out/i);
      });

      it("parses structured application/*+json responses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/problem+json" : null,
            },
            text: async () => '{"problem":"details"}',
          })
        );

        const result = await callFetch();
        expect(result).toEqual({ problem: "details" });
      });

      it("surfaces response body read errors", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/json" : null,
            },
            text: async () => {
              throw new Error("boom reading body");
            },
          })
        );

        await expect(callFetch()).rejects.toThrow(
          "Failed to read response body: boom reading body"
        );
      });

      it("returns undefined when text is only whitespace", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/json" : null,
            },
            text: async () => "   \n  ",
          })
        );

        const result = await callFetch();
        expect(result).toBeUndefined();
      });

      it("clears the timeout after completing the request", async () => {
        const clearSpy = vi.spyOn(global, "clearTimeout");
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/json" : null,
            },
            text: async () => '{"ok":true}',
          })
        );

        const result = await callFetch("/path", { timeoutMs: 15 });

        expect(result).toEqual({ ok: true });
        expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        clearSpy.mockRestore();
      });

      it("clears the timeout when fetch rejects", async () => {
        const clearSpy = vi.spyOn(global, "clearTimeout");
        fetchMock.mockRejectedValueOnce(new Error("network kaboom"));

        await expect(callFetch("/rejects")).rejects.toThrow("network kaboom");
        expect(clearSpy).toHaveBeenCalledTimes(1);
        clearSpy.mockRestore();
      });

      it("surfaces JSON parse errors with snippet", async () => {
        const longBody = "x".repeat(250);
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) => {
                if (key === "content-length") return "250";
                if (key === "content-type") return "application/json";
                return null;
              },
            },
            text: async () => longBody,
          })
        );

        await expect(callFetch("/long-json")).rejects.toThrow(
          /Failed to parse JSON from https:\/\/discuss\.example\.com\/long-json: .*body snippet: x{200}…/
        );
      });

      it("surfaces JSON parse errors with short bodies without truncation", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) => (key ? "application/json" : null),
            },
            text: async () => "{oops",
          })
        );

        await expect(callFetch("/short-json")).rejects.toThrow(
          /Failed to parse JSON from https:\/\/discuss\.example\.com\/short-json: .*body snippet: {oops$/
        );
      });

      it("truncates very long bodies when JSON parse fails", async () => {
        const veryLong = "y".repeat(1500);
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/json" : null,
            },
            text: async () => veryLong,
          })
        );

        await expect(callFetch("/huge-json")).rejects.toThrow(
          /Failed to parse JSON from https:\/\/discuss\.example\.com\/huge-json: .*body snippet: y{200}…/
        );
      });

      it("falls back to response.json when text is unavailable", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => null },
            text: undefined,
            json: async () => ({ ok: true, via: "json" }),
          })
        );

        const result = await callFetch("/json-only");
        expect(result).toEqual({ ok: true, via: "json" });
      });

      it("returns undefined when json() resolves to null", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: () => null },
            text: undefined,
            json: async () => null as any,
          })
        );

        const result = await callFetch("/json-null");
        expect(result).toBeUndefined();
      });

      it("times out and aborts long requests", async () => {
        fetchMock.mockRejectedValueOnce(
          Object.assign(new Error("Aborted"), { name: "AbortError" })
        );

        await expect(callFetch("/path", { timeoutMs: 5 })).rejects.toThrow(
          "Request to https://discuss.example.com/path timed out after 5ms"
        );
      });

      it("ignores logger errors when response not ok", async () => {
        const noisyLogger = {
          error: () => {
            throw new Error("logger boom");
          },
        } as any;
        const noisyService = new DiscourseService(
          "https://discuss.example.com",
          "key",
          "system",
          noisyLogger
        ) as any;

        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 500,
            text: async () => "err",
          })
        );

        await expectDiscourseApiError(() => noisyService.fetchApi("/fail"), {
          status: 500,
          method: "GET",
          pathIncludes: "/fail",
          bodyIncludes: "err",
        });
      });

      it("still surfaces status when response body cannot be read", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 503,
            text: async () => {
              throw new Error("unreadable");
            },
          })
        );

        await expectDiscourseApiError(() => callFetch("/unreadable"), {
          status: 503,
          method: "GET",
          pathIncludes: "/unreadable",
          bodyIncludes: "[body unavailable: unreadable]",
        });
      });

      it("omits body snippet when error text is blank", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 502,
            text: async () => "   \n  ",
          })
        );

        const error = await expectDiscourseApiError(
          () => callFetch("/empty-body"),
          {
            status: 502,
            method: "GET",
            pathIncludes: "/empty-body",
          }
        );

        expect(error?.bodySnippet).toBe("");
        expect(error?.message).toBe(
          "Discourse API error (GET 502): https://discuss.example.com/empty-body"
        );
      });

      it("captures numeric Retry-After headers on errors", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 429,
            headers: {
              get: (key: string) =>
                key.toLowerCase() === "retry-after" ? "120" : null,
            },
            text: async () => "  rate   limited ",
          })
        );

        const error = await expectDiscourseApiError(
          () => callFetch("/rate-limit"),
          {
            status: 429,
            method: "GET",
            pathIncludes: "/rate-limit",
            bodyIncludes: "rate limited",
          }
        );

        expect(error?.retryAfterMs).toBe(120000);
      });

      it("converts date Retry-After headers to delays", async () => {
        const nowSpy = vi
          .spyOn(Date, "now")
          .mockReturnValue(new Date("2024-01-01T00:00:00Z").getTime());

        try {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              ok: false,
              status: 503,
              headers: {
                get: (key: string) =>
                  key.toLowerCase() === "retry-after"
                    ? "Tue, 01 Jan 2024 00:01:00 GMT"
                    : null,
              },
              text: async () => "maintenance window",
            })
          );

          const error = await expectDiscourseApiError(
            () => callFetch("/maintenance"),
            {
              status: 503,
              method: "GET",
              pathIncludes: "/maintenance",
              bodyIncludes: "maintenance window",
            }
          );

          expect(error?.retryAfterMs).toBe(60000);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it("omits retryAfterMs when retry-after header is blank", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 503,
            headers: {
              get: (key: string) =>
                key.toLowerCase() === "retry-after" ? "   " : null,
            },
            text: async () => "slowdown",
          })
        );

        const error = await expectDiscourseApiError(
          () => callFetch("/blank-retry"),
          {
            status: 503,
            method: "GET",
            pathIncludes: "/blank-retry",
            bodyIncludes: "slowdown",
          }
        );

        expect(error?.retryAfterMs).toBeUndefined();
      });

      it("ignores invalid retry-after header formats", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 400,
            headers: {
              get: (key: string) =>
                key.toLowerCase() === "retry-after" ? "not-a-date" : null,
            },
            text: async () => "bad retry header",
          })
        );

        const error = await expectDiscourseApiError(
          () => callFetch("/invalid-retry"),
          {
            status: 400,
            method: "GET",
            pathIncludes: "/invalid-retry",
            bodyIncludes: "bad retry header",
          }
        );

        expect(error?.retryAfterMs).toBeUndefined();
      });

      it("captures x-request-id on error responses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 500,
            headers: {
              get: (key: string) =>
                key.toLowerCase() === "x-request-id" ? "abc-123" : null,
            },
            text: async () => "server boom",
          })
        );

        const error = await expectDiscourseApiError(
          () => callFetch("/with-request-id"),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/with-request-id",
            bodyIncludes: "server boom",
          }
        );

        expect(error?.requestId).toBe("abc-123");
        expect(error?.message).toContain(
          "https://discuss.example.com/with-request-id"
        );
      });

      it("handles missing header getters on error responses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 502,
            headers: {} as any,
            text: async () => "no headers",
          })
        );

        const error = await expectDiscourseApiError(
          () => callFetch("/no-headers"),
          {
            status: 502,
            method: "GET",
            pathIncludes: "/no-headers",
            bodyIncludes: "no headers",
          }
        );

        expect(error?.requestId).toBeUndefined();
        expect(error?.retryAfterMs).toBeUndefined();
      });

      it("prefers a provided fetch implementation over global fetch", async () => {
        const customFetch = vi.fn().mockResolvedValue(
          makeRes({
            headers: {
              get: (key: string) => (key === "content-length" ? "0" : null),
            },
            text: async () => "",
          })
        );
        const customService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          { fetchImpl: customFetch }
        ) as any;

        const result = await customService.fetchApi("/custom-fetch");

        expect(result).toBeUndefined();
        expect(customFetch).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("invokes a request logger hook with structured payloads", async () => {
        const requestLogger = vi.fn();
        const loggingService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          { requestLogger }
        ) as any;

        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) => (key === "content-length" ? "0" : null),
            },
            text: async () => "",
          })
        );

        await loggingService.fetchApi("/log-hook");

        expect(requestLogger).toHaveBeenCalledWith(
          expect.objectContaining({
            path: "https://discuss.example.com/log-hook",
            method: "GET",
            outcome: "success",
          })
        );
      });

      it("ignores failures from request logger hooks", async () => {
        const loggingService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          {
            requestLogger: () => {
              throw new Error("hook boom");
            },
          }
        ) as any;

        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) => (key === "content-length" ? "0" : null),
            },
            text: async () => "",
          })
        );

        await expect(
          loggingService.fetchApi("/log-hook-fail")
        ).resolves.toBeUndefined();
      });

      it("uses configured body snippet length when logging errors", async () => {
        const shortService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          { bodySnippetLength: 5 }
        ) as any;

        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 500,
            text: async () => "long-body-text",
          })
        );

        const error = await expectDiscourseApiError(
          () => shortService.fetchApi("/short-snippet"),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/short-snippet",
            bodyIncludes: "long-",
          }
        );

        expect(error?.bodySnippet?.startsWith("long-")).toBe(true);
        expect(error?.bodySnippet?.length).toBeLessThanOrEqual(6);
      });

      it("returns undefined when neither text nor json exist", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ headers: undefined, text: undefined, json: undefined })
        );

        const result = await callFetch();
        expect(result).toBeUndefined();
      });
    });

    describe("retry helpers", () => {
      it("falls back to jittered backoff when retry-after is absent", () => {
        const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.75);

        const delay = (service as any).computeDelayMs(
          new Error("no-retry-after"),
          2
        );

        expect(delay).toBe(1100);
        randomSpy.mockRestore();
      });

      it("caps retry-after delays when retry metadata is extreme", () => {
        const retryService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          { retryPolicy: { maxRetries: 1, maxDelayMs: 500, jitterRatio: 0 } }
        ) as any;
        const error = new DiscourseApiError({
          status: 503,
          path: "/retry-long",
          method: "GET",
          retryAfterMs: 10_000,
        });

        const delay = retryService.computeDelayMs(error, 0);

        expect(delay).toBe(500);
      });

      it("normalizes retry policy overrides to safe defaults", () => {
        const policyService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          {
            retryPolicy: {
              maxRetries: -1,
              baseDelayMs: Number.NaN,
              maxDelayMs: -5,
              jitterRatio: -0.5,
            },
          }
        ) as any;

        expect(policyService.retryPolicy).toEqual({
          maxRetries: 0,
          baseDelayMs: 250,
          maxDelayMs: 5000,
          jitterRatio: 0.2,
        });
      });

      it("relies on the transport retry loop and request logging", async () => {
        vi.useFakeTimers();

        try {
          const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
              makeRes({
                ok: false,
                status: 503,
                headers: {
                  get: (key: string) => {
                    if (key === "retry-after") return "1";
                    if (key === "content-length") return null;
                    return null;
                  },
                },
                text: async () => "temporary",
              })
            )
            .mockResolvedValueOnce(makeRes());
          const requestLogger = vi.fn();
          const retryService = new DiscourseService(
            "https://discuss.example.com",
            "api-key",
            "system",
            noopLogger,
            {
              retryPolicy: {
                maxRetries: 1,
                baseDelayMs: 1000,
                maxDelayMs: 2000,
                jitterRatio: 0,
              },
              requestLogger,
              fetchImpl: fetchImpl as any,
            }
          );

          const resultPromise = retryService.fetchApi("/retry", {
            method: "GET",
          });

          await runAllTimersAwaitable();
          const result = await resultPromise;

          expect(result).toEqual({});
          expect(fetchImpl).toHaveBeenCalledTimes(2);
          expect(requestLogger).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: "retry",
              retryDelayMs: 1000,
              attempt: 1,
            })
          );
          expect(requestLogger).toHaveBeenCalledWith(
            expect.objectContaining({
              outcome: "success",
              attempt: 2,
            })
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it("uses operation defaults when per-request overrides are absent", () => {
        const retryService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          { retryPolicy: { maxRetries: 1, baseDelayMs: 10 } }
        ) as any;

        const resolved = retryService.resolveRetryPolicy("GET");

        expect(resolved.maxRetries).toBe(1);
        expect(resolved.baseDelayMs).toBe(10);
      });

      it("merges per-request retry policy overrides", () => {
        const retryService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          { retryPolicy: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 1000 } }
        ) as any;

        const merged = retryService.resolveRetryPolicy("POST", {
          maxRetries: 2,
          baseDelayMs: 50,
        });

        expect(merged.maxRetries).toBe(2);
        expect(merged.baseDelayMs).toBe(50);
        expect(merged.maxDelayMs).toBe(1000);
      });

      it("uses operation-specific retry policies for reads and writes", () => {
        const retryService = new DiscourseService(
          "https://discuss.example.com",
          "api-key",
          "system",
          noopLogger,
          {
            retryPolicy: { maxRetries: 0 },
            operationRetryPolicy: {
              reads: { maxRetries: 0 },
              writes: { maxRetries: 1 },
            },
          }
        ) as any;

        const readPolicy = retryService.resolveRetryPolicy("GET");
        const writePolicy = retryService.resolveRetryPolicy("POST");

        expect(readPolicy.maxRetries).toBe(0);
        expect(writePolicy.maxRetries).toBe(1);
      });
    });

    describe("url helpers", () => {
      it("normalizes trailing base slashes and resolves paths", () => {
        const slashService = new DiscourseService(
          "https://discuss.example.com/",
          "api-key",
          "system"
        );

        expect(slashService.getNormalizedBaseUrl()).toBe(
          "https://discuss.example.com"
        );
        expect(slashService.resolvePath("/t/topic/1")).toBe(
          "https://discuss.example.com/t/topic/1"
        );
        expect(slashService.resolvePath("https://other.host/path")).toBe(
          "https://other.host/path"
        );
      });
    });

    describe("uploads", () => {
      it("builds upload requests with default upload type when omitted", () => {
        const request = service.buildUploadRequest({
          username: "alice",
        });

        expect(request.fields).toEqual({ type: "composer" });
      });

      it("builds standard upload requests with auth headers", () => {
        const request = service.buildUploadRequest({
          uploadType: "composer",
          username: "alice",
        });

        expect(request.method).toBe("POST");
        expect(request.url).toBe("https://discuss.example.com/uploads.json");
        expect(request.fields).toEqual({ type: "composer" });
        expect(request.headers).toEqual(
          expect.objectContaining({
            Accept: "application/json",
            "Api-Key": "test-api-key",
            "Api-Username": "alice",
          })
        );
      });

      it("prefers user API credentials and client id when provided", () => {
        const payload = uploadPayload({
          username: "bob",
          userApiKey: "user-key",
        });
        const request = service.buildUploadRequest({
          uploadType: payload.uploadType,
          username: payload.username,
          userApiKey: payload.userApiKey,
        });

        expect(request.headers).toEqual(
          expect.objectContaining({
            "User-Api-Key": payload.userApiKey,
            "User-Api-Client-Id": "test-client",
          })
        );
        expect(request.headers).not.toHaveProperty("Api-Key");
      });

      it("presigns uploads with defaulted payload helpers", async () => {
        const payload = uploadPayload({ uploadType: undefined });

        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              key: payload.key,
              upload_url: "https://uploads.example.com/key",
              headers: {},
              unique_identifier: payload.uniqueIdentifier,
            }),
          })
        );

        await run(
          service.presignUpload({
            filename: payload.filename,
            byteSize: payload.byteSize,
            contentType: payload.contentType,
            uploadType: payload.uploadType,
            userApiKey: payload.userApiKey,
          })
        );

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse((options as any).body);

        expect(body).toEqual({
          filename: payload.filename,
          file_name: payload.filename,
          filesize: payload.byteSize,
          file_size: payload.byteSize,
          content_type: payload.contentType,
          upload_type: "composer",
        });
        expect((options as any)?.headers).toEqual(
          expect.objectContaining({
            Accept: "application/json",
            "Content-Type": "application/json",
            "User-Api-Key": payload.userApiKey,
            "User-Api-Client-Id": "test-client",
          })
        );
      });

      it("builds multipart presign requests from upload fixtures", async () => {
        const payload = uploadPayload();

        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              upload_id: payload.uploadId,
              key: payload.key,
              unique_identifier: payload.uniqueIdentifier,
              presigned_urls: [
                {
                  part_number: 1,
                  url: "https://upload/part1",
                  headers: { A: "b" },
                },
              ],
            }),
          })
        );

        await run(
          service.batchPresignMultipartUpload({
            uniqueIdentifier: payload.uniqueIdentifier,
            partNumbers: payload.parts.map((part) => part.partNumber),
            uploadId: payload.uploadId,
            key: payload.key,
            contentType: payload.contentType,
            userApiKey: payload.userApiKey,
          })
        );

        const [, options] = fetchMock.mock.calls[0];
        const body = JSON.parse((options as any).body);

        expect(body).toEqual(
          expect.objectContaining({
            unique_identifier: payload.uniqueIdentifier,
            upload_id: payload.uploadId,
            key: payload.key,
            part_numbers: [1],
            content_type: payload.contentType,
          })
        );
        expect((options as any)?.headers).toEqual(
          expect.objectContaining({
            "User-Api-Key": payload.userApiKey,
            "User-Api-Client-Id": "test-client",
          })
        );
      });

      it("maps presigned upload responses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              key: "uploads/key",
              upload_url: "https://uploads.example.com/key",
              headers: { Authorization: "signature" },
              unique_identifier: "abc",
            }),
          })
        );

        const result = await run(
          service.presignUpload({
            filename: "file.png",
            byteSize: 123,
            contentType: "image/png",
          })
        );

        const [, options] = fetchMock.mock.calls[0];
        expect((options as any)?.method).toBe("POST");
        expect(String((options as any)?.body)).toContain('"file_size":123');

        expect(result).toEqual({
          method: "PUT",
          uploadUrl: "https://uploads.example.com/key",
          headers: { Authorization: "signature" },
          key: "uploads/key",
          uniqueIdentifier: "abc",
        });
      });

      it("normalizes presign headers by dropping undefined values", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              key: "uploads/key",
              upload_url: "https://uploads.example.com/key",
              headers: { "X-Test": undefined, Retry: 5 },
              unique_identifier: "abc",
            }),
          })
        );

        const result = await run(
          service.presignUpload({
            filename: "file.png",
            byteSize: 123,
            contentType: "image/png",
          })
        );

        expect(result.headers).toEqual({ Retry: "5" });
      });

      it("normalizes empty header inputs to an empty object", () => {
        const normalized = (service as any).normalizeHeaderValues(
          undefined as any
        );

        expect(normalized).toEqual({});
      });

      it("supports legacy presign responses that only provide url", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              key: "uploads/key",
              url: "https://uploads.example.com/legacy",
              unique_identifier: "legacy-1",
              headers: { "X-Retry": 0 },
            }),
          })
        );

        const presign = await run(
          service.presignUpload({
            filename: "file.png",
            byteSize: 10,
          })
        );

        expect(presign.uploadUrl).toBe("https://uploads.example.com/legacy");
        expect(presign.headers).toEqual({ "X-Retry": "0" });
      });

      it("uses legacy presign fallback when upload_url is invalid and normalizes headers", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              key: "uploads/key",
              url: "https://uploads.example.com/fallback",
              upload_url: 123,
              headers: { "X-Test": 7, Skip: undefined },
              unique_identifier: "abc",
            }),
          })
        );

        const presign = await run(
          service.presignUpload({
            filename: "file.png",
            byteSize: 10,
          })
        );

        expect(presign.uploadUrl).toBe("https://uploads.example.com/fallback");
        expect(presign.headers).toEqual({ "X-Test": "7" });
      });

      it("presigns multipart uploads and retries completion", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              upload_id: "upload-1",
              key: "uploads/key",
              unique_identifier: "abc",
              presigned_urls: [
                {
                  part_number: 1,
                  url: "https://upload/part1",
                  headers: { A: "b" },
                },
              ],
            }),
          })
        );

        const presign = await run(
          service.batchPresignMultipartUpload({
            uniqueIdentifier: "abc",
            partNumbers: [1],
            uploadId: "upload-1",
            key: "uploads/key",
          })
        );

        expect(presign).toEqual({
          uploadId: "upload-1",
          key: "uploads/key",
          uniqueIdentifier: "abc",
          parts: [
            { partNumber: 1, url: "https://upload/part1", headers: { A: "b" } },
          ],
        });

        const retryingService = new DiscourseService(
          "https://discuss.example.com",
          "test-api-key",
          "system",
          noopLogger,
          {
            operationRetryPolicy: { writes: { maxRetries: 1, baseDelayMs: 0 } },
          }
        );

        fetchMock.mockResolvedValueOnce(
          makeRes({
            ok: false,
            status: 503,
            text: async () => "try later",
          })
        );
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              upload: {
                id: 99,
                url: "/uploads/default/99",
                short_url: "short",
                original_filename: "file.png",
              },
            }),
          })
        );

        const completion = await run(
          retryingService.completeMultipartUpload({
            uniqueIdentifier: "abc",
            uploadId: "upload-1",
            key: "uploads/key",
            parts: [{ partNumber: 1, etag: "etag-1" }],
            filename: "file.png",
          })
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(completion.upload).toEqual(
          expect.objectContaining({
            id: 99,
            url: "/uploads/default/99",
            shortUrl: "short",
            originalFilename: "file.png",
          })
        );
      });

      it("returns abort status when provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ success: true }),
          })
        );

        const aborted = await run(
          service.abortMultipartUpload({
            uniqueIdentifier: "abc",
            uploadId: "upload-1",
            key: "uploads/key",
          })
        );

        expect(aborted).toBe(true);
      });

      it("prefers aborted flag when abort response includes it", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ aborted: true, success: false }),
          })
        );

        const aborted = await run(
          service.abortMultipartUpload({
            uniqueIdentifier: "abc",
            uploadId: "upload-1",
            key: "uploads/key",
          })
        );

        expect(aborted).toBe(true);
      });

      it("returns false when abort response omits flags", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({}),
          })
        );

        const aborted = await run(
          service.abortMultipartUpload({
            uniqueIdentifier: "abc",
            uploadId: "upload-1",
            key: "uploads/key",
          })
        );

        expect(aborted).toBe(false);
      });

      it("returns false when abort response is empty", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => null,
          })
        );

        const aborted = await run(
          service.abortMultipartUpload({
            uniqueIdentifier: "abc",
            uploadId: "upload-1",
            key: "uploads/key",
          })
        );

        expect(aborted).toBe(false);
      });

      it("throws on malformed presign responses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({}),
          })
        );

        await expect(
          run(
            service.presignUpload({
              filename: "file.png",
              byteSize: 10,
            })
          )
        ).rejects.toThrow("Malformed presign response");
      });

      it("throws when presign response is empty", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => undefined,
          })
        );

        await expect(
          run(
            service.presignUpload({
              filename: "file.png",
              byteSize: 10,
            })
          )
        ).rejects.toThrow("Empty presign response");
      });

      it("falls back to legacy presign responses with invalid headers", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              key: "uploads/key",
              upload_url: "https://uploads.example.com/key",
              unique_identifier: "abc",
              headers: "not-an-object",
            }),
          })
        );

        const presign = await run(
          service.presignUpload({
            filename: "file.png",
            byteSize: 10,
          })
        );

        expect(presign.headers).toEqual({});
      });

      it("throws when presign response lacks upload url", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              key: "uploads/key",
              unique_identifier: "abc",
            }),
          })
        );

        await expect(
          run(
            service.presignUpload({
              filename: "file.png",
              byteSize: 10,
            })
          )
        ).rejects.toThrow("Malformed presign response: upload_url missing");
      });

      it("throws on empty multipart presign response", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => null,
          })
        );

        await expect(
          run(
            service.batchPresignMultipartUpload({
              uniqueIdentifier: "abc",
              partNumbers: [1],
            })
          )
        ).rejects.toThrow("Empty multipart presign response");
      });

      it("falls back to legacy multipart presign shape when schema parsing fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              upload_id: "upload-1",
              key: "uploads/key",
              unique_identifier: "abc",
              presigned_urls: [
                { part_number: 1, url: "https://upload/part1", headers: 123 },
              ],
            }),
          })
        );

        const presign = await run(
          service.batchPresignMultipartUpload({
            uniqueIdentifier: "abc",
            partNumbers: [1],
          })
        );

        expect(presign.parts[0]).toEqual({
          partNumber: 1,
          url: "https://upload/part1",
          headers: {},
        });
      });

      it("defaults multipart presign part headers when fallback lacks them", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              upload_id: "upload-1",
              key: "uploads/key",
              unique_identifier: "abc",
              presigned_urls: [{ part_number: 1, url: 42 as any }],
            }),
          })
        );

        const presign = await run(
          service.batchPresignMultipartUpload({
            uniqueIdentifier: "abc",
            partNumbers: [1],
          })
        );

        expect(presign.parts[0]).toEqual({
          partNumber: 1,
          url: 42,
          headers: {},
        });
      });

      it("throws when multipart presign fallback is invalid", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              upload_id: 1,
              presigned_urls: "bad",
            }),
          })
        );

        await expect(
          run(
            service.batchPresignMultipartUpload({
              uniqueIdentifier: "abc",
              partNumbers: [1],
            })
          )
        ).rejects.toThrow("Malformed multipart presign response");
      });

      it("throws when multipart completion response is empty", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({}),
          })
        );

        await expect(
          run(
            service.completeMultipartUpload({
              ...uploadPayload({ uploadType: undefined }),
            })
          )
        ).rejects.toThrow("Empty upload completion response");
      });

      it("completes multipart uploads with default upload type when not provided", async () => {
        const payload = uploadPayload({ uploadType: undefined });

        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              upload: { id: 2, url: "/uploads/2" },
            }),
          })
        );

        const completion = await run(
          service.completeMultipartUpload({
            uniqueIdentifier: payload.uniqueIdentifier,
            uploadId: payload.uploadId,
            key: payload.key,
            parts: payload.parts,
            filename: payload.filename,
            uploadType: payload.uploadType,
          })
        );

        const [, options] = fetchMock.mock.calls[0];
        expect(JSON.parse((options as any).body)).toEqual(
          expect.objectContaining({
            upload_id: payload.uploadId,
            key: payload.key,
            unique_identifier: payload.uniqueIdentifier,
            parts: payload.parts.map(({ partNumber, etag }) => ({
              part_number: partNumber,
              etag,
            })),
            filename: payload.filename,
            upload_type: "composer",
          })
        );
        expect(completion.upload.id).toBe(2);
      });

      it("returns false when abort response is undefined", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => undefined,
          })
        );

        const aborted = await run(
          service.abortMultipartUpload({
            uniqueIdentifier: "abc",
            uploadId: "upload-1",
            key: "uploads/key",
          })
        );

        expect(aborted).toBe(false);
      });

      it("returns false when abort response body is empty text", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) => (key === "content-length" ? "0" : null),
            },
            text: async () => "",
          })
        );

        const aborted = await run(
          service.abortMultipartUpload({
            uniqueIdentifier: "abc",
            uploadId: "upload-1",
            key: "uploads/key",
          })
        );

        expect(aborted).toBe(false);
      });
    });

    describe("createPost", () => {
      it("should create a post when request succeeds", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              id: 10,
              topic_id: 20,
              topic_slug: "new-topic",
            }),
          })
        );

        const result = await run(
          service.createPost({
            title: "A valid title with enough length",
            raw: "This is valid post content that is certainly long enough.",
            category: 5,
            username: "alice",
            topicId: 20,
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts.json",
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              "Api-Key": "test-api-key",
              "Api-Username": "alice",
            }),
          })
        );

        expect(result).toEqual({
          id: 10,
          topic_id: 20,
          topic_slug: "new-topic",
        });
      });

      it("should surface errors when Discourse responds with failure", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 400, text: async () => "bad request" })
        );

        await expectDiscourseApiError(
          () =>
            run(
              service.createPost({
                title: "A valid title with enough length",
                raw: "This is valid post content that is certainly long enough.",
                category: 5,
                username: "alice",
              })
            ),
          {
            status: 400,
            method: "POST",
            pathIncludes: "/posts.json",
            bodyIncludes: "bad request",
            contextIncludes: "Create post failed",
          }
        );
      });

      it("should throw on empty response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(
          run(
            service.createPost({
              title: "A valid title with enough length",
              raw: "This is valid post content that is certainly long enough.",
              category: 5,
              username: "alice",
              topicId: 20,
            })
          )
        ).rejects.toThrow("Empty response from create post");
      });
    });

    describe("editPost", () => {
      it("should send PUT with impersonation and map result", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              post: {
                id: 11,
                topic_id: 22,
                topic_slug: "hello-world",
                post_url: "/p/11",
              },
            }),
          })
        );

        const result = await run(
          service.editPost({
            postId: 11,
            raw: "This is updated content that is long enough.",
            username: "alice",
            editReason: "typo",
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts/11.json",
          expect.objectContaining({
            method: "PUT",
            headers: expect.objectContaining({
              "Api-Key": "test-api-key",
              "Api-Username": "alice",
              "Content-Type": "application/json",
            }),
            body: JSON.stringify({
              post: {
                raw: "This is updated content that is long enough.",
                edit_reason: "typo",
              },
            }),
          })
        );

        expect(result).toEqual({
          id: 11,
          topicId: 22,
          topicSlug: "hello-world",
          postUrl: "/p/11",
        });
      });

      it("should surface errors when Discourse responds with failure", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "server error" })
        );

        await expectDiscourseApiError(
          () =>
            run(
              service.editPost({
                postId: 99,
                raw: "Updated content that is plenty long to be valid.",
                username: "alice",
              })
            ),
          {
            status: 500,
            method: "PUT",
            pathIncludes: "/posts/99.json",
            bodyIncludes: "server error",
            contextIncludes: "Edit post failed",
          }
        );
      });

      it("should surface non-error failures in catch", async () => {
        fetchMock.mockRejectedValueOnce("boom");

        await expect(
          run(
            service.editPost({
              postId: 77,
              raw: "Updated content that is plenty long to be valid.",
              username: "alice",
            })
          )
        ).rejects.toThrow("Edit post failed: boom");
      });

      it("should throw on empty response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(
          run(
            service.editPost({
              postId: 1,
              raw: "updated content with enough length to pass validation",
              username: "alice",
            })
          )
        ).rejects.toThrow("Empty edit response");
      });
    });

    describe("post moderation", () => {
      it("locks a post and echoes locked state", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ locked: true }),
          })
        );

        const result = await run(
          service.lockPost({
            postId: 5,
            locked: true,
            username: "alice",
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts/5/locked.json",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({ locked: true }),
          })
        );
        expect(result).toEqual({ locked: true });
      });

      it("performs a like action with mapping and perform mode defaults", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              id: 123,
              post_action_type_id: 2,
              success: "OK",
            }),
          })
        );

        const likeResult = await run(
          service.performPostAction({
            postId: 9,
            action: "like",
            username: "alice",
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/post_actions",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              id: 9,
              post_action_type_id: 2,
              flag_topic: undefined,
              message: undefined,
              take_action: undefined,
              undo: false,
            }),
          })
        );
        expect(likeResult).toEqual({
          success: true,
          action: "like",
          postActionTypeId: 2,
          postActionId: 123,
        });
      });

      it("marks undo mode automatically for unlike actions", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ success: true }),
          })
        );

        const undoResult = await run(
          service.performPostAction({
            postId: 9,
            action: "unlike",
            username: "alice",
            postActionTypeId: 2,
          })
        );

        expect((fetchMock.mock.calls[0]?.[1] as any)?.body).toContain(
          '"undo":true'
        );
        expect(undoResult.postActionTypeId).toBe(2);
      });

      it("flags a topic when flag mode is provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              id: 321,
              post_action_type_id: 3,
              success: true,
            }),
          })
        );

        await run(
          service.performPostAction({
            postId: 5,
            action: "flag",
            username: "mod",
            mode: { mode: "flag", target: "topic", resolution: "flag" },
            message: "spam",
          })
        );

        const [, request] = fetchMock.mock.calls[0] ?? [];
        expect(request).toEqual(
          expect.objectContaining({
            method: "POST",
          })
        );
        expect(JSON.parse((request as any)?.body)).toEqual(
          expect.objectContaining({
            id: 5,
            post_action_type_id: 3,
            flag_topic: true,
            undo: false,
            message: "spam",
          })
        );
      });

      it("sends take_action when requested via flag mode resolution", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              id: 222,
              post_action_type_id: 4,
              success: true,
            }),
          })
        );

        await run(
          service.performPostAction({
            postId: 6,
            action: "flag",
            username: "mod",
            mode: { mode: "flag", target: "post", resolution: "take_action" },
          })
        );

        const [, request] = fetchMock.mock.calls[0] ?? [];
        expect(request).toEqual(
          expect.objectContaining({
            method: "POST",
          })
        );
        expect(JSON.parse((request as any)?.body)).toEqual(
          expect.objectContaining({
            id: 6,
            post_action_type_id: 3,
            take_action: true,
            undo: false,
          })
        );
      });

      it("throws when action type cannot be resolved", async () => {
        await expect(
          run(
            service.performPostAction({
              postId: 9,
              action: "unsupported" as any,
              username: "alice",
            })
          )
        ).rejects.toThrow("Unsupported or missing post action type");
      });

      it("throws when success flag is missing or invalid", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              id: 55,
              post_action_type_id: 2,
              success: 123,
            }),
          })
        );

        await expect(
          run(
            service.performPostAction({
              postId: 9,
              action: "like",
              username: "alice",
            })
          )
        ).rejects.toThrow("Post action response missing explicit success flag");
      });

      it("parses string success flags and preserves explicit false values", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                id: 99,
                post_action_type_id: 2,
                success: "TrUe",
              }),
            })
          )
          .mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                id: 100,
                post_action_type_id: 2,
                success: "false",
              }),
            })
          )
          .mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                id: 101,
                post_action_type_id: 2,
                success: "   ",
              }),
            })
          );

        const truthy = await run(
          service.performPostAction({
            postId: 9,
            action: "like",
            username: "alice",
          })
        );
        const falsy = await run(
          service.performPostAction({
            postId: 10,
            action: "like",
            username: "alice",
          })
        );

        expect(truthy.success).toBe(true);
        expect(falsy.success).toBe(false);

        await expect(
          run(
            service.performPostAction({
              postId: 11,
              action: "like",
              username: "alice",
            })
          )
        ).rejects.toThrow("Post action response missing explicit success flag");
      });

      it("deletes a post with optional force destroy", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ success: "ok" }),
          })
        );

        const result = await run(
          service.deletePost({
            postId: 44,
            forceDestroy: true,
            username: "moderator",
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts/44.json?force_destroy=true",
          expect.objectContaining({
            method: "DELETE",
            headers: expect.objectContaining({
              "Api-Key": "test-api-key",
              "Api-Username": "moderator",
            }),
          })
        );
        expect(result).toEqual({ success: true });
      });

      it("deletes a post without force destroy using default path", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ deleted: true }),
          })
        );

        const result = await run(
          service.deletePost({
            postId: 45,
            forceDestroy: false,
            username: "moderator",
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts/45.json",
          expect.objectContaining({
            method: "DELETE",
          })
        );
        expect(result).toEqual({ success: true });
      });

      it("resolves explicit post action types through helper", () => {
        const resolved = (service as any).resolvePostActionType(undefined, 7);
        expect(resolved).toBe(7);
      });

      it("maps action names to post action type ids", () => {
        const resolved = (service as any).resolvePostActionType(
          "flag_spam",
          undefined
        );
        expect(resolved).toBe(5);
      });

      it("throws when delete post response is empty", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(
          run(
            service.deletePost({
              postId: 46,
              username: "moderator",
            })
          )
        ).rejects.toThrow("Delete post response missing explicit success flag");
      });
    });

    describe("topic administration", () => {
      it("updates topic status and surfaces empty topic responses", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({ json: async () => ({ success: true }) })
          )
          .mockResolvedValueOnce(
            makeRes({ json: async () => validTopicPayload({ id: 10 }) })
          );

        const result = await run(
          service.updateTopicStatus({
            topicId: 10,
            status: "closed",
            enabled: true,
            username: "alice",
          })
        );

        expect(result.topic.id).toBe(10);

        fetchMock
          .mockResolvedValueOnce(
            makeRes({ json: async () => ({ success: true }) })
          )
          .mockResolvedValueOnce(makeRes({ json: async () => null }));

        await expect(
          run(
            service.updateTopicStatus({
              topicId: 11,
              status: "pinned",
              enabled: false,
              username: "alice",
            })
          )
        ).rejects.toThrow("Empty topic response");
      });

      it("updates topic metadata", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({ json: async () => ({ success: true }) })
          )
          .mockResolvedValueOnce(
            makeRes({
              json: async () =>
                validTopicPayload({ id: 20, title: "Valid topic" }),
            })
          );

        const result = await run(
          service.updateTopicMetadata({
            topicId: 20,
            title: "New title",
            categoryId: 2,
            username: "alice",
          })
        );

        expect(result.topic.title).toBe("Valid topic");
        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/t/20.json",
          expect.objectContaining({
            method: "PUT",
          })
        );
      });

      it("throws when topic metadata response is empty", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({ json: async () => ({ success: true }) })
          )
          .mockResolvedValueOnce(emptyRes());

        await expect(
          run(
            service.updateTopicMetadata({
              topicId: 21,
              title: "Missing",
              username: "alice",
            })
          )
        ).rejects.toThrow("Empty topic response");
      });

      it("bookmarks and invites to topic with joined recipients", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({
              json: async () => ({ bookmark_id: 9 }),
            })
          )
          .mockResolvedValueOnce(
            makeRes({ json: async () => ({ success: true }) })
          );

        const bookmark = await run(
          service.bookmarkTopic({
            topicId: 33,
            postNumber: 1,
            username: "alice",
            reminderAt: "2024-01-01",
          })
        );
        const invite = await run(
          service.inviteToTopic({
            topicId: 33,
            usernames: ["alice", "bob"],
            groupNames: ["mods"],
            username: "carol",
          })
        );

        expect(bookmark).toEqual({ success: true, bookmarkId: 9 });
        expect(invite).toEqual({ success: true });
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          "https://discuss.example.com/t/33/invite",
          expect.objectContaining({
            body: JSON.stringify({
              usernames: "alice,bob",
              group_names: "mods",
            }),
          })
        );
      });

      it("returns bookmark results when bookmark id is missing", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ success: true }),
          })
        );

        const bookmark = await run(
          service.bookmarkTopic({
            topicId: 34,
            postNumber: 2,
            username: "alice",
          })
        );

        expect(bookmark).toEqual({ success: true, bookmarkId: undefined });
      });

      it("sets topic notifications and timestamps", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({
              json: async () => ({ notification_level: 4 }),
            })
          )
          .mockResolvedValueOnce(
            makeRes({ json: async () => ({ success: true }) })
          )
          .mockResolvedValueOnce(
            makeRes({ json: async () => validTopicPayload({ id: 44 }) })
          );

        const notification = await run(
          service.setTopicNotification({
            topicId: 3,
            level: 4,
            username: "alice",
          })
        );

        const timestamp = await run(
          service.changeTopicTimestamp({
            topicId: 44,
            timestamp: "2024-02-01T00:00:00Z",
            username: "alice",
          })
        );

        expect(notification.notificationLevel).toBe(4);
        expect(timestamp.topic.id).toBe(44);
      });

      it("echoes requested locked state when response omits lock field", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({}),
          })
        );

        const result = await run(
          service.lockPost({
            postId: 6,
            locked: false,
            username: "alice",
          })
        );

        expect(result).toEqual({ locked: false });
      });

      it("falls back to provided notification level when response lacks value", async () => {
        fetchMock.mockResolvedValueOnce(makeRes({ json: async () => ({}) }));

        const notification = await run(
          service.setTopicNotification({
            topicId: 3,
            level: "tracking",
            username: "alice",
          })
        );

        const [, options] = fetchMock.mock.calls[0];
        expect(JSON.parse((options as any).body)).toEqual({
          notification_level: 2,
        });
        expect(notification.notificationLevel).toBe(2);
      });

      it("adds topic timers and uses fallback statuses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ status_type: "close" }),
          })
        );

        const timer = await run(
          service.addTopicTimer({
            topicId: 9,
            statusType: "close",
            time: "2024-03-01T00:00:00Z",
            username: "alice",
            durationMinutes: 30,
          })
        );

        expect(timer).toEqual({ success: true, status: "close" });
      });

      it("throws when topic timestamp response is empty", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({ json: async () => ({ success: true }) })
          )
          .mockResolvedValueOnce(emptyRes());

        await expect(
          run(
            service.changeTopicTimestamp({
              topicId: 55,
              timestamp: "2024-02-01T00:00:00Z",
              username: "alice",
            })
          )
        ).rejects.toThrow("Empty topic response");
      });

      it("falls back to provided timer status when response omits status_type", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({}),
          })
        );

        const timer = await run(
          service.addTopicTimer({
            topicId: 9,
            statusType: "open",
            time: "2024-03-01T00:00:00Z",
            username: "alice",
          })
        );

        expect(timer).toEqual({ success: true, status: "open" });
      });

      it("invites to topic without recipients", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ success: true }),
          })
        );

        const invite = await run(
          service.inviteToTopic({
            topicId: 99,
          })
        );

        const [, options] = fetchMock.mock.calls[0];
        expect(JSON.parse((options as any).body)).toEqual({});
        expect(invite).toEqual({ success: true });
      });
    });

    describe("revisions", () => {
      it("fetches a revision with raw content", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ revision: validRevisionPayload() }),
          })
        );

        const result = await run(
          service.getRevision({
            postId: 5,
            revision: 1,
            includeRaw: true,
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts/5/revisions/1.json",
          expect.any(Object)
        );
        expect(result.revision).toEqual(
          expect.objectContaining({
            number: 1,
            postId: 5,
            raw: "Original content",
            cooked: "<p>Original content</p>",
          })
        );
      });

      it("fetches a revision without includeRaw and omits raw field", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ revision: validRevisionPayload() }),
          })
        );

        const result = await run(
          service.getRevision({
            postId: 6,
            revision: 2,
          })
        );

        expect(result.revision.raw).toBeUndefined();
      });

      it("defaults revision timestamps to null when missing", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              revision: {
                number: 3,
                post_id: 2,
                user_id: 1,
                username: "alice",
                cooked: "<p>body</p>",
                changes: {},
              },
            }),
          })
        );

        const result = await run(
          service.getRevision({
            postId: 2,
            revision: 3,
          })
        );

        expect(result.revision.createdAt).toBeNull();
        expect(result.revision.updatedAt).toBeNull();
      });

      it("updates a revision using provided edit reason", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              revision: validRevisionPayload({
                raw: "Updated revision",
                changes: { raw: ["before", "after"] },
              }),
            }),
          })
        );

        const result = await run(
          service.updateRevision({
            postId: 7,
            revision: 2,
            raw: "Updated revision",
            editReason: "cleanup",
            username: "alice",
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts/7/revisions/2.json",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({
              revision: {
                raw: "Updated revision",
                edit_reason: "cleanup",
              },
            }),
          })
        );
        expect(result.revision.raw).toBe("Updated revision");
        expect(result.revision.changes).toEqual({ raw: ["before", "after"] });
      });

      it("deletes a revision", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ success: "OK" }),
          })
        );

        const result = await run(
          service.deleteRevision({
            postId: 8,
            revision: 1,
            username: "moderator",
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts/8/revisions/1.json",
          expect.objectContaining({
            method: "DELETE",
          })
        );
        expect(result).toEqual({ success: true });
      });

      it("defaults delete revision success when response success is missing", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ success: "   " }),
          })
        );

        await expect(
          run(
            service.deleteRevision({
              postId: 9,
              revision: 1,
              username: "moderator",
            })
          )
        ).rejects.toThrow(
          "Delete revision response missing explicit success flag"
        );
      });

      it("defaults delete revision success when body is empty", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(
          run(
            service.deleteRevision({
              postId: 9,
              revision: 2,
              username: "moderator",
            })
          )
        ).rejects.toThrow(
          "Delete revision response missing explicit success flag"
        );
      });

      it("surfaces errors when revision fetch fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 404, text: async () => "missing" })
        );

        await expectDiscourseApiError(
          () => run(service.getRevision({ postId: 2, revision: 3 })),
          {
            status: 404,
            method: "GET",
            pathIncludes: "/posts/2/revisions/3.json",
            bodyIncludes: "missing",
            contextIncludes: "Get revision failed",
          }
        );
      });

      it("throws on empty revision responses", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(
          run(service.getRevision({ postId: 1, revision: 1 }))
        ).rejects.toThrow("Empty revision response");
      });

      it("requires raw when includeRaw is true for revisions", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              revision: {
                number: 2,
                post_id: 1,
                user_id: 1,
                username: "alice",
                created_at: "2024-01-01",
                updated_at: "2024-01-01",
              },
            }),
          })
        );

        await expect(
          run(
            service.getRevision({
              postId: 1,
              revision: 2,
              includeRaw: true,
            })
          )
        ).rejects.toThrow(
          "Revision validation failed: raw is required when includeRaw is true"
        );
      });

      it("throws when update revision response is empty", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(
          run(
            service.updateRevision({
              postId: 9,
              revision: 3,
              raw: "body",
              username: "alice",
            })
          )
        ).rejects.toThrow("Empty revision response");
      });
    });

    describe("mapping helpers", () => {
      it("maps topic, category, and revision via exposed test helpers", () => {
        const topic = (service as any).mapTopic(validTopicPayload());
        expect(topic.slug).toBe(validTopicPayload().slug);

        const category = (service as any).mapCategory(validCategoryPayload());
        expect(category.id).toBe(validCategoryPayload().id);

        const revisionWithRaw = (service as any).mapRevision(
          validRevisionPayload(),
          true
        );
        expect(revisionWithRaw.raw).toBe(validRevisionPayload().raw);

        const revisionWithoutRaw = (service as any).mapRevision(
          validRevisionPayload(),
          false
        );
        expect(revisionWithoutRaw.raw).toBeUndefined();
      });
    });

    describe("search", () => {
      it("should build query and map search results", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => validSearchResponse(),
          })
        );

        const result = await run(
          service.search({
            query: "hello",
            category: "general",
            username: "alice",
            tags: ["tag1"],
            before: "2024-02-01",
            after: "2023-12-01",
            order: "latest",
            status: "open",
            in: "title",
            page: 2,
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/search.json?q=hello+%23general+%40alice+tags%3Atag1+before%3A2024-02-01+after%3A2023-12-01+order%3Alatest+status%3Aopen+in%3Atitle&page=2",
          expect.any(Object)
        );

        expect(result).toEqual({
          posts: [
            expect.objectContaining({
              id: 1,
              topicId: 2,
              topicTitle: "Topic Title",
              blurb: "snippet",
            }),
          ],
          topics: [
            expect.objectContaining({
              id: 2,
              title: "Topic Title",
              slug: "topic-title",
            }),
          ],
          users: [
            expect.objectContaining({
              id: 1,
              username: "alice",
              name: "Alice",
            }),
          ],
          categories: [
            expect.objectContaining({
              id: 10,
              name: "General",
              slug: "general",
            }),
          ],
          totalResults: 1,
          hasMore: true,
        });
      });

      it("should normalize whitespace and clamp invalid pages", async () => {
        fetchMock.mockResolvedValueOnce(makeRes({ json: async () => ({}) }));

        await run(
          service.search({
            query: "  messy   search ",
            page: -10,
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/search.json?q=messy+search&page=1",
          expect.any(Object)
        );
      });

      it("should return defaults when search response is sparse", async () => {
        fetchMock.mockResolvedValueOnce(makeRes({ json: async () => ({}) }));

        const result = await run(
          service.search({
            query: "hello",
          })
        );

        expect(result.totalResults).toBe(0);
        expect(result.hasMore).toBe(false);
        expect(result.posts).toHaveLength(0);
        expect(result.topics).toHaveLength(0);
        expect(result.users).toHaveLength(0);
        expect(result.categories).toHaveLength(0);
      });

      it("should map headline and tolerate missing user fields", async () => {
        const baseSearch = validSearchResponse();
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () =>
              validSearchResponse({
                posts: [
                  {
                    ...baseSearch.posts[0],
                    topic_id: 4,
                    topic: undefined,
                    topic_title_headline: "Headline Title",
                    reply_to_post_number: null,
                  },
                ],
                users: [
                  {
                    id: 9,
                    username: "carol",
                    avatar_template: "/avatar.png",
                  },
                ],
                grouped_search_result: {
                  post_ids: [],
                  more_full_page_results: null,
                },
              }),
          })
        );

        const result = await run(
          service.search({
            query: "headline-only",
          })
        );

        expect(result.posts[0].topicTitle).toBe("Headline Title");
        expect(result.users[0].name).toBeNull();
        expect(result.users[0].title).toBeNull();
        expect(result.hasMore).toBe(false);
        expect(result.totalResults).toBe(0);
      });

      it("should tolerate completely empty search response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        const result = await run(
          service.search({
            query: "empty",
          })
        );

        expect(result.posts).toEqual([]);
        expect(result.topics).toEqual([]);
        expect(result.users).toEqual([]);
        expect(result.categories).toEqual([]);
        expect(result.totalResults).toBe(0);
        expect(result.hasMore).toBe(false);
      });

      it("should fall back to empty topic title when none provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              posts: [
                {
                  id: 3,
                  post_number: 1,
                  username: "dave",
                  avatar_template: "/avatar.png",
                  cooked: "<p>No title</p>",
                  created_at: "2024-01-01",
                  updated_at: "2024-01-02",
                  reply_count: 0,
                  like_count: 0,
                  reply_to_post_number: null,
                  blurb: "snippet",
                },
              ],
              users: [],
              grouped_search_result: {},
            }),
          })
        );

        const result = await run(
          service.search({
            query: "no-title",
          })
        );

        expect(result.posts[0].topicTitle).toBe("");
      });

      it("should tolerate search posts with only blurb and no topic metadata", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              posts: [
                {
                  id: 7,
                  post_number: 2,
                  username: "eve",
                  cooked: "<p>Only blurb</p>",
                  created_at: "2024-01-01",
                  updated_at: "2024-01-02",
                  blurb: "only blurb here",
                },
              ],
              grouped_search_result: {},
            }),
          })
        );

        const result = await run(
          service.search({
            query: "blurb-only",
          })
        );

        expect(result.posts[0].topicId).toBe(0);
        expect(result.posts[0].topicTitle).toBe("");
        expect(result.posts[0].blurb).toBe("only blurb here");
      });

      it("should normalize missing search fields to safe defaults", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              posts: [{}],
              users: [
                {
                  id: 42,
                  username: "noavatar",
                  // avatar_template intentionally missing to hit default path
                },
              ],
              grouped_search_result: {},
            }),
          })
        );

        const result = await run(
          service.search({
            query: "defaults",
          })
        );

        expect(result.posts[0]).toEqual(
          expect.objectContaining({
            id: 0,
            topicId: 0,
            postNumber: 0,
            username: "",
            cooked: "",
            createdAt: null,
            updatedAt: null,
            blurb: "",
          })
        );
        expect(result.users[0].avatarTemplate).toBe("");
      });

      it("should coerce malformed search post entries to defaults", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              posts: ["unexpected"],
              grouped_search_result: {},
            }),
          })
        );

        const result = await run(
          service.search({
            query: "coerce",
          })
        );

        expect(result.posts[0]).toEqual(
          expect.objectContaining({
            id: 0,
            topicId: 0,
            username: "",
            cooked: "",
            raw: undefined,
          })
        );
      });

      it("should keep raw content when provided in search results", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              posts: [
                {
                  id: 12,
                  topic_id: 8,
                  post_number: 2,
                  username: "frank",
                  raw: "raw content here",
                  cooked: "<p>Cooked content</p>",
                },
              ],
              grouped_search_result: {},
            }),
          })
        );

        const result = await run(
          service.search({
            query: "raw-data",
          })
        );

        expect(result.posts[0]).toEqual(
          expect.objectContaining({
            raw: "raw content here",
            cooked: "<p>Cooked content</p>",
            topicId: 8,
          })
        );
      });

      it("should throw when search request fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "boom" })
        );

        await expectDiscourseApiError(
          () =>
            run(
              service.search({
                query: "oops",
              })
            ),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/search.json",
            bodyIncludes: "boom",
            contextIncludes: "Search failed",
          }
        );
      });

      it("should surface search fetch failures", async () => {
        fetchMock.mockRejectedValueOnce(new Error("search crash"));

        await expect(
          run(
            service.search({
              query: "boom",
            })
          )
        ).rejects.toThrow("Search failed: search crash");
      });
    });

    describe("content retrieval", () => {
      it("should fetch a single post with topic", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({ json: async () => validPostPayload() })
          )
          .mockResolvedValueOnce(
            makeRes({ json: async () => validTopicPayload() })
          );

        const result = await run(service.getPost(5, true));

        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          "https://discuss.example.com/posts/5.json",
          expect.any(Object)
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          "https://discuss.example.com/t/10.json",
          expect.any(Object)
        );
        expect(result.post).toEqual(
          expect.objectContaining({
            id: 5,
            topicId: 10,
            raw: "raw content",
            cooked: "<p>Cooked</p>",
            canEdit: true,
            version: 2,
          })
        );
        expect(result.topic.title).toBe("Topic Title");
      });

      it("should default missing optional post fields", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                id: 15,
                topic_id: 25,
                post_number: 1,
                username: "alice",
                cooked: "<p>hello</p>",
              }),
            })
          )
          .mockResolvedValueOnce(
            makeRes({ json: async () => validTopicPayload({ id: 25 }) })
          );

        const result = await run(service.getPost(15, false));

        expect(result.post).toEqual(
          expect.objectContaining({
            avatarTemplate: "",
            replyCount: 0,
            likeCount: 0,
            replyToPostNumber: null,
            version: 1,
          })
        );
      });

      it("should throw on empty post response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(run(service.getPost(1, false))).rejects.toThrow(
          "Empty post response"
        );
      });

      it("should throw on empty topic response", async () => {
        fetchMock
          .mockResolvedValueOnce(
            makeRes({
              json: async () => validPostPayload({ topic_id: 2 }),
            })
          )
          .mockResolvedValueOnce(emptyRes());

        await expect(run(service.getPost(1, false))).rejects.toThrow(
          "Empty topic response"
        );
      });

      it("should fetch replies for a post", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => [
              validPostPayload({
                id: 6,
                topic_id: 10,
                post_number: 2,
                reply_to_post_number: 1,
                username: "bob",
                name: "Bob",
                avatar_template: "/avatar2.png",
                cooked: "<p>Reply</p>",
              }),
            ],
          })
        );

        const result = await run(service.getPostReplies(5));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts/5/replies.json",
          expect.any(Object)
        );
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(
          expect.objectContaining({
            id: 6,
            topicId: 10,
            replyToPostNumber: 1,
          })
        );
      });

      it("should return empty array when replies response is empty", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        const result = await run(service.getPostReplies(5));
        expect(result).toEqual([]);
      });

      it("should throw on malformed post response", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              id: "missing-number",
            }),
          })
        );

        await expect(run(service.getPost(5, true))).rejects.toThrow(
          "Get post failed: Malformed post response"
        );
      });

      it("should list posts with pagination", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              latest_posts: [
                validPostPayload({
                  id: 50,
                  topic_id: 12,
                  post_number: 4,
                  raw: undefined,
                  cooked: "<p>Latest post</p>",
                }),
              ],
              more_posts_url: "/posts?page=2",
            }),
          })
        );

        const result = await run(service.listPosts({ page: 1 }));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts.json?page=1",
          expect.any(Object)
        );
        expect(result.posts[0].id).toBe(50);
        expect(result.hasMore).toBe(true);
        expect(result.nextPage).toBe(2);
      });

      it("should return null next page when more_posts_url is missing", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              latest_posts: [
                validPostPayload({
                  id: 88,
                  topic_id: 33,
                  post_number: 7,
                  cooked: "<p>Standalone post</p>",
                }),
              ],
            }),
          })
        );

        const result = await run(service.listPosts({}));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/posts.json",
          expect.any(Object)
        );
        expect(result.posts[0].id).toBe(88);
        expect(result.hasMore).toBe(false);
        expect(result.nextPage).toBeNull();
      });

      it("should default to empty posts array when list response lacks posts", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({}),
          })
        );

        const result = await run(service.listPosts({}));

        expect(result.posts).toEqual([]);
        expect(result.hasMore).toBe(false);
        expect(result.nextPage).toBeNull();
      });

      it("should handle empty list posts response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        const result = await run(service.listPosts({}));

        expect(result.posts).toEqual([]);
        expect(result.hasMore).toBe(false);
        expect(result.nextPage).toBeNull();
      });

      it("should throw on malformed list posts response", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              latest_posts: {},
            }),
          })
        );

        await expect(run(service.listPosts({}))).rejects.toThrow(
          "Malformed posts response"
        );
      });

      it("should fetch latest topics with params", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 1,
                    title: "Latest Topic",
                    slug: "latest-topic",
                    category_id: 3,
                  }),
                ],
                more_topics_url: "/more",
              },
            }),
          })
        );

        const result = await run(
          service.getLatestTopics({ categoryId: 3, page: 2, order: "activity" })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/c/3/l/latest.json?page=2&order=activity",
          expect.any(Object)
        );
        expect(result.topics[0].title).toBe("Latest Topic");
        expect(result.hasMore).toBe(true);
        expect(result.nextPage).toBe(3);
      });

      it("should omit page when category page is not positive", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 7,
                    title: "No Page",
                    slug: "no-page",
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getLatestTopics({ categoryId: 5, page: 0, order: "default" })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/c/5/l/latest.json",
          expect.any(Object)
        );
        expect(result.nextPage).toBeNull();
      });

      it("should throw on malformed topic response", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  {
                    id: 1,
                    title: "Latest Topic",
                  },
                ],
              },
            }),
          })
        );

        await expect(
          run(
            service.getLatestTopics({
              categoryId: 3,
              page: 2,
              order: "activity",
            })
          )
        ).rejects.toThrow("Get latest topics failed: Malformed topic response");
      });

      it("should fetch latest topics without category defaults", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 2,
                    title: "Default Latest",
                    slug: "default-latest",
                    category_id: 1,
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(service.getLatestTopics({}));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/latest.json",
          expect.any(Object)
        );
        expect(result.nextPage).toBeNull();
        expect(result.hasMore).toBe(false);
      });

      it("should fetch latest topics without category when page and order provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 42,
                    title: "Ordered",
                    slug: "ordered",
                  }),
                ],
                more_topics_url: "/more-ordered",
              },
            }),
          })
        );

        const result = await run(
          service.getLatestTopics({ page: 2, order: "activity" })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/latest.json?page=2&order=activity",
          expect.any(Object)
        );
        expect(result.topics[0].id).toBe(42);
        expect(result.hasMore).toBe(true);
        expect(result.nextPage).toBe(3);
      });

      it("should clamp negative pages for latest topics", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(service.getLatestTopics({ page: -3 }));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/latest.json",
          expect.any(Object)
        );
        expect(result.nextPage).toBeNull();
      });

      it("should handle empty latest topics response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        const result = await run(service.getLatestTopics({}));
        expect(result.topics).toEqual([]);
        expect(result.hasMore).toBe(false);
        expect(result.nextPage).toBeNull();
      });

      it("omits page params for the first page of topic lists", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 44,
                    title: "First Page",
                    slug: "first-page",
                    category_id: 1,
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopicList({ type: "latest", page: 0 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/latest.json",
          expect.any(Object)
        );
        expect(result.topics[0].id).toBe(44);
        expect(result.hasMore).toBe(false);
        expect(result.nextPage).toBeNull();
      });

      it("should fetch generic topic list for new topics", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 77,
                    title: "New Generic",
                    slug: "new-generic",
                    category_id: 2,
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopicList({ type: "new", page: 1 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/new.json?page=1",
          expect.any(Object)
        );
        expect(result.topics[0].id).toBe(77);
        expect(result.hasMore).toBe(false);
        expect(result.nextPage).toBeNull();
      });

      it("should fetch topic list for top topics with category", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 78,
                    title: "Top Generic",
                    slug: "top-generic",
                    category_id: 8,
                  }),
                ],
                more_topics_url: "/c/8/l/top/weekly?page=3",
              },
            }),
          })
        );

        const result = await run(
          service.getTopicList({
            type: "top",
            categoryId: 8,
            page: 2,
            period: "weekly",
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/c/8/l/top/weekly.json?page=2",
          expect.any(Object)
        );
        expect(result.topics[0].id).toBe(78);
        expect(result.hasMore).toBe(true);
        expect(result.nextPage).toBe(3);
      });

      it("should fetch category topics using slug and id", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 90,
                    title: "Category Slug Topic",
                    slug: "category-slug-topic",
                    category_id: 12,
                  }),
                ],
                more_topics_url: "/c/general/12?page=2",
              },
            }),
          })
        );

        const result = await run(
          service.getCategoryTopics({
            slug: "general",
            categoryId: 12,
            page: 1,
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/c/general/12.json?page=1",
          expect.any(Object)
        );
        expect(result.topics[0].slug).toBe("category-slug-topic");
        expect(result.hasMore).toBe(true);
        expect(result.nextPage).toBe(2);
      });

      it("omits page query when requesting the first category page", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 91,
                    title: "First category page",
                    slug: "first-category",
                    category_id: 12,
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getCategoryTopics({
            slug: "general",
            categoryId: 12,
            page: 0,
          })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/c/general/12.json",
          expect.any(Object)
        );
        expect(result.topics[0].id).toBe(91);
        expect(result.nextPage).toBeNull();
      });

      it("should fetch top topics", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 9,
                    title: "Top Topic",
                    slug: "top-topic",
                    category_id: 7,
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopTopics({ period: "weekly", categoryId: 7, page: 1 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/c/7/l/top/weekly.json?page=1",
          expect.any(Object)
        );
        expect(result.topics[0].title).toBe("Top Topic");
        expect(result.hasMore).toBe(false);
        expect(result.nextPage).toBeNull();
      });

      it("should fetch top topics without category", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 3,
                    title: "General Top",
                    slug: "general-top",
                    category_id: 2,
                  }),
                ],
                more_topics_url: "/more",
              },
            }),
          })
        );

        const result = await run(service.getTopTopics({ period: "weekly" }));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/top/weekly.json",
          expect.any(Object)
        );
        expect(result.nextPage).toBe(1);
        expect(result.hasMore).toBe(true);
      });

      it("should fetch top topics without category and page", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 11,
                    title: "Paged Top",
                    slug: "paged-top",
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopTopics({ period: "weekly", page: 2 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/top/weekly.json?page=2",
          expect.any(Object)
        );
        expect(result.nextPage).toBeNull();
      });

      it("should handle empty top topics response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        const result = await run(service.getTopTopics({ period: "weekly" }));
        expect(result.topics).toEqual([]);
        expect(result.hasMore).toBe(false);
        expect(result.nextPage).toBeNull();
      });

      it("should clamp negative page numbers for top topics", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopTopics({ period: "monthly", page: -5 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/top/monthly.json",
          expect.any(Object)
        );
        expect(result.nextPage).toBeNull();
      });

      it("should fetch top topics for a category and page", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 12,
                    title: "Top Cat Topic",
                    slug: "top-cat-topic",
                    category_id: 8,
                  }),
                ],
                more_topics_url: "/c/8/l/top/monthly?page=3",
              },
            }),
          })
        );

        const result = await run(
          service.getTopTopics({ period: "monthly", categoryId: 8, page: 2 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/c/8/l/top/monthly.json?page=2",
          expect.any(Object)
        );
        expect(result.topics[0].id).toBe(12);
        expect(result.hasMore).toBe(true);
        expect(result.nextPage).toBe(3);
      });

      it("should omit page when category page is not positive for top topics", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 13,
                    title: "Cat Default",
                    slug: "cat-default",
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopTopics({ period: "weekly", categoryId: 9, page: -1 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/c/9/l/top/weekly.json",
          expect.any(Object)
        );
        expect(result.nextPage).toBeNull();
      });

      it("builds ordered topic list paths for latest topics", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              topic_list: {
                topics: [
                  validTopicPayload({
                    id: 22,
                    title: "Ordered Latest",
                    slug: "ordered",
                  }),
                ],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopicList({ type: "latest", order: "views", page: 1 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/latest.json?page=1&order=views",
          expect.any(Object)
        );
        expect(result.topics[0].id).toBe(22);
      });

      it("mapTopic should supply defaults for missing optional fields", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ id: 55, title: "Minimal", slug: "min" }),
          })
        );

        const result = await run(service.getTopic(55));

        expect(result).toEqual(
          expect.objectContaining({
            createdAt: null,
            categoryId: null,
            lastPostedAt: null,
            postsCount: 0,
            replyCount: 0,
            likeCount: 0,
            views: 0,
            pinned: false,
            closed: false,
            archived: false,
            visible: true,
          })
        );
      });

      it("mapTopic should supply defaults when optional fields missing but created_at present", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              id: 56,
              title: "Minimal",
              slug: "min",
              created_at: "2024-01-01",
            }),
          })
        );

        const result = await run(service.getTopic(56));

        expect(result).toEqual(
          expect.objectContaining({
            createdAt: "2024-01-01",
            categoryId: null,
            lastPostedAt: null,
            postsCount: 0,
            replyCount: 0,
            likeCount: 0,
            views: 0,
            pinned: false,
            closed: false,
            archived: false,
            visible: true,
          })
        );
      });

      it("mapPost should require raw when includeRaw is true", () => {
        const mapper = (service as any).mapPost.bind(service);

        expect(() =>
          mapper(validPostPayload({ raw: undefined }), true)
        ).toThrow(
          "Post validation failed: raw is required when includeRaw is true"
        );
      });

      it("should surface errors when getPost fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "boom" })
        );

        await expectDiscourseApiError(() => run(service.getPost(99, false)), {
          status: 500,
          method: "GET",
          pathIncludes: "/posts/99.json",
          bodyIncludes: "boom",
          contextIncludes: "Get post failed",
        });
      });

      it("should surface errors when replies fetch fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 404, text: async () => "not found" })
        );

        await expectDiscourseApiError(() => run(service.getPostReplies(999)), {
          status: 404,
          method: "GET",
          pathIncludes: "/posts/999/replies.json",
          bodyIncludes: "not found",
          contextIncludes: "Get post replies failed",
        });
      });

      it("should surface errors when getTopic fetch rejects", async () => {
        fetchMock.mockRejectedValueOnce(new Error("network down"));

        await expect(run(service.getTopic(42))).rejects.toThrow(
          "Get topic failed: network down"
        );
      });

      it("should surface errors when latest topics fetch fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "server error" })
        );

        await expectDiscourseApiError(
          () => run(service.getLatestTopics({ categoryId: 1, page: 1 })),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/c/1/l/latest.json",
            bodyIncludes: "server error",
            contextIncludes: "Get latest topics failed",
          }
        );
      });

      it("should surface errors when top topics fetch fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "server error" })
        );

        await expectDiscourseApiError(
          () =>
            run(
              service.getTopTopics({ period: "weekly", categoryId: 1, page: 1 })
            ),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/c/1/l/top/weekly.json",
            bodyIncludes: "server error",
            contextIncludes: "Get top topics failed",
          }
        );
      });
    });

    describe("categories and users", () => {
      it("getCategories should return empty array on empty response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        const result = await run(service.getCategories());
        expect(result).toEqual([]);
      });

      it("getCategories should throw when categories payload is not an array", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ category_list: { categories: {} } }),
          })
        );

        await expect(run(service.getCategories())).rejects.toThrow(
          "Get categories failed: Malformed category response"
        );
      });

      it("getCategories should fill category defaults when optional fields missing", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              category_list: {
                categories: [{ id: 1, name: "Gen", slug: "gen" }],
              },
            }),
          })
        );

        const result = await run(service.getCategories());
        expect(result[0]).toEqual(
          expect.objectContaining({
            description: null,
            color: "",
            topicCount: 0,
            parentCategoryId: null,
            readRestricted: false,
          })
        );
      });

      it("getCategories should keep provided optional fields when present", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              category_list: {
                categories: [
                  validCategoryPayload({
                    description: "Custom description",
                    parent_category_id: 42,
                  }),
                ],
              },
            }),
          })
        );

        const [category] = await run(service.getCategories());
        expect(category.description).toBe("Custom description");
        expect(category.parentCategoryId).toBe(42);
      });

      it("should throw on malformed category response", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              category_list: {
                categories: [{ name: "General", slug: "general" }],
              },
            }),
          })
        );

        await expect(run(service.getCategories())).rejects.toThrow(
          "Get categories failed: Malformed category response"
        );
      });

      it("should report root validation errors for category parsing", () => {
        const mapper = (service as any).mapCategory.bind(service);

        expect(() => mapper(null)).toThrow("Malformed category response");
      });

      it("should surface errors when getCategories fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 503, text: async () => "unavailable" })
        );

        await expectDiscourseApiError(() => run(service.getCategories()), {
          status: 503,
          method: "GET",
          pathIncludes: "/categories.json",
          bodyIncludes: "unavailable",
          contextIncludes: "Get categories failed",
        });
      });

      it("getCategory should throw on empty category response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(run(service.getCategory("missing"))).rejects.toThrow(
          "Empty category response"
        );
      });

      it("getCategory should map subcategories when present", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              category: validCategoryPayload({
                id: 1,
                slug: "parent",
                name: "Parent",
              }),
              subcategory_list: [
                validCategoryPayload({ id: 2, slug: "child", name: "Child" }),
              ],
            }),
          })
        );

        const result = await run(service.getCategory("parent"));
        expect(result.subcategories[0]).toEqual(
          expect.objectContaining({ id: 2, slug: "child", name: "Child" })
        );
      });

      it("getCategory should support nested subcategory_list categories shape", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              category: validCategoryPayload({
                id: 1,
                slug: "parent",
                name: "Parent",
              }),
              subcategory_list: {
                categories: [
                  validCategoryPayload({
                    id: 3,
                    slug: "grandchild",
                    name: "Grandchild",
                  }),
                ],
              },
            }),
          })
        );

        const result = await run(service.getCategory("parent"));
        expect(result.subcategories).toHaveLength(1);
        expect(result.subcategories[0].slug).toBe("grandchild");
      });

      it("getCategory should default to empty subcategories when missing", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              category: validCategoryPayload({
                id: 1,
                slug: "parent",
                name: "Parent",
              }),
            }),
          })
        );

        const result = await run(service.getCategory("parent"));
        expect(result.subcategories).toEqual([]);
      });

      it("should surface errors when getCategory fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 404, text: async () => "missing" })
        );

        await expectDiscourseApiError(
          () => run(service.getCategory("missing")),
          {
            status: 404,
            method: "GET",
            pathIncludes: "/c/missing/show.json",
            bodyIncludes: "missing",
            contextIncludes: "Get category failed",
          }
        );
      });

      it("getTopic should throw on empty topic response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(run(service.getTopic(123))).rejects.toThrow(
          "Empty topic response"
        );
      });

      it("should surface errors when getTopic fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "server error" })
        );

        await expectDiscourseApiError(() => run(service.getTopic(123)), {
          status: 500,
          method: "GET",
          pathIncludes: "/t/123.json",
          bodyIncludes: "server error",
          contextIncludes: "Get topic failed",
        });
      });

      it("getUser should throw on empty user response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(run(service.getUser("alice"))).rejects.toThrow(
          "Empty user response"
        );
      });

      it("should surface malformed user responses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              user: { username: "no-id" },
            }),
          })
        );

        await expect(run(service.getUser("alice"))).rejects.toThrow(
          "Get user failed: Malformed user response"
        );
      });

      it("should surface errors when getUser fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "server error" })
        );

        await expectDiscourseApiError(() => run(service.getUser("alice")), {
          status: 500,
          method: "GET",
          pathIncludes: "/u/alice.json",
          bodyIncludes: "server error",
          contextIncludes: "Get user failed",
        });
      });

      it("should surface errors when getUser fetch rejects", async () => {
        fetchMock.mockRejectedValueOnce(new Error("network down"));

        await expect(run(service.getUser("alice"))).rejects.toThrow(
          "Get user failed: network down"
        );
      });

      it("getUser should map optional fields with defaults", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              user: {
                id: 7,
                username: "bob",
              },
            }),
          })
        );

        const user = await run(service.getUser("bob"));
        expect(user).toEqual(
          expect.objectContaining({
            id: 7,
            username: "bob",
            name: null,
            avatarTemplate: "",
            trustLevel: 0,
            moderator: false,
            admin: false,
            postCount: 0,
            profileViewCount: 0,
          })
        );
      });

      describe("user management", () => {
        it("creates users with the system API key", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                success: true,
                user_id: 9,
                active: true,
              }),
            })
          );

          const result = await run(
            service.createUser({
              username: "new-user",
              email: "new@example.com",
              password: "longsecret",
            })
          );

          expect(fetchMock).toHaveBeenCalledWith(
            "https://discuss.example.com/users",
            expect.objectContaining({
              method: "POST",
              headers: expect.objectContaining({
                "Api-Key": "test-api-key",
                "Api-Username": "system",
              }),
            })
          );

          expect(result).toEqual({
            success: true,
            userId: 9,
            active: true,
          });
        });

        it("defaults create user metadata when optional fields are missing", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({ success: true }),
            })
          );

          const result = await run(
            service.createUser({
              username: "new-user",
              email: "new@example.com",
              password: "longsecret",
            })
          );

          expect(result).toEqual({
            success: true,
            userId: undefined,
            active: undefined,
          });
        });

        it("ignores non-numeric create user ids and active flags", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                success: true,
                user_id: "abc",
                active: "yes",
              }),
            })
          );

          const result = await run(
            service.createUser({
              username: "bad-id",
              email: "bad@example.com",
              password: "longsecret",
            })
          );

          expect(result).toEqual({
            success: true,
            userId: undefined,
            active: undefined,
          });
        });

        it("throws when create user response is empty", async () => {
          fetchMock.mockResolvedValueOnce(emptyRes());

          await expect(
            run(
              service.createUser({
                username: "missing",
                email: "missing@example.com",
              })
            )
          ).rejects.toThrow("Empty create user response");
        });

        it("lists admin users with extended fields", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => [validAdminUserPayload()],
            })
          );

          const users = await run(
            service.listAdminUsers({ filter: "active", showEmails: true })
          );

          expect(fetchMock).toHaveBeenCalledWith(
            "https://discuss.example.com/admin/users/list/active.json?show_emails=true",
            expect.objectContaining({
              headers: expect.objectContaining({
                "Api-Key": "test-api-key",
                "Api-Username": "system",
              }),
            })
          );
          expect(users[0]).toEqual(
            expect.objectContaining({
              email: "alice@example.com",
              active: true,
              lastSeenAt: "2024-01-01T00:00:00Z",
              staged: false,
            })
          );
        });

        it("omits show_emails when admin user listing does not request it", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => [validAdminUserPayload()],
            })
          );

          await run(service.listAdminUsers({ filter: "new" }));

          expect(fetchMock).toHaveBeenCalled();
          const [url] =
            fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
          expect(url ?? "").not.toContain("show_emails");
        });

        it("handles admin users without email addresses", async () => {
          const payload = validAdminUserPayload();
          delete (payload as any).email;

          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => [payload],
            })
          );

          const users = await run(service.listAdminUsers({ filter: "staff" }));

          expect(users[0].email).toBeUndefined();
        });

        it("fetches users by external id", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                user: validUserPayload(),
              }),
            })
          );

          const user = await run(
            service.getUserByExternal({ externalId: "abc", provider: "oidc" })
          );

          expect(fetchMock).toHaveBeenCalledWith(
            "https://discuss.example.com/u/by-external/oidc/abc.json",
            expect.objectContaining({
              headers: expect.objectContaining({
                "Api-Key": "test-api-key",
                "Api-Username": "system",
              }),
            })
          );
          expect(user.username).toBe("alice");
        });

        it("returns directory listings with totals", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                directory_items: [validDirectoryItemPayload()],
                meta: { total_rows_directory_items: 10 },
              }),
            })
          );

          const result = await run(
            service.getDirectory({ period: "weekly", order: "likes_received" })
          );

          expect(fetchMock).toHaveBeenCalledWith(
            "https://discuss.example.com/directory_items.json?period=weekly&order=likes_received",
            expect.any(Object)
          );
          expect(result).toEqual(
            expect.objectContaining({
              totalRows: 10,
              items: [
                expect.objectContaining({
                  likesReceived: 5,
                  user: expect.objectContaining({ username: "alice" }),
                }),
              ],
            })
          );
        });

        it("falls back to computed totals when meta is missing", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                directory_items: [validDirectoryItemPayload()],
                meta: {},
              }),
            })
          );

          const result = await run(
            service.getDirectory({ period: "weekly", order: "likes_received" })
          );

          expect(result.totalRows).toBe(1);
        });

        it("includes page in directory query when provided and positive", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                directory_items: [validDirectoryItemPayload()],
                meta: {},
              }),
            })
          );

          await run(
            service.getDirectory({
              period: "weekly",
              order: "likes_received",
              page: 3,
            })
          );

          const [url] =
            fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
          expect(url).toContain("page=3");
        });

        it("omits page from directory query when page is non-positive", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                directory_items: [validDirectoryItemPayload()],
                meta: {},
              }),
            })
          );

          await run(
            service.getDirectory({
              period: "weekly",
              order: "likes_received",
              page: 0,
            })
          );

          const [url] =
            fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
          expect(url).toBe(
            "https://discuss.example.com/directory_items.json?period=weekly&order=likes_received"
          );
        });

        it("returns empty directory items when response omits them", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({}),
            })
          );

          const result = await run(
            service.getDirectory({ period: "weekly", order: "likes_received" })
          );

          expect(result.items).toEqual([]);
          expect(result.totalRows).toBe(0);
        });

        it("throws on malformed directory responses", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({ directory_items: {} }),
            })
          );

          await expect(
            run(
              service.getDirectory({
                period: "weekly",
                order: "likes_received",
              })
            )
          ).rejects.toThrow("Malformed directory response");
        });

        it("handles password flows and logout via system key", async () => {
          fetchMock
            .mockResolvedValueOnce(
              makeRes({ json: async () => ({ success: true }) })
            )
            .mockResolvedValueOnce(
              makeRes({ json: async () => ({ success: true }) })
            )
            .mockResolvedValueOnce(
              makeRes({ json: async () => ({ success: true }) })
            );

          const forgot = await run(service.forgotPassword("alice@example.com"));
          const changed = await run(
            service.changePassword({ token: "tok", password: "newpass123" })
          );
          const logout = await run(service.logoutUser(42));

          expect(forgot.success).toBe(true);
          expect(changed.success).toBe(true);
          expect(logout.success).toBe(true);

          expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "https://discuss.example.com/session/forgot_password",
            expect.objectContaining({
              method: "POST",
              headers: expect.objectContaining({
                "Api-Key": "test-api-key",
                "Api-Username": "system",
              }),
            })
          );
          expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "https://discuss.example.com/u/password-reset/tok.json",
            expect.objectContaining({
              method: "PUT",
              headers: expect.objectContaining({
                "Api-Key": "test-api-key",
                "Api-Username": "system",
              }),
            })
          );
          expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "https://discuss.example.com/admin/users/42/log_out",
            expect.objectContaining({
              method: "POST",
            })
          );
        });

        it("throws when password or logout responses are empty", async () => {
          fetchMock
            .mockResolvedValueOnce(emptyRes())
            .mockResolvedValueOnce(emptyRes());

          await expect(
            run(
              service.changePassword({ token: "tok", password: "newpass123" })
            )
          ).rejects.toThrow("Empty password change response");

          await expect(run(service.logoutUser(99))).rejects.toThrow(
            "Empty logout response"
          );
        });

        it("syncs SSO payloads and updates user status", async () => {
          fetchMock
            .mockResolvedValueOnce(
              makeRes({ json: async () => ({ success: true, user_id: 77 }) })
            )
            .mockResolvedValueOnce(
              makeRes({
                json: async () => ({
                  status: { emoji: "wave", description: "Hi", ends_at: null },
                }),
              })
            )
            .mockResolvedValueOnce(
              makeRes({
                json: async () => ({
                  status: { emoji: "wave", description: "Hi", ends_at: null },
                }),
              })
            );

          const ssoResult = await run(
            service.syncSso({ sso: "payload", sig: "signature" })
          );
          const statusResult = await run(service.getUserStatus("alice"));
          const updatedStatus = await run(
            service.updateUserStatus({
              username: "alice",
              emoji: "wave",
              description: "Hi",
              endsAt: null,
            })
          );

          expect(ssoResult).toEqual({ success: true, userId: 77 });
          expect(statusResult.status).toEqual(
            expect.objectContaining({
              emoji: "wave",
              description: "Hi",
              endsAt: null,
            })
          );
          expect(updatedStatus.status).toEqual(
            expect.objectContaining({
              emoji: "wave",
              description: "Hi",
              endsAt: null,
            })
          );
        });

        it("returns undefined userId when SSO sync response omits it", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({ success: true }),
            })
          );

          const ssoResult = await run(
            service.syncSso({ sso: "payload", sig: "signature" })
          );

          expect(ssoResult).toEqual({ success: true, userId: undefined });
        });

        it("handles empty SSO and status responses gracefully", async () => {
          fetchMock
            .mockResolvedValueOnce(emptyRes())
            .mockResolvedValueOnce(makeRes({ json: async () => ({}) }))
            .mockResolvedValueOnce(emptyRes());

          await expect(
            run(service.syncSso({ sso: "payload", sig: "sig" }))
          ).rejects.toThrow("Empty SSO sync response");

          const status = await run(service.getUserStatus("alice"));
          expect(status).toEqual({ status: null });

          await expect(
            run(
              service.updateUserStatus({
                username: "alice",
                emoji: null,
                description: null,
                endsAt: null,
              })
            )
          ).rejects.toThrow("Empty status response");
        });

        it("lists users with pagination", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({
                users: [
                  {
                    id: 1,
                    username: "alice",
                    avatar_template: "/user/{size}",
                    name: null,
                    title: null,
                    trust_level: 1,
                    moderator: false,
                    admin: false,
                  },
                ],
              }),
            })
          );

          const [user] = await run(service.listUsers({ page: 2 }));

          expect(fetchMock).toHaveBeenCalledWith(
            "https://discuss.example.com/users.json?page=2",
            expect.any(Object)
          );
          expect(user.username).toBe("alice");
        });

        it("returns an empty list when users payload is missing", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({}),
            })
          );

          const result = await run(service.listUsers({}));

          expect(result).toEqual([]);
          expect(fetchMock).toHaveBeenCalledWith(
            "https://discuss.example.com/users.json",
            expect.any(Object)
          );
        });

        it("throws when update or delete user responses are empty", async () => {
          fetchMock
            .mockResolvedValueOnce(emptyRes())
            .mockResolvedValueOnce(emptyRes());

          await expect(
            run(
              service.updateUser({
                username: "missing",
                email: "missing@example.com",
              })
            )
          ).rejects.toThrow("Empty update user response");

          await expect(
            run(
              service.deleteUser({
                userId: 99,
                blockEmail: true,
              })
            )
          ).rejects.toThrow("Empty delete user response");
        });

        it("updates and deletes users successfully", async () => {
          fetchMock
            .mockResolvedValueOnce(
              makeRes({ json: async () => ({ success: true }) })
            )
            .mockResolvedValueOnce(
              makeRes({ json: async () => ({ success: "ok" }) })
            );

          const updated = await run(
            service.updateUser({
              username: "alice",
              email: "alice@example.com",
            })
          );
          const deleted = await run(
            service.deleteUser({
              userId: 1,
            })
          );

          expect(updated).toEqual({ success: true });
          expect(deleted).toEqual({ success: true });
          expect(fetchMock).toHaveBeenCalledWith(
            "https://discuss.example.com/admin/users/1.json",
            expect.objectContaining({ method: "DELETE" })
          );
        });

        it("passes through delete user blocking flags in query params", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({ json: async () => ({ success: true }) })
          );

          await run(
            service.deleteUser({
              userId: 77,
              blockEmail: true,
              blockUrls: true,
              blockIp: true,
              deletePosts: true,
              context: "abuse",
            })
          );

          const [url] =
            fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
          expect(url).toContain("block_email=true");
          expect(url).toContain("block_urls=true");
          expect(url).toContain("block_ip=true");
          expect(url).toContain("delete_posts=true");
          expect(url).toContain("context=abuse");
        });

        it("throws on malformed users list responses", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({ users: {} }),
            })
          );

          await expect(run(service.listUsers({}))).rejects.toThrow(
            "Malformed users response"
          );
        });

        it("lists users without page query when page is zero or missing", async () => {
          fetchMock.mockResolvedValueOnce(
            makeRes({
              json: async () => ({ users: [validUserPayload()] }),
            })
          );

          await run(service.listUsers({ page: 0 }));

          const [url] =
            fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
          expect(url).toBe("https://discuss.example.com/users.json");
        });

        it("throws when admin users or external lookup responses are empty", async () => {
          fetchMock.mockResolvedValueOnce(emptyRes());

          await expect(
            run(service.listAdminUsers({ filter: "active", showEmails: true }))
          ).rejects.toThrow("Empty admin users response");

          fetchMock.mockResolvedValueOnce(emptyRes());

          await expect(
            run(
              service.getUserByExternal({
                externalId: "missing",
                provider: "oidc",
              })
            )
          ).rejects.toThrow("Empty external user response");
        });
      });

      it("getTags should normalize list responses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tags: [
                validTagPayload({
                  id: 2,
                  name: "support",
                  topic_count: 4,
                  pm_topic_count: 1,
                  synonyms: ["help"],
                  target_tag: "assist",
                  description: "Support related",
                }),
              ],
            }),
          })
        );

        const [tag] = await run(service.getTags());

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/tags.json",
          expect.any(Object)
        );
        expect(tag).toEqual({
          id: 2,
          name: "support",
          topicCount: 4,
          pmTopicCount: 1,
          synonyms: ["help"],
          targetTag: "assist",
          description: "Support related",
        });
      });

      it("getTag should fetch a single tag", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tag: validTagPayload({
                id: 5,
                name: "feature",
                topic_count: 3,
                synonyms: ["enhancement"],
              }),
            }),
          })
        );

        const tag = await run(service.getTag("feature"));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/tags/feature.json",
          expect.any(Object)
        );
        expect(tag.name).toBe("feature");
        expect(tag.synonyms).toContain("enhancement");
      });

      it("getTags should return empty array when response is missing", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => null,
          })
        );

        const tags = await run(service.getTags());

        expect(tags).toEqual([]);
      });

      it("getTags should throw on malformed tag list", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ tags: {} }),
          })
        );

        await expect(run(service.getTags())).rejects.toThrow(
          "Malformed tags response"
        );
      });

      it("getTag should throw when tag response is empty", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({}),
          })
        );

        await expect(run(service.getTag("missing"))).rejects.toThrow(
          "Empty tag response"
        );
      });

      it("getTagGroups should map permissions and nested tags", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tag_groups: [
                validTagGroupPayload({
                  id: 9,
                  name: "Releases",
                  tag_names: ["stable", "beta"],
                  parent_tag_names: ["release"],
                  one_per_topic: true,
                  permissions: { staff: 1 },
                  tags: [
                    validTagPayload({
                      id: 10,
                      name: "stable",
                      topic_count: 2,
                    }),
                  ],
                }),
              ],
            }),
          })
        );

        const [group] = await run(service.getTagGroups());

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/tag_groups.json",
          expect.any(Object)
        );
        expect(group).toEqual(
          expect.objectContaining({
            id: 9,
            name: "Releases",
            tagNames: ["stable", "beta"],
            parentTagNames: ["release"],
            onePerTopic: true,
            permissions: { staff: 1 },
          })
        );
        expect(group.tags?.[0]).toEqual(
          expect.objectContaining({
            name: "stable",
            topicCount: 2,
          })
        );
      });

      it("getTagGroups should return empty array when response missing", async () => {
        fetchMock.mockResolvedValueOnce(makeRes({ json: async () => null }));

        const groups = await run(service.getTagGroups());

        expect(groups).toEqual([]);
      });

      it("getTagGroups should throw on malformed response", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ tag_groups: {} }),
          })
        );

        await expect(run(service.getTagGroups())).rejects.toThrow(
          "Malformed tag groups response"
        );
      });

      it("normalizes boolean permissions when mapping tag groups", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tag_groups: [
                validTagGroupPayload({
                  id: 15,
                  permissions: {
                    staff: true,
                    moderators: "2",
                    viewer: false,
                    invalid: "oops" as any,
                  },
                }),
              ],
            }),
          })
        );

        const [group] = await run(service.getTagGroups());

        expect(group.permissions).toEqual({
          staff: 1,
          moderators: 2,
          viewer: 0,
        });
      });

      it("defaults missing tag arrays when mapping tag groups", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tag_groups: [
                validTagGroupPayload({
                  id: 99,
                  tags: undefined,
                  tag_names: [],
                  parent_tag_names: [],
                }),
              ],
            }),
          })
        );

        const [group] = await run(service.getTagGroups());

        expect(group.tags).toEqual([]);
        expect(group.tagNames).toEqual([]);
      });

      it("getTagGroup should throw on empty response", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(run(service.getTagGroup(1))).rejects.toThrow(
          "Empty tag group response"
        );
      });

      it("createTagGroup should post normalized payload", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tag_group: validTagGroupPayload({
                id: 11,
                name: "New Group",
                tag_names: ["one"],
                parent_tag_names: ["root"],
                one_per_topic: true,
              }),
            }),
          })
        );

        const created = await run(
          service.createTagGroup({
            name: "New Group",
            tagNames: ["one"],
            parentTagNames: ["root"],
            onePerTopic: true,
            permissions: { staff: 1 },
          })
        );

        const [, options] = fetchMock.mock.calls[0];
        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/tag_groups.json",
          expect.any(Object)
        );
        expect(JSON.parse((options as any).body)).toEqual({
          tag_group: {
            name: "New Group",
            tag_names: ["one"],
            parent_tag_names: ["root"],
            one_per_topic: true,
            permissions: { staff: 1 },
          },
        });
        expect(created).toEqual(
          expect.objectContaining({
            id: 11,
            name: "New Group",
            tagNames: ["one"],
          })
        );
      });

      it("createTagGroup omits permissions when none are provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tag_group: validTagGroupPayload({ permissions: {} }),
            }),
          })
        );

        await run(
          service.createTagGroup({
            name: "No Perms",
            tagNames: [],
            parentTagNames: [],
            onePerTopic: false,
            permissions: {},
          })
        );

        const [, options] =
          fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
        const body = JSON.parse(String((options as any)?.body ?? "{}"));
        expect(body.tag_group.permissions).toBeUndefined();
      });

      it("createTagGroup should throw on empty response", async () => {
        fetchMock.mockResolvedValueOnce(makeRes({ json: async () => ({}) }));

        await expect(
          run(
            service.createTagGroup({
              name: "Empty",
            })
          )
        ).rejects.toThrow("Empty tag group response");
      });

      it("updateTagGroup should issue PUT with changes", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tag_group: validTagGroupPayload({
                id: 12,
                name: "Updated",
                tag_names: ["updated"],
              }),
            }),
          })
        );

        const updated = await run(
          service.updateTagGroup({
            tagGroupId: 12,
            name: "Updated",
            tagNames: ["updated"],
          })
        );

        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe("https://discuss.example.com/tag_groups/12.json");
        expect((options as any).method).toBe("PUT");
        expect(JSON.parse((options as any).body)).toEqual({
          tag_group: {
            name: "Updated",
            tag_names: ["updated"],
          },
        });
        expect(updated.id).toBe(12);
        expect(updated.tagNames).toEqual(["updated"]);
      });

      it("updateTagGroup sends permissions when provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              tag_group: validTagGroupPayload({
                id: 13,
                permissions: { staff: 1 },
              }),
            }),
          })
        );

        await run(
          service.updateTagGroup({
            tagGroupId: 13,
            name: "Permitted",
            permissions: { staff: 1 },
          })
        );

        const [, options] =
          fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
        const body = JSON.parse(String((options as any)?.body ?? "{}"));
        expect(body.tag_group.permissions).toEqual({ staff: 1 });
      });

      it("updateTagGroup should throw on empty response", async () => {
        fetchMock.mockResolvedValueOnce(makeRes({ json: async () => ({}) }));

        await expect(
          run(
            service.updateTagGroup({
              tagGroupId: 13,
              name: "Empty",
            })
          )
        ).rejects.toThrow("Empty tag group response");
      });

      it("should fetch site info with categories", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              site: {
                title: "Example Forum",
                description: "Welcome",
                logo_url: "https://discuss.example.com/logo.png",
                mobile_logo_url: null,
                favicon_url: "https://discuss.example.com/favicon.ico",
                contact_email: "team@example.com",
                canonical_hostname: "discuss.example.com",
                default_locale: "en",
              },
              categories: [validCategoryPayload({ id: 10, name: "General" })],
            }),
          })
        );

        const result = await run(service.getSiteInfo());

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/site.json",
          expect.any(Object)
        );
        expect(result.title).toBe("Example Forum");
        expect(result.categories[0].id).toBe(10);
      });

      it("maps site info when site object is missing and categories are provided", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              title: "Fallback Forum",
              description: null,
              logo_url: null,
              mobile_logo_url: null,
              favicon_url: null,
              contact_email: null,
              canonical_hostname: null,
              default_locale: null,
              categories: [validCategoryPayload({ id: 11, name: "Fallback" })],
            }),
          })
        );

        const result = await run(service.getSiteInfo());

        expect(result.title).toBe("Fallback Forum");
        expect(result.categories[0].id).toBe(11);
      });

      it("should fetch basic site info", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              site: {
                title: "Basic Forum",
                description: null,
                logo_url: null,
                mobile_logo_url: null,
                favicon_url: null,
                contact_email: null,
                canonical_hostname: "basic.example.com",
                default_locale: "en",
              },
            }),
          })
        );

        const result = await run(service.getSiteBasicInfo());

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/site/basic-info.json",
          expect.any(Object)
        );
        expect(result.title).toBe("Basic Forum");
        expect(result.canonicalHostname).toBe("basic.example.com");
      });

      it("normalizes site info when site payload is not an object", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              site: "not-an-object",
            }),
          })
        );

        const result = await run(service.getSiteBasicInfo());

        expect(result).toEqual({
          title: "",
          description: null,
          logoUrl: null,
          mobileLogoUrl: null,
          faviconUrl: null,
          contactEmail: null,
          canonicalHostname: null,
          defaultLocale: null,
        });
      });

      it("throws when site info responses are empty or malformed", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(run(service.getSiteInfo())).rejects.toThrow(
          "Empty site info response"
        );

        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              site: { title: "Bad", categories: { not: "an array" } },
              categories: "invalid",
            }),
          })
        );

        const malformed = await run(service.getSiteInfo());
        expect(malformed.categories).toEqual([]);
      });

      it("throws when basic site info is empty", async () => {
        fetchMock.mockResolvedValueOnce(emptyRes());

        await expect(run(service.getSiteBasicInfo())).rejects.toThrow(
          "Empty site basic info response"
        );
      });
    });

    describe("validateUserApiKey", () => {
      it("should report validation failure when API key is missing", async () => {
        const result = await run(service.validateUserApiKey(""));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: User API key is required",
          retryable: false,
        });
      });

      it("should fall back to validation catch when formatting fails", async () => {
        const formatSpy = vi
          .spyOn(utils, "formatError")
          .mockImplementationOnce(() => {
            throw new Error("format failed");
          })
          .mockImplementation(() => "formatted fallback");

        const thrower = new DiscourseService(
          "https://discuss.example.com",
          "test-api-key",
          "system"
        ) as any;

        vi.spyOn(thrower, "fetchApi").mockImplementation(async () => {
          throw new Error("fetch failed");
        });

        const result = await run(thrower.validateUserApiKey("any"));

        expect(result).toEqual({
          valid: false,
          error: "Validation failed: formatted fallback",
          retryable: true,
        });

        formatSpy.mockRestore();
      });

      it("should return user info when API key is valid", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              current_user: validUserPayload({ moderator: true }),
            }),
          })
        );

        const result = await run(service.validateUserApiKey("valid-key"));

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.example.com/session/current.json",
          expect.objectContaining({
            headers: expect.objectContaining({
              "User-Api-Key": "valid-key",
              "User-Api-Client-Id": "test-client",
            }),
          })
        );

        expect(result).toEqual({
          valid: true,
          user: {
            id: 1,
            username: "alice",
            name: "Alice",
            avatarTemplate: "/avatar.png",
            title: "Title",
            trustLevel: 2,
            moderator: true,
            admin: false,
          },
        });
      });

      it("should report invalid when API key fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 401, text: async () => "unauthorized" })
        );

        const result = await run(service.validateUserApiKey("bad-key"));

        expect(result).toEqual({
          valid: false,
          error: expect.stringContaining("401"),
          retryable: false,
        });
      });

      it("marks transient server errors as retryable", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 503, text: async () => "maintenance" })
        );

        const result = await run(service.validateUserApiKey("maybe-ok"));

        expect(result).toEqual({
          valid: false,
          error: expect.stringContaining("503"),
          retryable: true,
        });
      });

      it("should default optional user fields when validation succeeds", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({ current_user: { id: 9, username: "bob" } }),
          })
        );

        const result = await run(service.validateUserApiKey("valid"));

        expect(result).toEqual({
          valid: true,
          user: {
            id: 9,
            username: "bob",
            name: null,
            avatarTemplate: "",
            title: null,
            trustLevel: 0,
            moderator: false,
            admin: false,
          },
        });
      });

      it("should handle network failure gracefully", async () => {
        fetchMock.mockRejectedValueOnce(new Error("network down"));

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: network down",
          retryable: true,
        });
      });

      it("should handle non-error rejection gracefully", async () => {
        fetchMock.mockRejectedValueOnce("weird failure");

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: weird failure",
          retryable: false,
        });
      });

      it("should handle missing fields in validation error response", async () => {
        fetchMock.mockRejectedValueOnce({}); // non-Error object

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: [object Object]",
          retryable: false,
        });
      });

      it("treats fetch failures as retryable transport errors", async () => {
        fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: fetch failed",
          retryable: true,
        });
      });

      it("marks validation failures as non-retryable", async () => {
        fetchMock.mockRejectedValueOnce(new Error("validation failed: nope"));

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: validation failed: nope",
          retryable: false,
        });
      });

      it("treats non-transient errors as non-retryable", async () => {
        fetchMock.mockRejectedValueOnce(new Error("logic failure"));

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: logic failure",
          retryable: false,
        });
      });

      it("treats network code errors as retryable", async () => {
        const error = new Error("socket reset");
        (error as any).code = "ECONNRESET";
        fetchMock.mockRejectedValueOnce(error);

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: socket reset",
          retryable: true,
        });
      });

      it("treats abort errors as retryable", async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        const apiSpy = vi
          .spyOn(service as any, "fetchApi")
          .mockRejectedValueOnce(error);

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: aborted",
          retryable: true,
        });

        apiSpy.mockRestore();
      });

      it("treats fetch errors as retryable", async () => {
        const error = new Error("undici failed");
        error.name = "FetchError";
        fetchMock.mockRejectedValueOnce(error);

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: undici failed",
          retryable: true,
        });
      });

      it("should report invalid when current_user is missing", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({}),
          })
        );

        const result = await run(service.validateUserApiKey("bad-key"));

        expect(result).toEqual({
          valid: false,
          error: "Invalid response: no current_user",
          retryable: false,
        });
      });

      it("should report invalid when current_user is malformed", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            json: async () => ({
              current_user: { username: "no-id" },
            }),
          })
        );

        const result = await run(service.validateUserApiKey("weird-key"));

        expect(result).toEqual({
          valid: false,
          error: "Invalid response: malformed current_user",
          retryable: false,
        });
      });

      it("should still surface errors when message getters throw", async () => {
        class BoomError extends Error {
          get message(): string {
            throw new Error("getter boom");
          }
        }

        const thrower = new DiscourseService(
          "https://discuss.example.com",
          "test-api-key",
          "system"
        ) as any;

        vi.spyOn(thrower, "fetchApi").mockImplementation(() => {
          throw new BoomError();
        });

        const result = await run(thrower.validateUserApiKey("any"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: getter boom",
          retryable: false,
        });
      });

      it("should report validation failure errors", async () => {
        fetchMock.mockRejectedValueOnce(new Error("network down"));

        const result = await run(service.validateUserApiKey("bad"));
        expect(result).toEqual({
          valid: false,
          error: "API key invalid: network down",
          retryable: true,
        });
      });
    });
  })
);

describe("NonceManager cleanup", () => {
  const manager = new NonceManager();

  it("should remove expired nonces during cleanup", () => {
    const now = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const nonce = manager.create("client", "key");

    // advance time beyond TTL (10 minutes)
    dateSpy.mockReturnValue(now + 11 * 60 * 1000);
    manager.cleanup();

    expect(manager.get(nonce)).toBeNull();
    dateSpy.mockRestore();
  });

  it("get should evict and return null when nonce is expired", () => {
    const now = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const nonce = manager.create("client", "key");

    dateSpy.mockReturnValue(now + 11 * 60 * 1000);
    expect(manager.get(nonce)).toBeNull();
    expect(manager.verify(nonce, "client")).toBe(false);
    dateSpy.mockRestore();
  });

  it("should return false for expired nonce without cleanup", () => {
    const now = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const nonce = manager.create("client", "key");
    dateSpy.mockReturnValue(now + 11 * 60 * 1000);
    const isValid = manager.verify(nonce, "client");
    expect(isValid).toBe(false);
    dateSpy.mockRestore();
  });

  it("getPrivateKey should return null for unknown nonce", () => {
    expect(manager.getPrivateKey("missing")).toBeNull();
  });
});

describe("CryptoService decryptPayload", () => {
  const encrypted = Buffer.from(
    "ciphertext-with-sufficient-length".repeat(3)
  ).toString("base64");

  it("should decrypt payload and return key", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() =>
        Buffer.from(JSON.stringify({ key: "decrypted-key" }), "utf-8")
      );
    const cryptoService = new CryptoService(decryptFn as any);

    const result = await run(
      cryptoService.decryptPayload(encrypted, "private-key")
    );

    expect(result).toBe("decrypted-key");
  });

  it("should throw when decryption fails", async () => {
    const cryptoService = new CryptoService(vi.fn());
    await expect(
      run(cryptoService.decryptPayload("invalid-base64", "key"))
    ).rejects.toThrow();
  });

  it("should reject ciphertext that is too short", async () => {
    const cryptoService = new CryptoService(vi.fn());
    const tiny = Buffer.alloc(10).toString("base64");

    await expect(
      run(cryptoService.decryptPayload(tiny, "private-key"))
    ).rejects.toThrow("invalid ciphertext: unexpected length");
  });

  it("should reject ciphertext that is too long", async () => {
    const cryptoService = new CryptoService(vi.fn());
    const huge = Buffer.alloc(2048).toString("base64");

    await expect(
      run(cryptoService.decryptPayload(huge, "private-key"))
    ).rejects.toThrow("invalid base64: unexpected length");
  });

  it("should throw when decryption output is empty", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() => Buffer.from("{}", "utf-8"));
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(encrypted, "private-key"))
    ).rejects.toThrow("Decryption produced empty result");
  });

  it("should throw when decrypted data is empty payload", async () => {
    const decryptFn = vi.fn().mockImplementation(() => Buffer.alloc(0));
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(
        cryptoService.decryptPayload(Buffer.alloc(0).toString("base64"), "key")
      )
    ).rejects.toThrow("invalid base64: empty payload");
  });

  it("should throw when base64 is invalid", async () => {
    const cryptoService = new CryptoService(vi.fn());

    await expect(
      run(cryptoService.decryptPayload("@@@@", "key"))
    ).rejects.toThrow("invalid base64");
  });

  it("should throw when base64 decoding throws", async () => {
    const fromSpy = vi.spyOn(Buffer, "from").mockImplementation(() => {
      throw new Error("from failed");
    });

    const cryptoService = new CryptoService(vi.fn());

    await expect(
      run(cryptoService.decryptPayload("abcd", "key"))
    ).rejects.toThrow("invalid base64: from failed");

    fromSpy.mockRestore();
  });

  it("should throw when decrypted data is invalid JSON", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() => Buffer.from("not-json", "utf-8"));
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(encrypted, "private-key"))
    ).rejects.toThrow("invalid JSON");
  });

  it("should throw when decrypted JSON has no key field", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() =>
        Buffer.from(JSON.stringify({ foo: "bar" }), "utf-8")
      );
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(encrypted, "private-key"))
    ).rejects.toThrow("Decryption produced empty result");
  });

  it("should reject non-string decrypted keys", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() =>
        Buffer.from(JSON.stringify({ key: 42 }), "utf-8")
      );
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(encrypted, "private-key"))
    ).rejects.toThrow("Decryption produced empty result");
  });

  it("should surface decryption failures via catch handler", async () => {
    const decryptFn = vi.fn().mockImplementation(() => {
      throw new Error("bad decrypt");
    });
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(encrypted, "private-key"))
    ).rejects.toThrow("invalid ciphertext");
  });

  it("should allow configurable ciphertext size bounds", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() =>
        Buffer.from(JSON.stringify({ key: "custom" }), "utf-8")
      );
    const cryptoService = new CryptoService(decryptFn as any, {
      minCiphertextBytes: 32,
      maxCiphertextBytes: 2048,
    });
    const largePayload = Buffer.alloc(1500).toString("base64");

    const result = await run(
      cryptoService.decryptPayload(largePayload, "private-key")
    );

    expect(result).toBe("custom");
    expect(decryptFn).toHaveBeenCalled();
  });
});

describe("CryptoService", () => {
  const service = new CryptoService();

  describe("generateKeyPair", () => {
    it("should generate RSA key pair", async () => {
      const result = await run(service.generateKeyPair());

      expect(result.publicKey).toContain("BEGIN PUBLIC KEY");
      expect(result.privateKey).toContain("BEGIN PRIVATE KEY");
      expect(result.publicKey).not.toBe(result.privateKey);
    });
  });
});

describe("NonceCapacityError", () => {
  it("should format a client-scoped capacity message", () => {
    const error = new NonceCapacityError({
      limitType: "client",
      limit: 2,
      clientId: "client-x",
    });

    expect(error.message).toContain("client client-x");
    expect(error.limitType).toBe("client");
    expect(error.limit).toBe(2);
    expect(error.clientId).toBe("client-x");
  });

  it("should format a global capacity message", () => {
    const error = new NonceCapacityError({ limitType: "global", limit: 5 });

    expect(error.message).toContain("global limit: 5");
    expect(error.limitType).toBe("global");
    expect(error.limit).toBe(5);
    expect(error.clientId).toBeUndefined();
  });

  it("should fall back to unknown client when clientId is missing", () => {
    const error = new NonceCapacityError({ limitType: "client", limit: 3 });

    expect(error.message).toContain("client unknown");
    expect(error.limitType).toBe("client");
    expect(error.limit).toBe(3);
    expect(error.clientId).toBeUndefined();
  });
});

describe("NonceManager", () => {
  const manager = new NonceManager();

  describe("create and verify", () => {
    it("should create and verify valid nonce", () => {
      const nonce = manager.create("test-client", "test-private-key");

      expect(nonce).toBeDefined();
      expect(typeof nonce).toBe("string");
      expect(nonce.length).toBeGreaterThan(0);

      const isValid = manager.verify(nonce, "test-client");
      expect(isValid).toBe(true);
    });

    it("should reject invalid nonce", () => {
      const isValid = manager.verify("invalid-nonce", "test-client");
      expect(isValid).toBe(false);
    });

    it("should reject mismatched client ID", () => {
      const nonce = manager.create("client-1", "test-key");
      const isValid = manager.verify(nonce, "client-2");
      expect(isValid).toBe(false);
    });

    it("trims client ids before storing and verifying", () => {
      const nonce = manager.create("  client-3  ", "test-key");
      expect(manager.verify(nonce, "client-3")).toBe(true);
      expect(manager.verify(nonce, "  client-3 ")).toBe(true);
    });

    it("rejects empty client ids and private keys", () => {
      expect(() => manager.create("   ", "key")).toThrow(
        "clientId is required"
      );
      expect(() => manager.create("client", "   ")).toThrow(
        "privateKey is required"
      );
    });

    it("rejects non-string private keys", () => {
      expect(() => manager.create("client", 123 as any)).toThrow(
        "privateKey is required"
      );
    });

    it("returns false when verifying with invalid client id input", () => {
      const nonce = manager.create("client-id", "key");
      expect(manager.verify(nonce, "   ")).toBe(false);
    });
  });

  describe("get", () => {
    it("should retrieve nonce data", () => {
      const privateKey = "test-private-key-123";
      const clientId = "test-client";
      const nonce = manager.create(clientId, privateKey);

      const data = manager.get(nonce);
      expect(data).toBeDefined();
      expect(data?.clientId).toBe(clientId);
      expect(data?.privateKey).toBe(privateKey);
      expect(data?.timestamp).toBeDefined();
    });

    it("should return null for invalid nonce", () => {
      const data = manager.get("invalid-nonce");
      expect(data).toBeNull();
    });
  });

  describe("getPrivateKey", () => {
    it("should retrieve private key for valid nonce", () => {
      const privateKey = "test-private-key-123";
      const nonce = manager.create("test-client", privateKey);

      const retrieved = manager.getPrivateKey(nonce);
      expect(retrieved).toBe(privateKey);
    });

    it("should return null for expired nonce", () => {
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const nonce = manager.create("expiring-client", "expired-key");

      dateSpy.mockReturnValue(now + 11 * 60 * 1000);
      expect(manager.getPrivateKey(nonce)).toBeNull();
      dateSpy.mockRestore();
    });
  });

  describe("getExpiration", () => {
    it("should return expiration timestamp for active nonce", () => {
      const now = 1000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const ttl = 5000;
      const expiringManager = new NonceManager(ttl);

      const nonce = expiringManager.create("client", "key");
      const expiration = expiringManager.getExpiration(nonce);

      expect(expiration).toBe(now + ttl);
      dateSpy.mockRestore();
    });

    it("should return null for expired nonce", () => {
      const now = 0;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const expiringManager = new NonceManager(1000);

      const nonce = expiringManager.create("client", "key");
      dateSpy.mockReturnValue(now + 2001);

      expect(expiringManager.getExpiration(nonce)).toBeNull();
      dateSpy.mockRestore();
    });
  });

  describe("introspection helpers", () => {
    it("ignores non-matching clients when computing next expiration", () => {
      const now = Date.now();
      const expiringManager = new NonceManager({ ttlMs: 1000 });
      (expiringManager as any).nonces = new Map<string, any>([
        ["nonce-1", { clientId: "client-a", privateKey: "k1", timestamp: now }],
      ]);

      expect(expiringManager.getNextExpiration("client-b")).toBeNull();
    });

    it("removes entries that expire between cleanup and iteration", () => {
      const manager = new NonceManager({ ttlMs: 1000 });
      const dateSpy = vi.spyOn(Date, "now");
      dateSpy.mockReturnValueOnce(0);
      const nonce = manager.create("client", "key");

      dateSpy.mockReturnValueOnce(500);
      dateSpy.mockReturnValueOnce(2001);

      const next = manager.getNextExpiration("client");

      expect(manager.verify(nonce, "client")).toBe(false);
      expect(next).toBeNull();
      dateSpy.mockRestore();
    });

    it("returns the earliest expiration for a client", () => {
      const now = 10;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const ttlMs = 1000;
      const expiringManager = new NonceManager({ ttlMs, maxPerClient: 2 });

      const first = expiringManager.create("client", "key-1");
      dateSpy.mockReturnValue(now + 1);
      const second = expiringManager.create("client", "key-2");

      expect(expiringManager.getNextExpiration("client")).toBe(now + ttlMs);
      expect(expiringManager.getExpiration(first)).toBe(now + ttlMs);
      expect(expiringManager.getExpiration(second)).toBe(now + 1 + ttlMs);

      dateSpy.mockRestore();
    });

    it("derives retry-after duration from existing nonces", () => {
      const now = 50;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const ttlMs = 2000;
      const expiringManager = new NonceManager({ ttlMs, maxPerClient: 1 });

      expiringManager.create("client", "key-1");
      dateSpy.mockReturnValue(now + 250);

      expect(expiringManager.getRetryAfterMs("client")).toBe(ttlMs - 250);
      dateSpy.mockRestore();
    });

    it("normalizes client ids before computing retry-after", () => {
      const now = 1000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const ttlMs = 500;
      const expiringManager = new NonceManager({ ttlMs });

      expiringManager.create("client-a", "key");

      dateSpy.mockReturnValue(now + 200);
      expect(expiringManager.getRetryAfterMs("   ")).toBe(300);
      dateSpy.mockRestore();
    });

    it("returns null retry-after when no nonces are present", () => {
      const expiringManager = new NonceManager({ ttlMs: 2000 });
      expect(expiringManager.getRetryAfterMs()).toBeNull();
    });

    it("ignores expired nonces when computing retry-after", () => {
      const now = 0;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const expiringManager = new NonceManager({ ttlMs: 1000 });

      expiringManager.create("client", "key");
      dateSpy.mockReturnValue(now + 1500);

      expect(expiringManager.getRetryAfterMs("client")).toBeNull();
      dateSpy.mockRestore();
    });
  });

  describe("consume", () => {
    it("should remove nonce after consumption", () => {
      const nonce = manager.create("test-client", "test-key");
      expect(manager.verify(nonce, "test-client")).toBe(true);

      manager.consume(nonce);
      expect(manager.verify(nonce, "test-client")).toBe(false);
    });
  });

  describe("configuration", () => {
    it("should honor a custom TTL", () => {
      const shortLivedManager = new NonceManager(50);
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const nonce = shortLivedManager.create("client", "key");

      dateSpy.mockReturnValue(now + 75);
      expect(shortLivedManager.verify(nonce, "client")).toBe(false);
      dateSpy.mockRestore();
    });

    it("should fall back to default TTL when provided value is invalid", () => {
      const defaultedManager = new NonceManager(-1);
      const now = Date.now();
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const nonce = defaultedManager.create("client", "key");

      dateSpy.mockReturnValue(now + 5 * 60 * 1000);
      expect(defaultedManager.verify(nonce, "client")).toBe(true);
      dateSpy.mockRestore();
    });
  });

  describe("capacity controls", () => {
    it("should evict oldest per client and throw when per-client limit is exceeded", () => {
      const limitedManager = new NonceManager({ ttlMs: 1000, maxPerClient: 2 });
      const now = 1000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);

      const first = limitedManager.create("client", "k1");
      dateSpy.mockReturnValue(now + 1);
      const second = limitedManager.create("client", "k2");

      dateSpy.mockReturnValue(now + 2);
      expect(() => limitedManager.create("client", "k3")).toThrow(
        NonceCapacityError
      );

      expect(limitedManager.verify(first, "client")).toBe(false);
      expect(limitedManager.verify(second, "client")).toBe(true);

      dateSpy.mockReturnValue(now + 3);
      const replacement = limitedManager.create("client", "k4");
      expect(limitedManager.verify(replacement, "client")).toBe(true);

      dateSpy.mockRestore();
    });

    it("should evict oldest globally and throw when total limit is exceeded", () => {
      const limitedManager = new NonceManager({ ttlMs: 1000, maxTotal: 3 });
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(0);

      const first = limitedManager.create("c1", "k1");
      dateSpy.mockReturnValue(1);
      const second = limitedManager.create("c2", "k2");
      dateSpy.mockReturnValue(2);
      const third = limitedManager.create("c3", "k3");

      dateSpy.mockReturnValue(3);
      expect(() => limitedManager.create("c4", "k4")).toThrow(
        NonceCapacityError
      );

      expect(limitedManager.verify(first, "c1")).toBe(false);
      expect(limitedManager.verify(second, "c2")).toBe(true);
      expect(limitedManager.verify(third, "c3")).toBe(true);

      dateSpy.mockReturnValue(4);
      const fresh = limitedManager.create("c5", "k5");
      expect(limitedManager.verify(fresh, "c5")).toBe(true);
      expect(limitedManager.verify(second, "c2")).toBe(true);

      dateSpy.mockRestore();
    });

    it("should return false when eviction predicate never matches", () => {
      const resilientManager = new NonceManager({ ttlMs: 1000 });
      const now = Date.now();
      (resilientManager as any).nonces.set("nonce-1", {
        clientId: "client-a",
        privateKey: "k1",
        timestamp: now,
      });

      const didEvict = (resilientManager as any).evictOldest(
        (entry: { clientId: string }) => entry.clientId === "client-b"
      );

      expect(didEvict).toBe(false);
      expect((resilientManager as any).nonces.size).toBe(1);
    });

    it("should stop eviction loop when no entries can be removed for a client", () => {
      const resilientManager = new NonceManager({
        ttlMs: 1000,
        maxPerClient: 1,
      });
      const now = Date.now();
      (resilientManager as any).nonces = new Map<string, any>([
        ["nonce-1", { clientId: "client", privateKey: "k1", timestamp: now }],
        [
          "nonce-2",
          { clientId: "client", privateKey: "k2", timestamp: now + 1 },
        ],
      ]);

      const evictSpy = vi
        .spyOn(resilientManager as any, "evictOldest")
        .mockReturnValue(false);

      (resilientManager as any).evictForClient("client", 0);

      expect(evictSpy).toHaveBeenCalledTimes(1);
      expect((resilientManager as any).nonces.size).toBe(2);
    });

    it("should no-op when evicting for client with negative limit", () => {
      const resilientManager = new NonceManager({ ttlMs: 1000 });
      const now = Date.now();
      (resilientManager as any).nonces.set("nonce-1", {
        clientId: "client",
        privateKey: "k1",
        timestamp: now,
      });

      (resilientManager as any).evictForClient("client", -1);

      expect((resilientManager as any).nonces.size).toBe(1);
    });

    it("should evict globally down to the provided limit", () => {
      const resilientManager = new NonceManager({ ttlMs: 1000 });
      const now = Date.now();
      (resilientManager as any).nonces = new Map<string, any>([
        ["nonce-1", { clientId: "a", privateKey: "k1", timestamp: now }],
        ["nonce-2", { clientId: "b", privateKey: "k2", timestamp: now + 1 }],
      ]);

      (resilientManager as any).evictGlobally(1);

      expect((resilientManager as any).nonces.size).toBe(1);
      expect(Array.from((resilientManager as any).nonces.keys())).toEqual([
        "nonce-2",
      ]);
    });

    it("should ignore global eviction when limit is negative", () => {
      const resilientManager = new NonceManager({ ttlMs: 1000 });
      const now = Date.now();
      (resilientManager as any).nonces = new Map<string, any>([
        ["nonce-1", { clientId: "a", privateKey: "k1", timestamp: now }],
      ]);

      (resilientManager as any).evictGlobally(-1);

      expect((resilientManager as any).nonces.size).toBe(1);
    });

    it("should stop global eviction when no entries can be removed", () => {
      const resilientManager = new NonceManager({ ttlMs: 1000 });
      const now = Date.now();
      (resilientManager as any).nonces = new Map<string, any>([
        ["nonce-1", { clientId: "a", privateKey: "k1", timestamp: now }],
      ]);

      const evictSpy = vi
        .spyOn(resilientManager as any, "evictOldest")
        .mockReturnValue(false);

      const result = (resilientManager as any).evictGlobally(0);

      expect(result).toBe(false);
      expect(evictSpy).toHaveBeenCalledTimes(1);
      expect((resilientManager as any).nonces.size).toBe(1);
    });

    it("should evict oldest per client and accept new when strategy is evictOldest", () => {
      const now = 0;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      const manager = new NonceManager({
        ttlMs: 1000,
        maxPerClient: 2,
        limitStrategy: { perClient: "evictOldest" },
      });

      const first = manager.create("client", "k1");
      dateSpy.mockReturnValue(now + 1);
      const second = manager.create("client", "k2");

      dateSpy.mockReturnValue(now + 2);
      const third = manager.create("client", "k3");

      expect(manager.verify(first, "client")).toBe(false);
      expect(manager.verify(second, "client")).toBe(true);
      expect(manager.verify(third, "client")).toBe(true);
      dateSpy.mockRestore();
    });

    it("should evict oldest globally and accept new when strategy is evictOldest", () => {
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(0);
      const manager = new NonceManager({
        ttlMs: 1000,
        maxTotal: 2,
        limitStrategy: { global: "evictOldest" },
      });

      const first = manager.create("c1", "k1");
      dateSpy.mockReturnValue(1);
      const second = manager.create("c2", "k2");

      dateSpy.mockReturnValue(2);
      const third = manager.create("c3", "k3");

      expect(manager.verify(first, "c1")).toBe(false);
      expect(manager.verify(second, "c2")).toBe(true);
      expect(manager.verify(third, "c3")).toBe(true);
      dateSpy.mockRestore();
    });

    it("invokes eviction hook with structured counts", () => {
      const events: any[] = [];
      const manager = new NonceManager({
        ttlMs: 10000,
        maxPerClient: 1,
        maxTotal: 2,
        limitStrategy: { perClient: "evictOldest", global: "evictOldest" },
        onEvict: (event) => events.push(event),
      });

      manager.create("client-a", "k1");
      manager.create("client-a", "k2");

      expect(events).toEqual([
        { type: "client", clientId: "client-a", count: 1 },
      ]);

      manager.create("client-b", "k3");
      manager.create("client-c", "k4");

      expect(events).toEqual([
        { type: "client", clientId: "client-a", count: 1 },
        { type: "global", count: 1 },
      ]);
    });
  });
});
describe("noopLogger", () => {
  it("should expose no-op warn and info helpers", () => {
    expect(() => {
      noopLogger.warn?.("warn message");
      noopLogger.info?.("info message");
    }).not.toThrow();
  });
});

describe("createSafeLogger", () => {
  it("should swallow logger failures while still invoking handlers", () => {
    const throwingLogger = {
      error: vi.fn(() => {
        throw new Error("error boom");
      }),
      warn: vi.fn(() => {
        throw new Error("warn boom");
      }),
      info: vi.fn(() => {
        throw new Error("info boom");
      }),
      debug: vi.fn(() => {
        throw new Error("debug boom");
      }),
    };

    const safeLogger = createSafeLogger(throwingLogger);

    expect(() =>
      safeLogger.info!("info message", { foo: "bar" })
    ).not.toThrow();
    expect(() => safeLogger.error("error message")).not.toThrow();
    expect(throwingLogger.info).toHaveBeenCalledTimes(1);
    expect(throwingLogger.error).toHaveBeenCalledTimes(1);
  });

  it("should provide no-op functions when optional levels are missing", () => {
    const partialLogger = { error: vi.fn() } as any;
    const safeLogger = createSafeLogger(partialLogger);

    expect(() => safeLogger.warn?.("warned")).not.toThrow();
    expect(() => safeLogger.debug?.("debugged")).not.toThrow();
    expect(partialLogger.error).not.toHaveBeenCalledWith("warned");
  });

  it("should fall back to noop when required handlers are absent", () => {
    const safeLogger = createSafeLogger({} as any);
    expect(() => safeLogger.error("still works")).not.toThrow();
  });
});

describe("normalizeMeta", () => {
  it("preserves serialized error objects without dropping stack traces", () => {
    const serialized = { message: "boom", stack: "trace" };
    const result = utils.normalizeMeta({ error: serialized, context: "test" });

    expect(result).toEqual({ error: serialized, context: "test" });
  });

  it("serializes error-like values when needed", () => {
    const err = new Error("kapow");
    const result = utils.normalizeMeta({ reason: err });

    expect(result?.reason).toEqual({
      message: "kapow",
      stack: err.stack,
    });
  });
});
