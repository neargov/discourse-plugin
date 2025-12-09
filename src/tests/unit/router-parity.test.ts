import { describe, expect, it } from "vitest";
import { createRouter, normalizeUserApiScopes } from "../../index";
import type { PluginContext } from "../../index";
import { contract } from "../../contract";

const makeStubBuilder = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => ({
        handler: (fn: unknown) => fn,
      }),
    }
  ) as any;

const makeContext = (): PluginContext =>
  ({
    discourseService: {} as any,
    cryptoService: {} as any,
    nonceManager: {} as any,
    config: {
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
    } as any,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any,
    normalizedUserApiScopes: normalizeUserApiScopes(["read", "write"]),
    cleanupFiber: {} as any,
    bodySnippetLength: 100,
    metrics: { retryAttempts: 0, nonceEvictions: 0 },
  }) as PluginContext;

// Keep this list in sync with contract routes; guards against missing handlers during refactors.
const EXPECTED_HANDLERS = [
  "initiateLink",
  "completeLink",
  "validateUserApiKey",
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
  "search",
  "getDirectory",
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
  "prepareUpload",
  "presignUpload",
  "batchPresignMultipartUpload",
  "completeMultipartUpload",
  "abortMultipartUpload",
  "ping",
  "getTags",
  "getTag",
  "getTagGroups",
  "getTagGroup",
  "createTagGroup",
  "updateTagGroup",
  "getCategories",
  "getCategory",
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
  "getSiteInfo",
  "getSiteBasicInfo",
];

describe("createRouter handler parity", () => {
  it("registers all expected handlers", () => {
    const builder = makeStubBuilder();
    const router = createRouter(makeContext(), builder);
    const registered = Object.keys(router).sort();

    expect(registered).toEqual(expect.arrayContaining(EXPECTED_HANDLERS));
    expect(registered).toHaveLength(EXPECTED_HANDLERS.length);
  });
});
