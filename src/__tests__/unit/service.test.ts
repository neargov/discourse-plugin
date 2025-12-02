import { Effect } from "every-plugin/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verify } from "near-sign-verify";
import * as utils from "../../utils";
import { mapDiscourseApiError, mapPluginError } from "../../index";
import { DiscourseApiError } from "../../service";
import type { DiscourseApiError as DiscourseApiErrorType } from "../../service";
vi.mock("near-sign-verify", () => ({
  verify: vi.fn(),
}));

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

type RunEffect = <A, E = unknown>(eff: Effect.Effect<A, E, never>) => Promise<A>;
const run: RunEffect = (eff) => Effect.runPromise(eff);

const makeErrors = () => {
  const tooManyRequests = vi.fn((payload: any) => ({ code: "TOO_MANY", payload })) as any;
  const serviceUnavailable = vi.fn((payload: any) => ({
    code: "SERVICE_UNAVAILABLE",
    payload,
  })) as any;

  return {
    hooks: { tooManyRequests, serviceUnavailable },
    errors: {
      TOO_MANY_REQUESTS: tooManyRequests,
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
  const extractDiscourseError = (error: unknown): DiscourseApiErrorType | undefined => {
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
        expect(String(discError.bodySnippet ?? "")).toContain(expected.bodyIncludes);
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

const validPostPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 5,
  topic_id: 10,
  post_number: 1,
  username: "alice",
  name: "Alice",
  avatar_template: "/avatar.png",
  raw: "raw content",
  cooked: "<p>Cooked</p>",
  created_at: "2024-01-01",
  updated_at: "2024-01-02",
  reply_count: 0,
  like_count: 1,
  reply_to_post_number: null,
  can_edit: true,
  version: 2,
  ...overrides,
});

const validTopicPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 10,
  title: "Topic Title",
  slug: "topic-title",
  category_id: 3,
  created_at: "2024-01-01",
  last_posted_at: "2024-01-02",
  posts_count: 2,
  reply_count: 1,
  like_count: 5,
  views: 100,
  pinned: false,
  closed: false,
  archived: false,
  visible: true,
  ...overrides,
});

const validCategoryPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 10,
  name: "General",
  slug: "general",
  description: null,
  color: "fff",
  topic_count: 1,
  post_count: 1,
  parent_category_id: null,
  read_restricted: false,
  ...overrides,
});

const validUserPayload = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  username: "alice",
  name: "Alice",
  avatar_template: "/avatar.png",
  title: "Title",
  trust_level: 2,
  moderator: false,
  admin: false,
  ...overrides,
});

const baseSearchResponse = {
  posts: [
    {
      id: 1,
      topic_id: 2,
      post_number: 1,
      username: "alice",
      name: "Alice",
      avatar_template: "/avatar.png",
      cooked: "<p>Hi</p>",
      created_at: "2024-01-01",
      updated_at: "2024-01-02",
      reply_count: 0,
      like_count: 1,
      reply_to_post_number: null,
      topic: { title: "Topic Title" },
      blurb: "snippet",
    },
  ],
  topics: [
    {
      id: 2,
      title: "Topic Title",
      slug: "topic-title",
      category_id: 10,
      created_at: "2024-01-01",
      last_posted_at: "2024-01-02",
      posts_count: 1,
      reply_count: 0,
      like_count: 1,
      views: 10,
      pinned: false,
      closed: false,
      archived: false,
      visible: true,
    },
  ],
  users: [validUserPayload()],
  categories: [validCategoryPayload()],
  grouped_search_result: {
    post_ids: [1],
    more_full_page_results: "more",
  },
};

const validSearchResponse = (
  overrides: Partial<Record<string, unknown>> = {}
) => ({
  posts: baseSearchResponse.posts.map((p) => ({
    ...p,
    topic: p.topic ? { ...p.topic } : undefined,
  })),
  topics: baseSearchResponse.topics.map((t) => ({ ...t })),
  users: baseSearchResponse.users.map((u) => ({ ...u })),
  categories: baseSearchResponse.categories.map((c) => ({ ...c })),
  grouped_search_result: { ...baseSearchResponse.grouped_search_result },
  ...overrides,
});

