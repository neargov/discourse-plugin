import { describe, expect, it, vi } from "vitest";
import { buildAuthRouter } from "../../../routers/auth";
import { buildPostsRouter } from "../../../routers/posts";
import { buildSearchRouter } from "../../../routers/search";
import { buildTopicsRouter } from "../../../routers/topics";
import { buildUsersRouter } from "../../../routers/users";
import { buildUploadsRouter } from "../../../routers/uploads";
import { buildMetaRouter } from "../../../routers/meta";
import {
  RouterConfigError,
  createWithErrorLogging,
  mapValidateUserApiKeyResult,
  normalizeUserApiScopes,
  sanitizeErrorForLog,
} from "../../../index";
import type { PluginErrorConstructors } from "../../../index";
import { NonceManager } from "../../../service";
import type { WrapRoute } from "../../../router-helpers";

const handler = (fn: any) => fn;

const makeBuilder = () =>
  new Proxy(
    {},
    {
      get: () => ({ handler }),
    }
  ) as any;

const log = (() => {}) as any;
const run = ((eff: any) => Promise.resolve(eff)) as any;
const makeWithErrorLogging = () =>
  ((action: string, fn: any, _errors?: PluginErrorConstructors) =>
    Promise.resolve().then(() => fn())) as ReturnType<typeof createWithErrorLogging>;

const makeWrapRoute = (overrides?: {
  enforceRateLimit?: any;
  withCache?: any;
  withErrorLogging?: ReturnType<typeof createWithErrorLogging>;
}): WrapRoute => {
  const enforceRateLimit = overrides?.enforceRateLimit;
  const withCache = overrides?.withCache;
  const withErrorLogging = overrides?.withErrorLogging ?? makeWithErrorLogging();

  return (({ action, handler, cacheKey, rateLimitKey, logMeta }) => async ({ input, errors }) => {
    enforceRateLimit?.(action, errors, rateLimitKey?.(input));

    const execute = () => handler({ input, errors });
    const resolvedCacheKey = typeof cacheKey === "function" ? cacheKey(input) : cacheKey;

    if (withCache && resolvedCacheKey) {
      return withCache({ action, key: resolvedCacheKey, fetch: execute });
    }

    return withErrorLogging(
      action,
      execute,
      errors,
      logMeta ? logMeta(input) : undefined
    );
  }) as WrapRoute;
};

const baseConfig = {
  variables: {
    discourseBaseUrl: "https://example.com",
    discourseApiUsername: "system",
    clientId: "client",
    requestTimeoutMs: 1_000,
    cacheMaxSize: 10,
    cacheTtlMs: 1_000,
    rateLimitStrategy: "global",
    nonceTtlMs: 1_000,
    nonceCleanupIntervalMs: 1_000,
    userApiScopes: normalizeUserApiScopes(["read", "write"]),
    logBodySnippetLength: 100,
  },
  secrets: { discourseApiKey: "key" },
};

