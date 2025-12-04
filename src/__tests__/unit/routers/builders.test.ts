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

const baseConfig = {
  variables: {
    discourseBaseUrl: "https://example.com",
    discourseApiUsername: "system",
    clientId: "client",
    requestTimeoutMs: 1_000,
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
    const router = buildMetaRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      config: baseConfig as any,
      withErrorLogging: makeWithErrorLogging(),
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
    const router = buildMetaRouter({
      builder,
      discourseService: { checkHealth: vi.fn().mockResolvedValue(false) } as any,
      log: logSpy as any,
      run,
      config: baseConfig as any,
      cleanupFiber: null as any,
      withErrorLogging: makeWithErrorLogging(),
      enforceRateLimit,
      withCache: ({ fetch }) => fetch(),
      cacheStats: () => ({ size: 0, hits: 0, misses: 0, ttlMs: 0 }),
    });

    const result = await router.ping({ errors: {} as any });

    expect(result.status).toBe("unhealthy");
    expect(enforceRateLimit).toHaveBeenCalledWith("ping", expect.any(Object));
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

  it("returns degraded ping status when only some checks pass", async () => {
    const builder = makeBuilder();
    const logSpy = vi.fn();
    const enforceRateLimit = vi.fn();
    const router = buildMetaRouter({
      builder,
      discourseService: { checkHealth: vi.fn().mockResolvedValue(true) } as any,
      log: logSpy as any,
      run,
      config: baseConfig as any,
      cleanupFiber: null as any,
      withErrorLogging: makeWithErrorLogging(),
      enforceRateLimit,
      withCache: ({ fetch }) => fetch(),
      cacheStats: () => ({ size: 1, hits: 0, misses: 0, ttlMs: 0 }),
    });

    const result = await router.ping({ errors: {} as any });

    expect(result.status).toBe("degraded");
    expect(result.checks).toEqual({ discourse: true, cache: false, cleanup: false });
    expect(logSpy).toHaveBeenCalledWith(
      "warn",
      "Ping Discourse",
      expect.objectContaining({
        action: "ping",
        status: "degraded",
      })
    );
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

  it("topics router exposes expected handlers", () => {
    const builder = makeBuilder();
    const router = buildTopicsRouter({
      builder,
      discourseService: {} as any,
      log,
      run,
      makeHandler: (_action, effect) => effect as any,
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