const {
  DiscourseService,
  CryptoService,
  NEARService,
  NonceManager,
  NonceCapacityError,
  LinkageStore,
  noopLogger,
  createSafeLogger,
} = await import("../../service");

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
        handlers[hook].mock.results[handlers[hook].mock.results.length - 1]?.value;
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

  it("maps server errors to SERVICE_UNAVAILABLE", () => {
    const { errors, hooks } = makeErrors();
    const mapped = { mapped: true };
    hooks.serviceUnavailable.mockReturnValueOnce(mapped as any);

    const error = new DiscourseApiError({
      status: 503,
      path: "/maintenance",
      method: "GET",
      requestId: "req-2",
    });

    const result = mapDiscourseApiError(error, errors);

    expect(result).toBe(mapped);
    expect(hooks.serviceUnavailable).toHaveBeenCalledWith({
      message: error.message,
      data: {
        status: 503,
        path: "/maintenance",
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
    expect(mapDiscourseApiError(apiError, { ...errors, TOO_MANY_REQUESTS: undefined })).toBe(
      apiError
    );
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
      status: 503,
      path: "/maintenance",
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

describe(
  "DiscourseService",
  withFetch((fetchMock) => {
    const service = new DiscourseService(
      "https://discuss.near.vote",
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
          })
        );

        expect(result).toContain("https://discuss.near.vote/user-api-key/new");
        expect(result).toContain("client_id=test-client");
        expect(result).toContain("application_name=Test%20App");
        expect(result).toContain("nonce=test-nonce");
        expect(result).toContain("scopes=read%2Cwrite");
      });

      it("should include nested base paths without double slashes", async () => {
        const serviceWithPath = new DiscourseService(
          "https://discuss.near.vote/community/",
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
          })
        );

        expect(result).toContain(
          "https://discuss.near.vote/community/user-api-key/new"
        );
      });

      it("should reject invalid base URLs early", () => {
        expect(
          () => new DiscourseService("not-a-url", "k", "user")
        ).toThrow("Invalid Discourse base URL");
      });
    });

    describe("checkHealth", () => {
      it("uses bounded default timeout when provided value is invalid", async () => {
        const fetchApiSpy = vi
          .spyOn(service as any, "fetchApi")
          .mockResolvedValue(undefined);

        const result = await service.checkHealth({ timeoutMs: -10 });

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

        const result = await service.checkHealth({ timeoutMs: 1000 });

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
          "https://discuss.near.vote/session/current.json",
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
          "https://discuss.near.vote/path",
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
          "https://discuss.near.vote",
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
            text: async () => "{\"ok\":true}",
          })
        );

        const result = await serviceWithAgent.fetchApi("/path");

        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1500);
        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.near.vote/path",
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
          "https://discuss.near.vote/",
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
          "https://discuss.near.vote/path",
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
          Object.keys(sentHeaders).filter((key) => key.toLowerCase() === "accept")
        ).toHaveLength(1);
        expect(sentHeaders.ACCEPT).toBe("text/custom");
        expect(sentHeaders["USER-API-KEY"]).toBe("from-header");
        expect(sentHeaders["User-Api-Client-Id"]).toBe("test-client");
        expect(
          Object.keys(sentHeaders).some((key) => key.toLowerCase() === "api-key")
        ).toBe(false);
        expect(
          Object.keys(sentHeaders).filter((key) => key.toLowerCase() === "content-type")
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
          Object.keys(sentHeaders).some((key) => key.toLowerCase() === "api-key")
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
          "https://discuss.near.vote/path-without-slash",
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
            text: async () => "{\"ok\":true}",
          })
        );

        const result = await callFetch("/path", { timeoutMs: 0 });

        expect(result).toEqual({ ok: true });
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
        timeoutSpy.mockRestore();
      });

      it("returns raw body when not json", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ headers: undefined, text: async () => '{"data":42}' })
        );

        const result = await callFetch();
        expect(result).toBe('{"data":42}');
      });

      it("parses structured application/*+json responses", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) =>
                key === "content-type" ? "application/problem+json" : null,
            },
            text: async () => "{\"problem\":\"details\"}",
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

        await expect(callFetch()).rejects.toThrow("Failed to read response body: boom reading body");
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
        expect(clearSpy).toHaveBeenCalledTimes(1);
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
          /Failed to parse JSON from https:\/\/discuss\.near\.vote\/long-json: .*body snippet: x{200}…/
        );
      });

      it("surfaces JSON parse errors with short bodies without truncation", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: { get: (key: string) => (key ? "application/json" : null) },
            text: async () => "{oops",
          })
        );

        await expect(callFetch("/short-json")).rejects.toThrow(
          /Failed to parse JSON from https:\/\/discuss\.near\.vote\/short-json: .*body snippet: {oops$/
        );
      });

      it("truncates very long bodies when JSON parse fails", async () => {
        const veryLong = "y".repeat(1500);
        fetchMock.mockResolvedValueOnce(
          makeRes({
            headers: {
              get: (key: string) => (key === "content-type" ? "application/json" : null),
            },
            text: async () => veryLong,
          })
        );

        await expect(callFetch("/huge-json")).rejects.toThrow(
          /Failed to parse JSON from https:\/\/discuss\.near\.vote\/huge-json: .*body snippet: y{200}…/
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
          "Request to https://discuss.near.vote/path timed out after 5ms"
        );
      });

      it("ignores logger errors when response not ok", async () => {
        const noisyLogger = {
          error: () => {
            throw new Error("logger boom");
          },
        } as any;
        const noisyService = new DiscourseService(
          "https://discuss.near.vote",
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

        await expectDiscourseApiError(
          () => noisyService.fetchApi("/fail"),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/fail",
            bodyIncludes: "err",
          }
        );
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

        await expectDiscourseApiError(
          () => callFetch("/unreadable"),
          {
            status: 503,
            method: "GET",
            pathIncludes: "/unreadable",
            bodyIncludes: "[body unavailable: unreadable]",
          }
        );
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
          "Discourse API error (GET 502): https://discuss.near.vote/empty-body"
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
        expect(error?.message).toContain("https://discuss.near.vote/with-request-id");
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

        const delay = (service as any).computeDelayMs(new Error("no-retry-after"), 2);

        expect(delay).toBe(1100);
        randomSpy.mockRestore();
      });

      it("normalizes retry policy overrides to safe defaults", () => {
        const policyService = new DiscourseService(
          "https://discuss.near.vote",
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

      it("logs retries and skips waiting when delay is non-positive", async () => {
        const retryService = new DiscourseService(
          "https://discuss.near.vote",
          "api-key",
          "system",
          noopLogger,
          { retryPolicy: { maxRetries: 1 } }
        ) as any;
        const error = new DiscourseApiError({
          status: 503,
          path: "/retry",
          method: "GET",
          retryAfterMs: 0,
        });
        const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("ok");
        const computeSpy = vi.spyOn(retryService, "computeDelayMs").mockReturnValue(0);
        const logSpy = vi.spyOn(retryService, "logRequest");
        const sleepSpy = vi.spyOn(retryService, "sleep");

        const result = await retryService.runWithRetry(() => fn(), {
          url: "/retry",
          method: "GET",
        });

        expect(result).toBe("ok");
        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 503,
            retryDelayMs: 0,
            outcome: "retry",
          })
        );
        expect(sleepSpy).toHaveBeenCalledWith(0);

        computeSpy.mockRestore();
        logSpy.mockRestore();
        sleepSpy.mockRestore();
      });

      it("retries server errors without retry-after metadata", async () => {
        const retryService = new DiscourseService(
          "https://discuss.near.vote",
          "api-key",
          "system",
          noopLogger,
          { retryPolicy: { maxRetries: 1 } }
        ) as any;

        const error = new DiscourseApiError({
          status: 500,
          path: "/retry-no-header",
          method: "GET",
        });

        const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("ok");
        const computeSpy = vi.spyOn(retryService, "computeDelayMs").mockReturnValue(0);
        const sleepSpy = vi.spyOn(retryService, "sleep").mockResolvedValue(undefined);

        const result = await retryService.runWithRetry(() => fn(), {
          url: "/retry-no-header",
          method: "GET",
        });

        expect(result).toBe("ok");
        expect(computeSpy).toHaveBeenCalledWith(error, 0);
        expect(sleepSpy).toHaveBeenCalledWith(0);

        computeSpy.mockRestore();
        sleepSpy.mockRestore();
      });

      it("retries generic transport errors once", async () => {
        const retryService = new DiscourseService(
          "https://discuss.near.vote",
          "api-key",
          "system",
          noopLogger,
          { retryPolicy: { maxRetries: 1 } }
        ) as any;

        const transportError = new Error("network down");
        const fn = vi.fn().mockRejectedValueOnce(transportError).mockResolvedValueOnce("ok");
        const computeSpy = vi.spyOn(retryService, "computeDelayMs").mockReturnValue(0);
        const sleepSpy = vi.spyOn(retryService, "sleep").mockResolvedValue(undefined);

        const result = await retryService.runWithRetry(() => fn(), {
          url: "/retry-transport",
          method: "GET",
        });

        expect(result).toBe("ok");
        expect(computeSpy).toHaveBeenCalledWith(transportError, 0);
        expect(sleepSpy).toHaveBeenCalledWith(0);

        computeSpy.mockRestore();
        sleepSpy.mockRestore();
      });

      it("captures status when retry logging is triggered", async () => {
        const retryService = new DiscourseService(
          "https://discuss.near.vote",
          "api-key",
          "system",
          noopLogger,
          { retryPolicy: { maxRetries: 1 } }
        ) as any;
        const error = new DiscourseApiError({
          status: 429,
          path: "/retry",
          method: "GET",
          retryAfterMs: 10,
        });
        const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("ok");
        const logSpy = vi.spyOn(retryService, "logRequest");
        const sleepSpy = vi.spyOn(retryService, "sleep").mockResolvedValue(undefined as any);

        await retryService.runWithRetry(() => fn(), { url: "/retry", method: "GET" });

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 429,
            outcome: "retry",
          })
        );
        expect(sleepSpy).toHaveBeenCalled();

        logSpy.mockRestore();
        sleepSpy.mockRestore();
      });
    });

    describe("url helpers", () => {
      it("normalizes trailing base slashes and resolves paths", () => {
        const slashService = new DiscourseService(
          "https://discuss.near.vote/",
          "api-key",
          "system"
        );

        expect(slashService.getNormalizedBaseUrl()).toBe("https://discuss.near.vote");
        expect(slashService.resolvePath("/t/topic/1")).toBe(
          "https://discuss.near.vote/t/topic/1"
        );
        expect(slashService.resolvePath("https://other.host/path")).toBe(
          "https://other.host/path"
        );
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
          "https://discuss.near.vote/posts.json",
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
          "https://discuss.near.vote/posts/11.json",
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
          "https://discuss.near.vote/search.json?q=hello+%23general+%40alice+tags%3Atag1+before%3A2024-02-01+after%3A2023-12-01+order%3Alatest+status%3Aopen+in%3Atitle&page=2",
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
          "https://discuss.near.vote/search.json?q=messy+search&page=1",
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
          .mockResolvedValueOnce(makeRes({ json: async () => validPostPayload() }))
          .mockResolvedValueOnce(makeRes({ json: async () => validTopicPayload() }));

        const result = await run(service.getPost(5, true));

        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          "https://discuss.near.vote/posts/5.json",
          expect.any(Object)
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          "https://discuss.near.vote/t/10.json",
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
          .mockResolvedValueOnce(makeRes({ json: async () => validTopicPayload({ id: 25 }) }));

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
          "https://discuss.near.vote/posts/5/replies.json",
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
          "https://discuss.near.vote/c/3/l/latest.json?page=2&order=activity",
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
                topics: [validTopicPayload({ id: 7, title: "No Page", slug: "no-page" })],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getLatestTopics({ categoryId: 5, page: 0, order: "default" })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.near.vote/c/5/l/latest.json",
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
            service.getLatestTopics({ categoryId: 3, page: 2, order: "activity" })
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
          "https://discuss.near.vote/latest.json",
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
                topics: [validTopicPayload({ id: 42, title: "Ordered", slug: "ordered" })],
                more_topics_url: "/more-ordered",
              },
            }),
          })
        );

        const result = await run(
          service.getLatestTopics({ page: 2, order: "activity" })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.near.vote/latest.json?page=2&order=activity",
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
          "https://discuss.near.vote/latest.json",
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
          "https://discuss.near.vote/c/7/l/top/weekly.json?page=1",
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
          "https://discuss.near.vote/top/weekly.json",
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
                topics: [validTopicPayload({ id: 11, title: "Paged Top", slug: "paged-top" })],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopTopics({ period: "weekly", page: 2 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.near.vote/top/weekly.json?page=2",
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
          "https://discuss.near.vote/top/monthly.json",
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
          "https://discuss.near.vote/c/8/l/top/monthly.json?page=2",
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
                topics: [validTopicPayload({ id: 13, title: "Cat Default", slug: "cat-default" })],
                more_topics_url: null,
              },
            }),
          })
        );

        const result = await run(
          service.getTopTopics({ period: "weekly", categoryId: 9, page: -1 })
        );

        expect(fetchMock).toHaveBeenCalledWith(
          "https://discuss.near.vote/c/9/l/top/weekly.json",
          expect.any(Object)
        );
        expect(result.nextPage).toBeNull();
      });

      it("mapTopic should supply defaults for missing optional fields", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ json: async () => ({ id: 55, title: "Minimal", slug: "min" }) })
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
            json: async () => ({ id: 56, title: "Minimal", slug: "min", created_at: "2024-01-01" }),
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

        expect(() => mapper(validPostPayload({ raw: undefined }), true)).toThrow(
          "Post validation failed: raw is required when includeRaw is true"
        );
      });

      it("should surface errors when getPost fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 500, text: async () => "boom" })
        );

        await expectDiscourseApiError(
          () => run(service.getPost(99, false)),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/posts/99.json",
            bodyIncludes: "boom",
            contextIncludes: "Get post failed",
          }
        );
      });

      it("should surface errors when replies fetch fails", async () => {
        fetchMock.mockResolvedValueOnce(
          makeRes({ ok: false, status: 404, text: async () => "not found" })
        );

        await expectDiscourseApiError(
          () => run(service.getPostReplies(999)),
          {
            status: 404,
            method: "GET",
            pathIncludes: "/posts/999/replies.json",
            bodyIncludes: "not found",
            contextIncludes: "Get post replies failed",
          }
        );
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
          () => run(service.getTopTopics({ period: "weekly", categoryId: 1, page: 1 })),
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
              category_list: { categories: [{ name: "General", slug: "general" }] },
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

        await expectDiscourseApiError(
          () => run(service.getCategories()),
          {
            status: 503,
            method: "GET",
            pathIncludes: "/categories.json",
            bodyIncludes: "unavailable",
            contextIncludes: "Get categories failed",
          }
        );
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
              category: validCategoryPayload({ id: 1, slug: "parent", name: "Parent" }),
              subcategory_list: [validCategoryPayload({ id: 2, slug: "child", name: "Child" })],
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
              category: validCategoryPayload({ id: 1, slug: "parent", name: "Parent" }),
              subcategory_list: {
                categories: [
                  validCategoryPayload({ id: 3, slug: "grandchild", name: "Grandchild" }),
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
              category: validCategoryPayload({ id: 1, slug: "parent", name: "Parent" }),
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

        await expectDiscourseApiError(
          () => run(service.getTopic(123)),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/t/123.json",
            bodyIncludes: "server error",
            contextIncludes: "Get topic failed",
          }
        );
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

        await expectDiscourseApiError(
          () => run(service.getUser("alice")),
          {
            status: 500,
            method: "GET",
            pathIncludes: "/u/alice.json",
            bodyIncludes: "server error",
            contextIncludes: "Get user failed",
          }
        );
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
          "https://discuss.near.vote",
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
          "https://discuss.near.vote/session/current.json",
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
          makeRes({ json: async () => ({ current_user: { id: 9, username: "bob" } }) })
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
          retryable: true,
        });
      });

      it("should handle missing fields in validation error response", async () => {
        fetchMock.mockRejectedValueOnce({}); // non-Error object

        const result = await run(service.validateUserApiKey("any-key"));

        expect(result).toEqual({
          valid: false,
          error: "API key invalid: [object Object]",
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
          "https://discuss.near.vote",
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
          retryable: true,
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

describe("NEARService", () => {
  const nearService = new NEARService("recipient.near");
  const verifyMock = verify as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    verifyMock.mockReset();
  });

  it("should return account id on successful verification", async () => {
    verifyMock.mockResolvedValueOnce({ accountId: "alice.near" } as any);

    const account = await run(
      nearService.verifySignature("token", 1000)
    );

    expect(verifyMock).toHaveBeenCalledWith("token", {
      expectedRecipient: "recipient.near",
      nonceMaxAge: 1000,
    });
    expect(account).toBe("alice.near");
  });

  it("should throw when verification result is missing account id", async () => {
    verifyMock.mockResolvedValueOnce({} as any);

    await expect(run(nearService.verifySignature("token"))).rejects.toThrow(
      "NEAR verification failed: Missing accountId in verification result"
    );
  });

  it("should throw on verification failure", async () => {
    verifyMock.mockRejectedValueOnce(new Error("bad signature"));

    await expect(
      run(nearService.verifySignature("token", 1000))
    ).rejects.toThrow("NEAR verification failed: bad signature");
  });

  it("should wrap synchronous verify errors", async () => {
    verifyMock.mockImplementationOnce(() => {
      throw new Error("sync boom");
    });

    await expect(
      run(nearService.verifySignature("token"))
    ).rejects.toThrow("NEAR verification failed: sync boom");
  });

  it("should wrap non-error rejections", async () => {
    verifyMock.mockRejectedValueOnce("string error");

    await expect(
      run(nearService.verifySignature("token"))
    ).rejects.toThrow("NEAR verification failed: string error");
  });

  it("should throw when verification result lacks accountId", async () => {
    verifyMock.mockResolvedValueOnce({} as any);

    await expect(run(nearService.verifySignature("token"))).rejects.toThrow(
      "Missing accountId in verification result"
    );
  });
});

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
  const encrypted = Buffer.from("ciphertext-with-sufficient-length".repeat(3)).toString(
    "base64"
  );

  it("should decrypt payload and return key", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() => Buffer.from(JSON.stringify({ key: "decrypted-key" }), "utf-8"));
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
    const decryptFn = vi.fn().mockImplementation(() => Buffer.from("{}", "utf-8"));
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(encrypted, "private-key"))
    ).rejects.toThrow("Decryption produced empty result");
  });

  it("should throw when decrypted data is empty payload", async () => {
    const decryptFn = vi.fn().mockImplementation(() => Buffer.alloc(0));
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(Buffer.alloc(0).toString("base64"), "key"))
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
    const decryptFn = vi.fn().mockImplementation(() => Buffer.from("not-json", "utf-8"));
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(encrypted, "private-key"))
    ).rejects.toThrow("invalid JSON");
  });

  it("should throw when decrypted JSON has no key field", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() => Buffer.from(JSON.stringify({ foo: "bar" }), "utf-8"));
    const cryptoService = new CryptoService(decryptFn as any);

    await expect(
      run(cryptoService.decryptPayload(encrypted, "private-key"))
    ).rejects.toThrow("Decryption produced empty result");
  });

  it("should reject non-string decrypted keys", async () => {
    const decryptFn = vi
      .fn()
      .mockImplementation(() => Buffer.from(JSON.stringify({ key: 42 }), "utf-8"));
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
      .mockImplementation(() => Buffer.from(JSON.stringify({ key: "custom" }), "utf-8"));
    const cryptoService = new CryptoService(decryptFn as any, {
      minCiphertextBytes: 32,
      maxCiphertextBytes: 2048,
    });
    const largePayload = Buffer.alloc(1500).toString("base64");

    const result = await run(cryptoService.decryptPayload(largePayload, "private-key"));

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
      expect(() => manager.create("   ", "key")).toThrow("clientId is required");
      expect(() => manager.create("client", "   ")).toThrow("privateKey is required");
    });

    it("rejects non-string private keys", () => {
      expect(() => manager.create("client", 123 as any)).toThrow("privateKey is required");
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
      expect(() => limitedManager.create("client", "k3")).toThrow(NonceCapacityError);

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
      expect(() => limitedManager.create("c4", "k4")).toThrow(NonceCapacityError);

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
      const resilientManager = new NonceManager({ ttlMs: 1000, maxPerClient: 1 });
      const now = Date.now();
      (resilientManager as any).nonces = new Map<string, any>([
        [
          "nonce-1",
          { clientId: "client", privateKey: "k1", timestamp: now },
        ],
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
      expect(Array.from((resilientManager as any).nonces.keys())).toEqual(["nonce-2"]);
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
  });
});