describe("router builders", () => {
  it("auth router exposes expected handlers", () => {
    const builder = makeBuilder();
    const router = buildAuthRouter({
      builder,
      cryptoService: {} as any,
      discourseService: {} as any,
      nonceManager: new NonceManager({ ttlMs: 1000 }),
      normalizedUserApiScopes: normalizeUserApiScopes(["read", "write"]),
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
      sanitizeErrorForLog,
      mapValidateUserApiKeyResult,
      RouterConfigError,
    });

    expect(Object.keys(router).sort()).toEqual(
      ["initiateLink", "completeLink", "validateUserApiKey"].sort()
    );
  });

  it("uploads router exposes expected handlers", () => {
    const builder = makeBuilder();
    const router = buildUploadsRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      withErrorLogging: makeWithErrorLogging(),
    });

    expect(Object.keys(router).sort()).toEqual(
      [
        "prepareUpload",
        "presignUpload",
        "batchPresignMultipartUpload",
        "completeMultipartUpload",
        "abortMultipartUpload",
      ].sort()
    );
  });

  it("meta router exposes expected handlers", () => {
    const builder = makeBuilder();
    const wrapRoute = makeWrapRoute();
    const router = buildMetaRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      config: baseConfig as any,
      withErrorLogging: makeWithErrorLogging(),
      wrapRoute,
    });

    expect(Object.keys(router).sort()).toEqual(
      [
        "ping",
        "getTags",
        "getTag",
        "getTagGroups",
        "getTagGroup",
        "createTagGroup",
        "updateTagGroup",
        "getCategories",
        "getCategory",
        "getSiteInfo",
        "getSiteBasicInfo",
      ].sort()
    );
  });

  it("returns unhealthy ping status and logs at error level when all checks fail", async () => {
    const builder = makeBuilder();
    const logSpy = vi.fn();
    const enforceRateLimit = vi.fn();
    const wrapRoute = makeWrapRoute({
      enforceRateLimit,
      withCache: ({ fetch }: any) => fetch(),
      withErrorLogging: makeWithErrorLogging(),
    });
    const router = buildMetaRouter({
      builder,
      discourseService: { checkHealth: vi.fn().mockResolvedValue(false) } as any,
      log: logSpy as any,
      run,
      config: baseConfig as any,
      cleanupFiber: null as any,
      enforceRateLimit,
      withErrorLogging: makeWithErrorLogging(),
      withCache: ({ fetch }) => fetch(),
      cacheStats: () => ({ size: 0, hits: 0, misses: 0, ttlMs: 0 }),
      wrapRoute,
    });

    const result = await router.ping({ errors: {} as any });

    expect(result.status).toBe("unhealthy");
    expect(enforceRateLimit).toHaveBeenCalledWith("ping", expect.any(Object), undefined);
    expect(logSpy).toHaveBeenCalledWith(
      "error",
      "Ping Discourse",
      expect.objectContaining({
        action: "ping",
        status: "unhealthy",
        cache: expect.any(Object),
      })
    );
  });

  it("returns healthy ping status when all checks pass", async () => {
    const builder = makeBuilder();
    const logSpy = vi.fn();
    const enforceRateLimit = vi.fn();
    const wrapRoute = makeWrapRoute({
      enforceRateLimit,
      withCache: ({ fetch }: any) => fetch(),
      withErrorLogging: makeWithErrorLogging(),
    });
    const router = buildMetaRouter({
      builder,
      discourseService: { checkHealth: vi.fn().mockResolvedValue(true) } as any,
      log: logSpy as any,
      run,
      config: baseConfig as any,
      cleanupFiber: {} as any,
      enforceRateLimit,
      withErrorLogging: makeWithErrorLogging(),
      withCache: ({ fetch }) => fetch(),
      cacheStats: () => ({ size: 1, hits: 1, misses: 0, ttlMs: 1_000 }),
      wrapRoute,
    });

    const result = await router.ping({ errors: {} as any });

    expect(result.status).toBe("healthy");
    expect(result.checks).toEqual({ discourse: true, cache: true, cleanup: true });
    expect(logSpy).toHaveBeenCalledWith(
      "debug",
      "Ping Discourse",
      expect.objectContaining({
        action: "ping",
        status: "healthy",
        cacheDisabled: false,
      })
    );
  });

  it("treats disabled cache configuration as healthy", async () => {
    const builder = makeBuilder();
    const logSpy = vi.fn();
    const enforceRateLimit = vi.fn();
    const wrapRoute = makeWrapRoute({
      enforceRateLimit,
      withCache: ({ fetch }: any) => fetch(),
      withErrorLogging: makeWithErrorLogging(),
    });
    const router = buildMetaRouter({
      builder,
      discourseService: { checkHealth: vi.fn().mockResolvedValue(true) } as any,
      log: logSpy as any,
      run,
      config: {
        ...baseConfig,
        variables: {
          ...baseConfig.variables,
          cacheMaxSize: 0,
          cacheTtlMs: 0,
        },
      } as any,
      cleanupFiber: {} as any,
      enforceRateLimit,
      withErrorLogging: makeWithErrorLogging(),
      withCache: ({ fetch }) => fetch(),
      cacheStats: () => ({ size: 0, hits: 0, misses: 0, ttlMs: 0 }),
      wrapRoute,
    });

    const result = await router.ping({ errors: {} as any });

    expect(result.status).toBe("healthy");
    expect(result.checks).toEqual({ discourse: true, cache: true, cleanup: true });
    expect(logSpy).toHaveBeenCalledWith(
      "debug",
      "Ping Discourse",
      expect.objectContaining({
        status: "healthy",
        cacheDisabled: true,
      })
    );
  });

  it("returns degraded ping status when cache is configured but unhealthy", async () => {
    const builder = makeBuilder();
    const logSpy = vi.fn();
    const enforceRateLimit = vi.fn();
    const cacheStats = vi.fn(() => ({ size: 1, hits: 0, misses: 0, ttlMs: 0 }));
    const wrapRoute = makeWrapRoute({
      enforceRateLimit,
      withCache: ({ fetch }: any) => fetch(),
      withErrorLogging: makeWithErrorLogging(),
    });
    const router = buildMetaRouter({
      builder,
      discourseService: { checkHealth: vi.fn().mockResolvedValue(true) } as any,
      log: logSpy as any,
      run,
      config: baseConfig as any,
      cleanupFiber: {} as any,
      enforceRateLimit,
      withErrorLogging: makeWithErrorLogging(),
      withCache: ({ fetch }) => fetch(),
      cacheStats,
      wrapRoute,
    });

    const result = await router.ping({ errors: {} as any });

    expect(result.status).toBe("degraded");
    expect(result.checks).toEqual({ discourse: true, cache: false, cleanup: true });
    expect(logSpy).toHaveBeenCalledWith(
      "warn",
      "Ping Discourse",
      expect.objectContaining({
        action: "ping",
        status: "degraded",
      })
    );
    expect(cacheStats).toHaveBeenCalled();
  });

  it("returns degraded ping status when cleanup fiber is missing", async () => {
    const builder = makeBuilder();
    const logSpy = vi.fn();
    const enforceRateLimit = vi.fn();
    const wrapRoute = makeWrapRoute({
      enforceRateLimit,
      withCache: ({ fetch }: any) => fetch(),
      withErrorLogging: makeWithErrorLogging(),
    });
    const router = buildMetaRouter({
      builder,
      discourseService: { checkHealth: vi.fn().mockResolvedValue(true) } as any,
      log: logSpy as any,
      run,
      config: baseConfig as any,
      cleanupFiber: null as any,
      enforceRateLimit,
      withErrorLogging: makeWithErrorLogging(),
      withCache: ({ fetch }) => fetch(),
      cacheStats: () => ({ size: 1, hits: 1, misses: 0, ttlMs: 1_000 }),
      wrapRoute,
    });

    const result = await router.ping({ errors: {} as any });

    expect(result.status).toBe("degraded");
    expect(result.checks).toEqual({ discourse: true, cache: true, cleanup: false });
    expect(logSpy).toHaveBeenCalledWith(
      "warn",
      "Ping Discourse",
      expect.objectContaining({
        action: "ping",
        status: "degraded",
        cacheDisabled: false,
      })
    );
  });

  it("invalidates tag caches after tag group mutations", async () => {
    const builder = makeBuilder();
    const invalidateCache = vi.fn();
    const invalidateCacheByPrefix = vi.fn();
    const discourseService = {
      createTagGroup: vi.fn().mockResolvedValue({ id: 1 }),
      updateTagGroup: vi.fn().mockResolvedValue({ id: 1 }),
    } as any;
    const wrapRoute = makeWrapRoute({
      enforceRateLimit: vi.fn(),
      withCache: ({ fetch }: any) => fetch(),
      withErrorLogging: makeWithErrorLogging(),
    });

    const router = buildMetaRouter({
      builder,
      discourseService,
      log,
      run,
      config: baseConfig as any,
      cleanupFiber: {} as any,
      enforceRateLimit: vi.fn(),
      withErrorLogging: makeWithErrorLogging(),
      withCache: ({ fetch }) => fetch(),
      cacheStats: () => ({ size: 1, hits: 0, misses: 0, ttlMs: 1_000 }),
      invalidateCache,
      invalidateCacheByPrefix,
      wrapRoute,
    });

    await router.createTagGroup({
      input: { name: "group", tagNames: ["a"], parentTagNames: [], onePerTopic: false },
      errors: {} as any,
    });

    await router.updateTagGroup({
      input: { tagGroupId: 1, name: "new-name" },
      errors: {} as any,
    });

    expect(invalidateCache).toHaveBeenCalledWith(["meta:get-tags", "meta:get-tag-groups"]);
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith([
      "meta:get-tag:",
      "meta:get-tag-group:",
    ]);
    expect(invalidateCache).toHaveBeenCalledTimes(2);
    expect(invalidateCacheByPrefix).toHaveBeenCalledTimes(2);
  });

  it("posts router exposes expected handlers", () => {
    const builder = makeBuilder();
    const router = buildPostsRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
    });

    expect(Object.keys(router).sort()).toEqual(
      [
        "createPost",
        "editPost",
        "lockPost",
        "performPostAction",
        "deletePost",
        "getPost",
        "listPosts",
        "getPostReplies",
        "getRevision",
        "updateRevision",
        "deleteRevision",
      ].sort()
    );
  });

  it("executes post fetches directly when cache helper is absent", async () => {
    const builder = makeBuilder();
    const discourseService = {
      getPost: vi.fn().mockResolvedValue({ id: 42 }),
    } as any;

    const router = buildPostsRouter({
      builder,
      discourseService,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
    });

    const request = { input: { postId: 1, includeRaw: false }, errors: {} as any };

    await router.getPost(request);
    await router.getPost(request);

    expect(discourseService.getPost).toHaveBeenCalledTimes(2);
  });

  it("defaults cache keys for optional post inputs when using cache helper", async () => {
    const builder = makeBuilder();
    const cacheKeys: string[] = [];
    const withCache = vi.fn(async ({ key, fetch }) => {
      cacheKeys.push(key);
      return fetch();
    });
    const discourseService = {
      getPost: vi.fn().mockResolvedValue({ id: 9 }),
      listPosts: vi.fn().mockResolvedValue({ posts: [] }),
    } as any;

    const router = buildPostsRouter({
      builder,
      discourseService,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
      withCache,
    });

    await router.getPost({ input: { postId: 5 }, errors: {} as any });
    await router.listPosts({ input: {}, errors: {} as any });

    expect(cacheKeys).toEqual(["post:5:raw:false", "posts:list:0"]);
    expect(discourseService.getPost).toHaveBeenCalledTimes(1);
    expect(discourseService.listPosts).toHaveBeenCalledTimes(1);
  });

  it("invalidates caches after post mutations", async () => {
    const builder = makeBuilder();
    const invalidateCache = vi.fn();
    const invalidateCacheByPrefix = vi.fn();
    const discourseService = {
      createPost: vi.fn().mockResolvedValue({
        topic_id: 7,
        topic_slug: "topic-slug",
        id: 42,
      }),
      resolvePath: (path: string) => path,
    } as any;

    const router = buildPostsRouter({
      builder,
      discourseService,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
      invalidateCache,
      invalidateCacheByPrefix,
    });

    const errors = {
      SERVICE_UNAVAILABLE: vi.fn(({ message }) => new Error(message)),
    };

    await router.createPost({
      input: {
        title: "Title",
        raw: "Body",
        category: 1,
        topicId: undefined,
        replyToPostNumber: undefined,
        username: "user",
      },
      errors: errors as any,
    });

    expect(invalidateCache).toHaveBeenCalledWith([
      "post:42:raw:false",
      "post:42:raw:true",
      "post:42:replies",
    ]);
    expect(invalidateCache).toHaveBeenCalledWith(["topic:7"]);
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith(["posts:list:"]);
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith([
      "topics:latest:",
      "topics:list:",
      "topics:top:",
      "topics:category:",
    ]);
  });

  it("topics router exposes expected handlers", () => {
    const builder = makeBuilder();
    const router = buildTopicsRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
      withCache: ({ fetch }) => fetch(),
      invalidateCache: () => {},
      invalidateCacheByPrefix: () => {},
    });

    expect(Object.keys(router).sort()).toEqual(
      [
        "getTopic",
        "getLatestTopics",
        "listTopicList",
        "getTopTopics",
        "getCategoryTopics",
        "updateTopicStatus",
        "updateTopicMetadata",
        "bookmarkTopic",
        "inviteToTopic",
        "setTopicNotification",
        "changeTopicTimestamp",
        "addTopicTimer",
      ].sort()
    );
  });

  it("invalidates caches after topic updates", async () => {
    const builder = makeBuilder();
    const invalidateCache = vi.fn();
    const invalidateCacheByPrefix = vi.fn();
    const discourseService = {
      updateTopicStatus: vi.fn().mockResolvedValue({ success: true }),
    } as any;

    const router = buildTopicsRouter({
      builder,
      discourseService,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
      withCache: ({ fetch }) => fetch(),
      invalidateCache,
      invalidateCacheByPrefix,
    });

    await router.updateTopicStatus({
      input: {
        topicId: 11,
        status: "pinned",
        enabled: true,
        username: "user",
        userApiKey: "key",
      },
      errors: {} as any,
    });

    expect(invalidateCache).toHaveBeenCalledWith(["topic:11"]);
    expect(invalidateCacheByPrefix).toHaveBeenCalledWith([
      "topics:latest:",
      "topics:list:",
      "topics:top:",
      "topics:category:",
    ]);
  });

  it("users router exposes expected handlers", () => {
    const builder = makeBuilder();
    const router = buildUsersRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
    });

    expect(Object.keys(router).sort()).toEqual(
      [
        "getUser",
        "createUser",
        "updateUser",
        "deleteUser",
        "listUsers",
        "listAdminUsers",
        "getUserByExternal",
        "forgotPassword",
        "changePassword",
        "logoutUser",
        "syncSso",
        "getUserStatus",
        "updateUserStatus",
      ].sort()
    );
  });

  it("search router exposes expected handlers", () => {
    const builder = makeBuilder();
    const router = buildSearchRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
    });

    expect(Object.keys(router).sort()).toEqual(["search", "getDirectory"].sort());
  });

  it("posts router throws when SERVICE_UNAVAILABLE constructor is missing", async () => {
    const builder = makeBuilder();
    const router = buildPostsRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
    });

    await expect(
      (router.createPost as any)({
        input: {
          title: "t",
          raw: "r",
          category: 1,
          topicId: 1,
          replyToPostNumber: undefined,
          username: "user",
        },
        errors: {},
      })
    ).rejects.toThrow("SERVICE_UNAVAILABLE constructor missing");
  });
});
