import type { PluginRegistry } from "every-plugin";
import { Effect } from "every-plugin/effect";
import { createLocalPluginRuntime } from "every-plugin/testing";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import DiscoursePlugin from "../../index";
import { DiscourseApiError, NonceManager } from "../../service";
import { effectHelpers } from "../../utils";
import {
  validCategoryPayload,
  validPostPayload,
  validSearchResponse,
  validTagGroupPayload,
  validTagPayload,
  validTopicPayload,
  validUserPayload,
} from "../../tests/fixtures";

const TEST_REGISTRY: PluginRegistry = {
  "discourse-plugin": {
    remoteUrl: "http://localhost:3014/remoteEntry.js",
    version: "0.0.1",
    description: "Discourse plugin for integration testing",
  },
};

const TEST_PLUGIN_MAP = {
  "discourse-plugin": DiscoursePlugin,
} as const;

const createRuntime = () =>
  createLocalPluginRuntime(
    {
      registry: TEST_REGISTRY,
      secrets: { DISCOURSE_API_KEY: "test-api-key" },
    },
    TEST_PLUGIN_MAP
  );

const TEST_CONFIG = {
  variables: {
    discourseBaseUrl: "https://discuss.example.com",
    discourseApiUsername: "system",
    clientId: "test-client",
    requestTimeoutMs: 30000,
    nonceTtlMs: 10 * 60 * 1000,
    nonceCleanupIntervalMs: 5 * 60 * 1000,
  },
  secrets: {
    discourseApiKey: "{{DISCOURSE_API_KEY}}",
  },
};

type Runtime = ReturnType<typeof createRuntime>;
let runtime: Runtime;