describe("LinkageStore", () => {
  const store = new LinkageStore();

  describe("set and get", () => {
    it("should store and retrieve linkage", () => {
      const linkage = {
        nearAccount: "test.near",
        discourseUsername: "testuser",
        discourseUserId: 123,
        userApiKey: "test-api-key",
        verifiedAt: new Date().toISOString(),
      };

      store.set("test.near", linkage);
      const retrieved = store.get("test.near");

      expect(retrieved).toEqual(linkage);
    });

    it("should return null for non-existent account", () => {
      const retrieved = store.get("nonexistent.near");
      expect(retrieved).toBeNull();
    });

    it("should overwrite existing linkage", () => {
      const linkage1 = {
        nearAccount: "test.near",
        discourseUsername: "user1",
        discourseUserId: 1,
        userApiKey: "key1",
        verifiedAt: new Date().toISOString(),
      };

      const linkage2 = {
        nearAccount: "test.near",
        discourseUsername: "user2",
        discourseUserId: 2,
        userApiKey: "key2",
        verifiedAt: new Date().toISOString(),
      };

      store.set("test.near", linkage1);
      store.set("test.near", linkage2);

      const retrieved = store.get("test.near");
      expect(retrieved?.discourseUsername).toBe("user2");
    });
  });

  describe("normalization and safety", () => {
    it("should normalize near account keys for consistent lookups", () => {
      const local = new LinkageStore();
      local.set("MixedCase.NEAR", {
        nearAccount: "MixedCase.NEAR",
        discourseUsername: "user",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const retrieved = local.get("mixedcase.near");
      expect(retrieved?.nearAccount).toBe("mixedcase.near");
      expect(local.get("MIXEDCASE.NEAR")?.discourseUsername).toBe("user");
    });

    it("should return copies to prevent external mutation of stored data", () => {
      const local = new LinkageStore();
      const linkage = {
        nearAccount: "safe.near",
        discourseUsername: "safe-user",
        discourseUserId: 7,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      };

      local.set(linkage.nearAccount, linkage);

      const retrieved = local.get("SAFE.near");
      expect(retrieved).toEqual({ ...linkage, nearAccount: "safe.near" });

      if (retrieved) {
        retrieved.discourseUsername = "mutated";
      }

      expect(local.get(linkage.nearAccount)?.discourseUsername).toBe("safe-user");
    });
  });

  describe("getAll", () => {
    it("should return all linkages", () => {
      const store2 = new LinkageStore();

      const linkage1 = {
        nearAccount: "user1.near",
        discourseUsername: "user1",
        discourseUserId: 1,
        userApiKey: "key1",
        verifiedAt: new Date().toISOString(),
      };

      const linkage2 = {
        nearAccount: "user2.near",
        discourseUsername: "user2",
        discourseUserId: 2,
        userApiKey: "key2",
        verifiedAt: new Date().toISOString(),
      };

      store2.set("user1.near", linkage1);
      store2.set("user2.near", linkage2);

      const all = store2.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContainEqual(linkage1);
      expect(all).toContainEqual(linkage2);
    });
  });

  describe("remove", () => {
    it("should remove an existing linkage", () => {
      const store2 = new LinkageStore();
      store2.set("user1.near", {
        nearAccount: "user1.near",
        discourseUsername: "user1",
        discourseUserId: 1,
        userApiKey: "key1",
        verifiedAt: new Date().toISOString(),
      });

      expect(store2.remove("user1.near")).toBe(true);
      expect(store2.get("user1.near")).toBeNull();
    });

    it("should return false when linkage does not exist", () => {
      const store2 = new LinkageStore();
      expect(store2.remove("missing.near")).toBe(false);
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

    expect(() => safeLogger.info!("info message", { foo: "bar" })).not.toThrow();
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