describe("Discourse Plugin Integration Tests", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;
  const useClient = () => runtime.usePlugin("discourse-plugin", TEST_CONFIG);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    runtime = createRuntime();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await runtime.shutdown();
  });

  describe("ping procedure", () => {
    it("should return healthy status", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () => "",
      });

      const { client } = await useClient();

      const result = await client.ping();

      expect(result).toEqual({
        status: "ok",
        timestamp: expect.any(String),
        discourseConnected: true,
      });
    });

    it("should return degraded when Discourse fetch fails", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));

      const { client } = await useClient();

      const result = await client.ping();

      expect(result).toEqual({
        status: "degraded",
        timestamp: expect.any(String),
        discourseConnected: false,
      });
    });
  });

  describe("initiateLink procedure", () => {
    it("should generate auth URL and unique nonces", async () => {
      const { client } = await useClient();

      const first = await client.initiateLink({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      const second = await client.initiateLink({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      expect(first.authUrl).toContain(
        "https://discuss.example.com/user-api-key/new"
      );
      expect(first.authUrl).toContain("client_id=test-client");
      expect(first.authUrl).toContain("application_name=Test%20Application");
      expect(first.authUrl).toContain("scopes=read%2Cwrite");
      expect(first.nonce).toBeDefined();
      expect(first.expiresAt).toBeDefined();
      expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(new Date(first.expiresAt).getTime()).toBeLessThan(
        Date.now() + TEST_CONFIG.variables.nonceTtlMs + 1000
      );
      expect(second.nonce).toBeDefined();
      expect(first.nonce).not.toBe(second.nonce);
      expect(second.expiresAt).toBeDefined();
    });

    it("should fail fast when nonce expiration cannot be computed", async () => {
      const { client, initialized } = await useClient();
      vi.spyOn(initialized.context.nonceManager, "getExpiration").mockReturnValue(null);

      await expect(
        client.initiateLink({
          clientId: "test-client",
          applicationName: "Test Application",
        })
      ).rejects.toThrow("Failed to compute nonce expiration");
    });

    it("rejects when nonce per-client limit is exceeded", async () => {
      const limitedRuntime = createLocalPluginRuntime(
        {
          registry: TEST_REGISTRY,
          secrets: { DISCOURSE_API_KEY: "test-api-key" },
        },
        TEST_PLUGIN_MAP
      );

      const { client } = await limitedRuntime.usePlugin("discourse-plugin", {
        ...TEST_CONFIG,
        variables: {
          ...TEST_CONFIG.variables,
          nonceMaxPerClient: 1,
          nonceLimitStrategy: { perClient: "rejectNew" },
        },
      });

      await client.initiateLink({
        clientId: "limited-client",
        applicationName: "Limited App",
      });

      await expect(
        client.initiateLink({
          clientId: "limited-client",
          applicationName: "Limited App",
        })
      ).rejects.toThrow();

      await limitedRuntime.shutdown();
    });

    it("evicts oldest nonce when strategy is evictOldest", async () => {
      const evictingRuntime = createLocalPluginRuntime(
        {
          registry: TEST_REGISTRY,
          secrets: { DISCOURSE_API_KEY: "test-api-key" },
        },
        TEST_PLUGIN_MAP
      );

      const { client, initialized } = await evictingRuntime.usePlugin(
        "discourse-plugin",
        {
          ...TEST_CONFIG,
          variables: {
            ...TEST_CONFIG.variables,
            nonceMaxPerClient: 1,
            nonceLimitStrategy: { perClient: "evictOldest" },
          },
        }
      );

      const first = await client.initiateLink({
        clientId: "evict-client",
        applicationName: "Evict App",
      });

      const second = await client.initiateLink({
        clientId: "evict-client",
        applicationName: "Evict App",
      });

      expect(first.nonce).not.toBe(second.nonce);
      expect(
        initialized.context.nonceManager.verify(first.nonce, "evict-client")
      ).toBe(false);
      expect(
        initialized.context.nonceManager.verify(second.nonce, "evict-client")
      ).toBe(true);

      await evictingRuntime.shutdown();
    });

    it("should apply configured user API scopes", async () => {
      const customRuntime = createLocalPluginRuntime(
        {
          registry: TEST_REGISTRY,
          secrets: { DISCOURSE_API_KEY: "test-api-key" },
        },
        TEST_PLUGIN_MAP
      );

      const { client } = await customRuntime.usePlugin("discourse-plugin", {
        ...TEST_CONFIG,
        variables: {
          ...TEST_CONFIG.variables,
          userApiScopes: ["read", "message"],
        },
      });

      const result = await client.initiateLink({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      expect(result.authUrl).toContain("scopes=message%2Cread");

      await customRuntime.shutdown();
    });

    it("fails initialization when user API scopes are invalid", async () => {
      const invalidRuntime = createLocalPluginRuntime(
        {
          registry: TEST_REGISTRY,
          secrets: { DISCOURSE_API_KEY: "test-api-key" },
        },
        TEST_PLUGIN_MAP
      );

      await expect(
        invalidRuntime.usePlugin("discourse-plugin", {
          ...TEST_CONFIG,
          variables: {
            ...TEST_CONFIG.variables,
            userApiScopes: [""],
          },
        })
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringMatching(/user api scope/i),
            }),
          ]),
        }),
      });

      await invalidRuntime.shutdown();
    });
  });

  describe("router flows", () => {
    it("completes link via router", async () => {
      const { client, initialized } = await useClient();
      const nonce = initialized.context.nonceManager.create("test-client", "priv-key");

      vi.spyOn(initialized.context.cryptoService, "decryptPayload").mockReturnValue(
        Effect.succeed("user-api-key")
      );
      vi.spyOn(initialized.context.discourseService, "getCurrentUser").mockReturnValue(
        Effect.succeed({ id: 7, username: "alice", name: "Alice" })
      );

      const result = await client.completeLink({
        payload: "encrypted",
        nonce,
      });

      expect(result).toEqual({
        userApiKey: "user-api-key",
        discourseUsername: "alice",
        discourseUserId: 7,
      });
    });

    it("creates a post for a provided username", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.discourseService, "createPost").mockReturnValue(
        Effect.succeed({ id: 10, topic_id: 20, topic_slug: "new-topic" })
      );

      const result = await client.createPost({
        username: "poster",
        title: "A valid title with enough length",
        raw: "This is valid post content that is certainly long enough.",
        category: 5,
      });

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.example.com/t/new-topic/20",
        postId: 10,
        topicId: 20,
      });
    });

    it("edits a post for a provided username", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.discourseService, "editPost").mockReturnValue(
        Effect.succeed({
          id: 11,
          topicId: 22,
          topicSlug: "hello-world",
          postUrl: "/p/11",
        })
      );

      const result = await client.editPost({
        username: "poster",
        postId: 11,
        raw: "Updated post content that meets the minimum length.",
        editReason: "typo",
      });

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.example.com/p/11",
        postId: 11,
        topicId: 22,
      });
    });
  });

  describe("retry-after backoff", () => {
    it("retries once using retryAfterMs before surfacing result", async () => {
      const { client } = await useClient();

      const categories = [
        {
          id: 1,
          name: "General",
          slug: "general",
          description: null,
          color: "fff",
          topicCount: 0,
          postCount: 0,
          parentCategoryId: null,
          readRestricted: false,
        },
      ];

      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: {
            get: (key: string) =>
              key.toLowerCase() === "retry-after"
                ? "0.01"
                : key.toLowerCase() === "content-length"
                  ? "20"
                  : null,
          },
          text: async () => "rate limited",
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (key: string) =>
              key.toLowerCase() === "content-type"
                ? "application/json"
                : key.toLowerCase() === "content-length"
                  ? "100"
                  : null,
          },
          text: async () =>
            JSON.stringify({
              category_list: { categories },
            }),
        });

      const result = await client.getCategories();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.categories).toEqual(categories);
    });

    it("retries server errors with retry-after metadata", async () => {
      const { client } = await useClient();

      const apiCategories = [
        {
          id: 2,
          name: "Meta",
          slug: "meta",
          description: "Meta topics",
          topic_count: 1,
          post_count: 1,
          parent_category_id: null,
          read_restricted: false,
          color: "eee",
        },
      ];

      const expected = [
        {
          id: 2,
          name: "Meta",
          slug: "meta",
          description: "Meta topics",
          color: "eee",
          topicCount: 1,
          postCount: 1,
          parentCategoryId: null,
          readRestricted: false,
        },
      ];

      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: {
            get: (key: string) =>
              key.toLowerCase() === "retry-after"
                ? "0.01"
                : key.toLowerCase() === "content-length"
                  ? "18"
                  : null,
          },
          text: async () => "maintenance",
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (key: string) =>
              key.toLowerCase() === "content-type"
                ? "application/json"
                : key.toLowerCase() === "content-length"
                  ? "100"
                  : null,
          },
          text: async () =>
            JSON.stringify({
              category_list: { categories: apiCategories },
            }),
        });

      const result = await client.getCategories();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.categories).toEqual(expected);
    });

    it("retries once when retry-after metadata is absent", async () => {
      const { client } = await useClient();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => "maintenance",
      }).mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => "still down",
      });

      await expect(client.getCategories()).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("completeLink procedure", () => {
    it("should reject invalid nonce", async () => {
      const { client } = await useClient();

      await expect(
        client.completeLink({
          payload: "fake-encrypted-payload",
          nonce: "invalid-nonce",
        })
      ).rejects.toThrow();
    });

    it("should reject expired nonce before decrypt", async () => {
      const { client, initialized } = await useClient();

      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
      const nonce = initialized.context.nonceManager.create("test-client", "private-key");
      nowSpy.mockReturnValue(11 * 60 * 1000);

      await expect(
        client.completeLink({
          payload: "irrelevant",
          nonce,
        })
      ).rejects.toThrow("Invalid or expired nonce");

      nowSpy.mockRestore();
    });

    it("returns BAD_REQUEST when payload cannot be decrypted", async () => {
      const { client, initialized } = await useClient();

      const nonce = initialized.context.nonceManager.create(
        "test-client",
        "private-key"
      );

      vi.spyOn(initialized.context.cryptoService, "decryptPayload").mockReturnValue(
        Effect.fail(new Error("decrypt failed"))
      );

      await expect(
        client.completeLink({
          payload: "encrypted",
          nonce,
        })
      ).rejects.toThrow("Invalid or expired payload");

      expect(initialized.context.nonceManager.get(nonce)).toBeNull();
    });

    it("should reject when nonce verification fails", async () => {
        const { client, initialized } = await useClient();

        const nonce = initialized.context.nonceManager.create(
          "test-client",
          "private-key"
        );

        vi.spyOn(initialized.context.nonceManager, "verify").mockReturnValue(false);

        await expect(
          client.completeLink({
            payload: "encrypted",
            nonce,
          })
        ).rejects.toThrow("Invalid or expired nonce");
      });

    it("should complete link successfully", async () => {
      const { client, initialized } = await useClient();

      const nonce = initialized.context.nonceManager.create(
        "test-client",
        "private-key"
      );

      vi.spyOn(initialized.context.cryptoService, "decryptPayload").mockReturnValue(
        Effect.succeed("user-api-key")
      );
      vi.spyOn(initialized.context.discourseService, "getCurrentUser").mockReturnValue(
        Effect.succeed({ id: 1, username: "alice", name: "Alice" })
      );

      const result = await client.completeLink({
        payload: "encrypted",
        nonce,
      });

      expect(result).toEqual({
        userApiKey: "user-api-key",
        discourseUsername: "alice",
        discourseUserId: 1,
      });

      expect(initialized.context.nonceManager.get(nonce)).toBeNull();
    });
  });

  describe("createPost procedure", () => {
    it("should reject when replying without topicId", async () => {
      const { client } = await useClient();

      await expect(
        client.createPost({
          username: "alice",
          replyToPostNumber: 1,
          raw: "Reply content that is definitely long enough to be valid.",
        })
      ).rejects.toThrow();
    });

    it("should bubble up Discourse errors", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.discourseService, "createPost").mockReturnValue(
        Effect.fail(new Error("discourse create failed"))
      );

      await expect(
        client.createPost({
          username: "alice",
          title: "Valid Title With Enough Length",
          raw: "This is a valid post content that is long enough to post.",
          category: 5,
        })
      ).rejects.toThrow("discourse create failed");
    });

    it("should create a post", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 11,
          topic_id: 22,
          topic_slug: "hello-world",
        }),
      });

      const { client, initialized } = await useClient();

      const result = await client.createPost({
        username: "alice",
        title: "Valid Title With Enough Length",
        raw: "This is a valid post content that is long enough to post.",
        category: 5,
      });

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
        success: true,
        postUrl: "https://discuss.example.com/t/hello-world/22",
        postId: 11,
        topicId: 22,
      });
    });

    it("should send User-Api-Key when provided", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 21,
          topic_id: 42,
          topic_slug: "user-auth",
        }),
      });

      const { client } = await useClient();

      const result = await client.createPost({
        username: "alice",
        userApiKey: "user-key",
        title: "Valid Title With Enough Length",
        raw: "This is a valid post content that is long enough to post.",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts.json",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "User-Api-Key": "user-key",
          }),
        })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({
          headers: expect.objectContaining({
            "Api-Key": expect.anything(),
          }),
        })
      );

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.example.com/t/user-auth/42",
        postId: 21,
        topicId: 42,
      });
    });

    it("normalizes returned postUrl when base URL has trailing slash", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 13,
          topic_id: 24,
          topic_slug: "normalized-url",
        }),
      });

      const { client, initialized } = await useClient();
      const originalBaseUrl = initialized.context.config.variables.discourseBaseUrl;
      initialized.context.config.variables.discourseBaseUrl = "https://discuss.example.com/";

      const result = await client.createPost({
        username: "alice",
        title: "Valid Title With Enough Length",
        raw: "This is a valid post content that is long enough to post.",
        category: 5,
      });

      expect(result.postUrl).toBe("https://discuss.example.com/t/normalized-url/24");

      initialized.context.config.variables.discourseBaseUrl = originalBaseUrl;
    });

    it("should create a reply when replying to a topic", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 12,
          topic_id: 22,
          topic_slug: "hello-world",
        }),
      });

      const { client, initialized } = await useClient();

      const result = await client.createPost({
        username: "alice",
        topicId: 22,
        replyToPostNumber: 1,
        raw: "Reply content that is definitely long enough to be valid.",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts.json",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            title: undefined,
            raw: "Reply content that is definitely long enough to be valid.",
            category: undefined,
            topic_id: 22,
            reply_to_post_number: 1,
          }),
        })
      );

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.example.com/t/hello-world/22",
        postId: 12,
        topicId: 22,
      });
    });

    it("should throw SERVICE_UNAVAILABLE when Discourse response is missing topic fields", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: undefined,
          topic_id: undefined,
          topic_slug: undefined,
        }),
      });

      const { client, initialized } = await useClient();

      await expect(
        client.createPost({
          username: "alice",
          title: "Valid Title With Enough Length",
          raw: "This is a valid post content that is long enough to post.",
          category: 5,
        })
      ).rejects.toThrow("Discourse response missing topic_slug/topic_id");
    });
  });

  describe("editPost procedure", () => {
    it("should bubble up Discourse errors", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.discourseService, "editPost").mockReturnValue(
        Effect.fail(new Error("discourse edit failed"))
      );

      await expect(
        client.editPost({
          username: "alice",
          postId: 55,
          raw: "Updated content that is long enough to be valid.",
        })
      ).rejects.toThrow("discourse edit failed");
    });

    it("should edit a post", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          post: {
            id: 55,
            topic_id: 66,
            topic_slug: "edited-topic",
            post_url: "https://discuss.example.com/p/55",
          },
        }),
      });

      const { client, initialized } = await useClient();

      const result = await client.editPost({
        username: "alice",
        postId: 55,
        raw: "Updated content that is long enough to pass validation.",
        editReason: "typo",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts/55.json",
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            "Api-Key": "test-api-key",
            "Api-Username": "alice",
          }),
        })
      );

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.example.com/p/55",
        postId: 55,
        topicId: 66,
      });
    });

    it("should send User-Api-Key when provided for edits", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          post: {
            id: 65,
            topic_id: 75,
            topic_slug: "edit-user",
            post_url: "https://discuss.example.com/p/65",
          },
        }),
      });

      const { client } = await useClient();

      const result = await client.editPost({
        username: "alice",
        userApiKey: "user-key",
        postId: 65,
        raw: "Updated content that is long enough to pass validation.",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts/65.json",
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            "User-Api-Key": "user-key",
          }),
        })
      );
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({
          headers: expect.objectContaining({
            "Api-Key": expect.anything(),
          }),
        })
      );

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.example.com/p/65",
        postId: 65,
        topicId: 75,
      });
    });

    it("should fall back to constructed postUrl when missing", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          post: {
            id: 56,
            topic_id: 77,
            topic_slug: "no-url",
            post_url: undefined,
          },
        }),
      });

      const { client, initialized } = await useClient();

      const result = await client.editPost({
        username: "alice",
        postId: 56,
        raw: "Updated content that is long enough.",
      });

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.example.com/p/56",
        postId: 56,
        topicId: 77,
      });
    });

    it("normalizes relative post_url responses when base has trailing slash", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          post: {
            id: 59,
            topic_id: 90,
            topic_slug: "relative-url",
            post_url: "/p/59",
          },
        }),
      });

      const { client, initialized } = await useClient();
      const originalBaseUrl = initialized.context.config.variables.discourseBaseUrl;
      initialized.context.config.variables.discourseBaseUrl = "https://discuss.example.com/";

      const result = await client.editPost({
        username: "alice",
        postId: 59,
        raw: "Updated content that is long enough.",
      });

      expect(result.postUrl).toBe("https://discuss.example.com/p/59");

      initialized.context.config.variables.discourseBaseUrl = originalBaseUrl;
    });

    it("should return provided postUrl when present", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          post: {
            id: 58,
            topic_id: 88,
            topic_slug: "has-url",
            post_url: "https://discuss.example.com/p/58",
          },
        }),
      });

      const { client, initialized } = await useClient();

      const result = await client.editPost({
        username: "alice",
        postId: 58,
        raw: "Updated content that is long enough.",
      });

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.example.com/p/58",
        postId: 58,
        topicId: 88,
      });
    });

    it("should throw SERVICE_UNAVAILABLE when response lacks topic metadata", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          post: {
            id: undefined,
            topic_id: undefined,
            topic_slug: undefined,
            post_url: undefined,
          },
        }),
      });

      const { client, initialized } = await useClient();

      await expect(
        client.editPost({
          username: "alice",
          postId: 57,
          raw: "Updated content that is long enough to be valid.",
        })
      ).rejects.toThrow("Discourse response missing topicSlug/topicId");
    });
  });

  describe("shutdown", () => {
    it("interrupts the cleanup fiber", async () => {
      const interruptSpy = vi
        .spyOn(effectHelpers, "interrupt")
        .mockReturnValue(Effect.succeed({} as any));

      const { initialized } = await useClient();

      await runtime.shutdown();

      expect(interruptSpy).toHaveBeenCalledWith(initialized.context.cleanupFiber);
    });
  });

  describe("search procedure", () => {
    it("should return mapped search results", async () => {
      const searchResponse = validSearchResponse({
        posts: [
          validPostPayload({
            id: 1,
            topic_id: 2,
            post_number: 1,
            reply_to_post_number: null,
            topic: { title: "Topic Title" },
            blurb: "snippet",
          }),
        ],
        topics: [
          validTopicPayload({
            id: 2,
            slug: "topic-title",
            category_id: 10,
            posts_count: 1,
            reply_count: 0,
            like_count: 1,
            views: 10,
          }),
        ],
        users: [
          validUserPayload({
            id: 5,
            title: "Title",
            trust_level: 2,
            moderator: false,
            admin: false,
          }),
        ],
        categories: [
          validCategoryPayload({
            id: 10,
            topic_count: 1,
            post_count: 1,
            parent_category_id: null,
            read_restricted: false,
          }),
        ],
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => searchResponse,
      });

      const { client } = await useClient();

      const result = await client.search({
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
      });

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
          {
            id: 2,
            title: "Topic Title",
            slug: "topic-title",
            categoryId: 10,
            createdAt: "2024-01-01",
            lastPostedAt: "2024-01-02",
            postsCount: 1,
            replyCount: 0,
            likeCount: 1,
            views: 10,
            pinned: false,
            closed: false,
            archived: false,
            visible: true,
          },
        ],
        users: [
          {
            id: 5,
            username: "alice",
            name: "Alice",
            avatarTemplate: "/avatar.png",
            title: "Title",
            trustLevel: 2,
            moderator: false,
            admin: false,
          },
        ],
        categories: [
          {
            id: 10,
            name: "General",
            slug: "general",
            description: null,
            color: "fff",
            topicCount: 1,
            postCount: 1,
            parentCategoryId: null,
            readRestricted: false,
          },
        ],
        totalResults: 1,
        hasMore: true,
      });
    });
  });

  describe("read operations", () => {
    it("should fetch a topic", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () =>
          validTopicPayload({
            id: 2,
            slug: "topic-title",
            category_id: 10,
            posts_count: 1,
            reply_count: 0,
            like_count: 1,
            views: 10,
          }),
      });

      const { client } = await useClient();

      const result = await client.getTopic({ topicId: 2 });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/t/2.json",
        expect.any(Object)
      );
      expect(result.topic.title).toBe("Topic Title");
    });

    it("should fetch a post with topic", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => validPostPayload(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => validTopicPayload(),
        });

      const { client } = await useClient();

      const result = await client.getPost({ postId: 5, includeRaw: false });

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
      expect(result.post.id).toBe(5);
      expect(result.topic.id).toBe(10);
    });

    it("should fetch a user", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: validUserPayload({
            id: 7,
            username: "bob",
            name: "Bob",
            title: "Member",
            trust_level: 1,
            created_at: "2024-01-01",
            last_posted_at: null,
            last_seen_at: null,
            post_count: 3,
            badge_count: 1,
            profile_view_count: 5,
          }),
        }),
      });

      const { client } = await useClient();

      const result = await client.getUser({ username: "bob" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/u/bob.json",
        expect.any(Object)
      );
      expect(result.user.username).toBe("bob");
      expect(result.user.postCount).toBe(3);
    });

    it("should fetch categories", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          category_list: {
            categories: [
              validCategoryPayload({
                id: 1,
                topic_count: 1,
                post_count: 1,
                parent_category_id: null,
                read_restricted: false,
              }),
            ],
          },
        }),
      });

      const { client } = await useClient();

      const result = await client.getCategories();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/categories.json",
        expect.any(Object)
      );
      expect(result.categories[0].name).toBe("General");
    });

    it("should fetch category details", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          category: validCategoryPayload({
            id: 10,
            topic_count: 1,
            post_count: 1,
            parent_category_id: null,
            read_restricted: false,
          }),
          subcategory_list: [],
        }),
      });

      const { client } = await useClient();

      const result = await client.getCategory({ idOrSlug: "general" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/c/general/show.json",
        expect.any(Object)
      );
      expect(result.category.slug).toBe("general");
      expect(result.subcategories).toHaveLength(0);
    });

    it("should fetch site info", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          site: {
            title: "Example Forum",
            description: "A place for examples",
            logo_url: "https://discuss.example.com/logo.png",
            mobile_logo_url: null,
            favicon_url: "https://discuss.example.com/favicon.ico",
            contact_email: "team@example.com",
            canonical_hostname: "discuss.example.com",
            default_locale: "en",
          },
          categories: [validCategoryPayload({ id: 1, name: "General" })],
        }),
      });

      const { client } = await useClient();

      const site = await client.getSiteInfo();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/site.json",
        expect.any(Object)
      );
      expect(site.title).toBe("Example Forum");
      expect(site.categories[0].name).toBe("General");
    });

    it("should fetch site basic info", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
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
      });

      const { client } = await useClient();

      const site = await client.getSiteBasicInfo();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/site/basic-info.json",
        expect.any(Object)
      );
      expect(site.title).toBe("Basic Forum");
      expect(site.canonicalHostname).toBe("basic.example.com");
    });

    it("should fetch tags", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tags: [
            validTagPayload({
              id: 3,
              name: "support",
              topic_count: 2,
              synonyms: ["help"],
            }),
          ],
        }),
      });

      const { client } = await useClient();

      const result = await client.getTags();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/tags.json",
        expect.any(Object)
      );
      expect(result.tags[0]).toEqual(
        expect.objectContaining({
          id: 3,
          name: "support",
          topicCount: 2,
          synonyms: ["help"],
        })
      );
    });

    it("should fetch a tag", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag: validTagPayload({
            id: 4,
            name: "feature",
            topic_count: 5,
            pm_topic_count: 1,
          }),
        }),
      });

      const { client } = await useClient();

      const result = await client.getTag({ name: "feature" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/tags/feature.json",
        expect.any(Object)
      );
      expect(result.tag).toEqual(
        expect.objectContaining({
          id: 4,
          name: "feature",
          topicCount: 5,
          pmTopicCount: 1,
        })
      );
    });

    it("should fetch tag groups", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_groups: [
            validTagGroupPayload({
              id: 6,
              name: "Releases",
              tag_names: ["stable", "beta"],
              parent_tag_names: ["release"],
              permissions: { staff: 1 },
            }),
          ],
        }),
      });

      const { client } = await useClient();

      const result = await client.getTagGroups();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/tag_groups.json",
        expect.any(Object)
      );
      expect(result.tagGroups[0]).toEqual(
        expect.objectContaining({
          id: 6,
          name: "Releases",
          tagNames: ["stable", "beta"],
          parentTagNames: ["release"],
        })
      );
    });

    it("should fetch a single tag group", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_group: validTagGroupPayload({
            id: 7,
            name: "Announcements",
            tag_names: ["updates"],
            tags: [validTagPayload({ id: 8, name: "updates" })],
          }),
        }),
      });

      const { client } = await useClient();

      const result = await client.getTagGroup({ tagGroupId: 7 });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/tag_groups/7.json",
        expect.any(Object)
      );
      expect(result.tagGroup.tags?.[0].name).toBe("updates");
    });

    it("should create a tag group", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_group: validTagGroupPayload({
            id: 9,
            name: "New Group",
            tag_names: ["fresh"],
            one_per_topic: true,
            permissions: { staff: 1 },
          }),
        }),
      });

      const { client } = await useClient();

      const result = await client.createTagGroup({
        name: "New Group",
        tagNames: ["fresh"],
        parentTagNames: [],
        onePerTopic: true,
        permissions: { staff: 1 },
      });

      const [, options] = fetchMock.mock.calls[0];
      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/tag_groups.json",
        expect.any(Object)
      );
      expect(JSON.parse((options as any).body)).toEqual({
        tag_group: {
          name: "New Group",
          tag_names: ["fresh"],
          parent_tag_names: [],
          one_per_topic: true,
          permissions: { staff: 1 },
        },
      });
      expect(result.tagGroup.name).toBe("New Group");
    });

    it("should update a tag group", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_group: validTagGroupPayload({
            id: 10,
            name: "Updated Group",
            tag_names: ["alpha"],
          }),
        }),
      });

      const { client } = await useClient();

      const result = await client.updateTagGroup({
        tagGroupId: 10,
        name: "Updated Group",
        tagNames: ["alpha"],
      });

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://discuss.example.com/tag_groups/10.json");
      expect((options as any).method).toBe("PUT");
      expect(JSON.parse((options as any).body)).toEqual({
        tag_group: {
          name: "Updated Group",
          tag_names: ["alpha"],
        },
      });
      expect(result.tagGroup.id).toBe(10);
    });

    it("should fetch latest topics", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          topic_list: {
            topics: [
              validTopicPayload({
                id: 1,
                title: "Latest Topic",
                slug: "latest-topic",
                category_id: 3,
                posts_count: 1,
                reply_count: 0,
                like_count: 1,
                views: 10,
              }),
            ],
            more_topics_url: "/more",
          },
        }),
      });

      const { client } = await useClient();

      const result = await client.getLatestTopics({
        categoryId: 3,
        page: 2,
        order: "activity",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/c/3/l/latest.json?page=2&order=activity",
        expect.any(Object)
      );
      expect(result.topics[0].title).toBe("Latest Topic");
      expect(result.hasMore).toBe(true);
      expect(result.nextPage).toBe(3);
    });

    it("should fetch top topics", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          topic_list: {
            topics: [
              validTopicPayload({
                id: 9,
                title: "Top Topic",
                slug: "top-topic",
                category_id: 7,
                posts_count: 3,
                reply_count: 2,
                like_count: 5,
                views: 50,
              }),
            ],
            more_topics_url: null,
          },
        }),
      });

      const { client } = await useClient();

      const result = await client.getTopTopics({
        period: "weekly",
        categoryId: 7,
        page: 1,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/c/7/l/top/weekly.json?page=1",
        expect.any(Object)
      );
      expect(result.topics[0].title).toBe("Top Topic");
      expect(result.hasMore).toBe(false);
      expect(result.nextPage).toBeNull();
    });

    it("should fetch topic lists for new topics", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          topic_list: {
            topics: [
              validTopicPayload({
                id: 4,
                title: "New Topic",
                slug: "new-topic",
                category_id: 2,
              }),
            ],
            more_topics_url: null,
          },
        }),
      });

      const { client } = await useClient();

      const result = await client.listTopicList({ type: "new", page: 1 });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/new.json?page=1",
        expect.any(Object)
      );
      expect(result.topics[0].title).toBe("New Topic");
      expect(result.nextPage).toBeNull();
    });

    it("should fetch category topics by slug and id", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          topic_list: {
            topics: [
              validTopicPayload({
                id: 20,
                title: "Category Topic",
                slug: "category-topic",
                category_id: 10,
              }),
            ],
            more_topics_url: "/c/general/10?page=3",
          },
        }),
      });

      const { client } = await useClient();

      const result = await client.getCategoryTopics({
        slug: "general",
        categoryId: 10,
        page: 2,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/c/general/10.json?page=2",
        expect.any(Object)
      );
      expect(result.topics[0].slug).toBe("category-topic");
      expect(result.hasMore).toBe(true);
      expect(result.nextPage).toBe(3);
    });

    it("should list recent posts", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          latest_posts: [
            validPostPayload({
              id: 21,
              topic_id: 10,
              post_number: 3,
              cooked: "<p>Latest</p>",
              raw: undefined,
            }),
          ],
          more_posts_url: "/posts?page=2",
        }),
      });

      const { client } = await useClient();

      const result = await client.listPosts({ page: 1 });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts.json?page=1",
        expect.any(Object)
      );
      expect(result.posts[0].id).toBe(21);
      expect(result.hasMore).toBe(true);
      expect(result.nextPage).toBe(2);
    });

    it("should fetch replies for a post", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
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
            raw: undefined,
            reply_count: 0,
            like_count: 0,
            created_at: "2024-01-02",
            updated_at: "2024-01-02",
          }),
        ],
      });

      const { client } = await useClient();

      const result = await client.getPostReplies({ postId: 5 });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts/5/replies.json",
        expect.any(Object)
      );
      expect(result.replies[0].id).toBe(6);
      expect(result.replies[0].replyToPostNumber).toBe(1);
    });
  });

  describe("topic administration", () => {
    it("updates topic status and returns the refreshed topic", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: "OK" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () =>
            validTopicPayload({
              id: 42,
              slug: "topic-42",
              closed: true,
            }),
        });

        const { client } = await useClient();

        const result = await client.updateTopicStatus({
          topicId: 42,
          status: "closed",
          enabled: true,
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          "https://discuss.example.com/t/42/status",
          expect.objectContaining({
            method: "PUT",
            body: JSON.stringify({ status: "closed", enabled: true }),
          })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
          2,
          "https://discuss.example.com/t/42.json",
          expect.any(Object)
        );
        expect(result.topic.id).toBe(42);
        expect(result.topic.closed).toBe(true);
    });

    it("updates topic metadata when title and category are provided", async () => {
      const updatedTitle = "Updated topic title with enough length";
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () =>
            validTopicPayload({
              id: 10,
              title: updatedTitle,
              category_id: 9,
            }),
        });

      const { client } = await useClient();

      const result = await client.updateTopicMetadata({
        topicId: 10,
        title: updatedTitle,
        categoryId: 9,
      });

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://discuss.example.com/t/10.json",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            title: updatedTitle,
            category_id: 9,
          }),
        })
      );
      expect(result.topic.title).toBe(updatedTitle);
      expect(result.topic.categoryId).toBe(9);
    });

    it("requires a title or category to update topic metadata", async () => {
      const { client } = await useClient();

      await expect(
        client.updateTopicMetadata({ topicId: 1 })
      ).rejects.toThrow(/input validation failed/i);
    });

    it("bookmarks a topic for the requesting user", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bookmark_id: 99 }),
      });

      const { client } = await useClient();

      const result = await client.bookmarkTopic({
        topicId: 5,
        username: "alice",
        userApiKey: "user-key",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/t/5/bookmark",
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            "User-Api-Key": "user-key",
          }),
          body: JSON.stringify({
            bookmarked: true,
            post_number: 1,
          }),
        })
      );
      expect(result).toEqual({ success: true, bookmarkId: 99 });
    });

    it("invites users and groups to a topic", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const { client } = await useClient();

      const result = await client.inviteToTopic({
        topicId: 7,
        usernames: ["alice", "bob"],
        groupNames: ["staff"],
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/t/7/invite",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            usernames: "alice,bob",
            group_names: "staff",
          }),
        })
      );
      expect(result.success).toBe(true);
    });

    it("requires at least one recipient when inviting to a topic", async () => {
      const { client } = await useClient();

      await expect(
        client.inviteToTopic({
          topicId: 7,
          usernames: [],
          groupNames: [],
        })
      ).rejects.toThrow(/input validation failed/i);
    });

    it("sets topic notification level from string aliases", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ notification_level: 3 }),
      });

      const { client } = await useClient();

      const result = await client.setTopicNotification({
        topicId: 8,
        level: "watching",
        username: "alice",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/t/8/notifications",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ notification_level: 3 }),
        })
      );
      expect(result.notificationLevel).toBe(3);
    });

    it("changes the topic timestamp and returns the updated topic", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: "OK" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () =>
            validTopicPayload({
              id: 11,
              created_at: "2024-03-03T00:00:00.000Z",
            }),
        });

      const { client } = await useClient();

      const result = await client.changeTopicTimestamp({
        topicId: 11,
        timestamp: "2024-03-03T00:00:00.000Z",
      });

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://discuss.example.com/t/11/change-timestamp",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            timestamp: "2024-03-03T00:00:00.000Z",
          }),
        })
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://discuss.example.com/t/11.json",
        expect.any(Object)
      );
      expect(result.topic.id).toBe(11);
      expect(result.topic.createdAt).toBe("2024-03-03T00:00:00.000Z");
    });

    it("adds a topic timer with timing options", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status_type: "close" }),
      });

      const { client } = await useClient();

      const result = await client.addTopicTimer({
        topicId: 12,
        statusType: "close",
        time: "2024-04-01T00:00:00.000Z",
        basedOnLastPost: true,
        durationMinutes: 45,
        categoryId: 4,
        username: "moderator",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/t/12/timers",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            status_type: "close",
            time: "2024-04-01T00:00:00.000Z",
            based_on_last_post: true,
            duration: 45,
            category_id: 4,
          }),
        })
      );
      expect(result).toEqual({ success: true, status: "close" });
    });
  });

  describe("validateUserApiKey", () => {
    it("returns valid user details", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_user: validUserPayload({ id: 5, username: "alice" }),
        }),
      });

      const { client } = await useClient();

      const result = await client.validateUserApiKey({ userApiKey: "user-key" });

      expect(result).toEqual({
        valid: true,
        user: expect.objectContaining({
          id: 5,
          username: "alice",
        }),
      });
    });

    it("maps retryable errors to TOO_MANY_REQUESTS", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "maintenance",
        headers: { get: () => null },
      });

      const { client } = await useClient();

      await expect(
        client.validateUserApiKey({ userApiKey: "user-key" })
      ).rejects.toThrow();
    });

    it("maps invalid keys to UNAUTHORIZED", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
        headers: { get: () => null },
      });

      const { client } = await useClient();

      await expect(
        client.validateUserApiKey({ userApiKey: "bad-key" })
      ).rejects.toThrow();
    });
  });

  describe("runtime lifecycle", () => {
    it("should shutdown a new runtime cleanly", async () => {
      const tempRuntime = createRuntime();

      const { initialized } = await tempRuntime.usePlugin(
        "discourse-plugin",
        TEST_CONFIG
      );
      expect(initialized.plugin.id).toBe("discourse-plugin");

      await expect(tempRuntime.shutdown()).resolves.toBeUndefined();
    });

    it("should call plugin shutdown hook", async () => {
      const { initialized } = await useClient();
      await expect(Effect.runPromise(initialized.plugin.shutdown())).resolves.toBeUndefined();
    });

    it("should run nonce cleanup immediately and on interval", async () => {
      const cleanupSpy = vi.spyOn(NonceManager.prototype, "cleanup");
      const tempRuntime = createRuntime();

      try {
        await tempRuntime.usePlugin("discourse-plugin", {
          ...TEST_CONFIG,
          variables: {
            ...TEST_CONFIG.variables,
            nonceCleanupIntervalMs: 25,
          },
        });
        expect(cleanupSpy).toHaveBeenCalledTimes(1);

        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(cleanupSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        await tempRuntime.shutdown();
        cleanupSpy.mockRestore();
      }
    });
  });
});
