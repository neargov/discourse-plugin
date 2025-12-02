import type { PluginRegistry } from "every-plugin";
import { Effect } from "every-plugin/effect";
import { createLocalPluginRuntime } from "every-plugin/testing";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import DiscoursePlugin from "../../index";
import { DiscourseApiError, NonceManager } from "../../service";
import { effectHelpers } from "../../utils";

const TEST_REGISTRY: PluginRegistry = {
  "@neargov/discourse": {
    remoteUrl: "http://localhost:3014/remoteEntry.js",
    version: "0.0.1",
    description: "Discourse NEAR plugin for integration testing",
  },
};

const TEST_PLUGIN_MAP = {
  "@neargov/discourse": DiscoursePlugin,
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
    discourseBaseUrl: "https://discuss.near.vote",
    discourseApiUsername: "system",
    clientId: "test-client",
    recipient: "social.near",
    signatureTtlMs: 300000,
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
  const useClient = () => runtime.usePlugin("@neargov/discourse", TEST_CONFIG);

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

  describe("getUserApiAuthUrl procedure", () => {
    it("should generate auth URL and unique nonces", async () => {
      const { client } = await useClient();

      const first = await client.getUserApiAuthUrl({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      const second = await client.getUserApiAuthUrl({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      expect(first.authUrl).toContain(
        "https://discuss.near.vote/user-api-key/new"
      );
      expect(first.authUrl).toContain("client_id=test-client");
      expect(first.authUrl).toContain("application_name=Test%20Application");
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
        client.getUserApiAuthUrl({
          clientId: "test-client",
          applicationName: "Test Application",
        })
      ).rejects.toThrow("Failed to compute nonce expiration");
    });
  });

  describe("getLinkage procedure", () => {
    it("should return null for non-existent linkage", async () => {
      const { client } = await useClient();

      const result = await client.getLinkage({
        nearAccount: "nonexistent.near",
      });

      expect(result).toBeNull();
    });

    it("should return linkage details when it exists", async () => {
      const { client, initialized } = await useClient();

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "linkedUser",
        discourseUserId: 42,
        userApiKey: "user-key",
        verifiedAt: "2024-01-01T00:00:00.000Z",
      });

      const result = await client.getLinkage({ nearAccount: "linked.near" });

      expect(result).toEqual({
        nearAccount: "linked.near",
        discourseUsername: "linkedUser",
        verifiedAt: "2024-01-01T00:00:00.000Z",
      });
    });
  });

  describe("router flows", () => {
    it("completes link and stores linkage via router", async () => {
      const { client, initialized } = await useClient();
      const nonce = initialized.context.nonceManager.create("test-client", "priv-key");

      vi.spyOn(initialized.context.cryptoService, "decryptPayload").mockReturnValue(
        Effect.succeed("user-api-key")
      );
      vi.spyOn(initialized.context.discourseService, "getCurrentUser").mockReturnValue(
        Effect.succeed({ id: 7, username: "alice", name: "Alice" })
      );
      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("alice.near")
      );

      const result = await client.completeLink({
        payload: "encrypted",
        nonce,
        authToken: "auth-token",
      });

      expect(result).toEqual({
        success: true,
        nearAccount: "alice.near",
        discourseUsername: "alice",
        message: expect.stringContaining("Successfully linked"),
      });
      expect(initialized.context.linkageStore.get("alice.near")).toEqual(
        expect.objectContaining({
          discourseUsername: "alice",
          discourseUserId: 7,
          userApiKey: "user-api-key",
        })
      );
    });

    it("creates a post for a linked account", async () => {
      const { client, initialized } = await useClient();

      initialized.context.linkageStore.set("poster.near", {
        nearAccount: "poster.near",
        discourseUsername: "poster",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: "2024-01-01T00:00:00.000Z",
      });

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("poster.near")
      );
      vi.spyOn(initialized.context.discourseService, "createPost").mockReturnValue(
        Effect.succeed({ id: 10, topic_id: 20, topic_slug: "new-topic" })
      );

      const result = await client.createPost({
        authToken: "token",
        title: "A valid title with enough length",
        raw: "This is valid post content that is certainly long enough.",
        category: 5,
      });

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.near.vote/t/new-topic/20",
        postId: 10,
        topicId: 20,
      });
    });

    it("edits a post for a linked account", async () => {
      const { client, initialized } = await useClient();

      initialized.context.linkageStore.set("poster.near", {
        nearAccount: "poster.near",
        discourseUsername: "poster",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: "2024-01-01T00:00:00.000Z",
      });

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("poster.near")
      );
      vi.spyOn(initialized.context.discourseService, "editPost").mockReturnValue(
        Effect.succeed({
          id: 11,
          topicId: 22,
          topicSlug: "hello-world",
          postUrl: "/p/11",
        })
      );

      const result = await client.editPost({
        authToken: "token",
        postId: 11,
        raw: "Updated post content that meets the minimum length.",
        editReason: "typo",
      });

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.near.vote/p/11",
        postId: 11,
        topicId: 22,
      });
    });

    it("unlinks an account through the router", async () => {
      const { client, initialized } = await useClient();

      initialized.context.linkageStore.set("unlink.near", {
        nearAccount: "unlink.near",
        discourseUsername: "unlinkUser",
        discourseUserId: 2,
        userApiKey: "key",
        verifiedAt: "2024-01-01T00:00:00.000Z",
      });

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("unlink.near")
      );

      const result = await client.unlinkAccount({ authToken: "token" });

      expect(result).toEqual({
        success: true,
        message: expect.stringContaining("Successfully unlinked"),
      });
      expect(initialized.context.linkageStore.get("unlink.near")).toBeNull();
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
          authToken: "fake-auth-token",
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
          authToken: "auth-token",
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
          authToken: "auth-token",
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
            authToken: "auth-token",
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
      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("alice.near")
      );

      const result = await client.completeLink({
        payload: "encrypted",
        nonce,
        authToken: "valid-auth",
      });

      expect(result).toEqual({
        success: true,
        nearAccount: "alice.near",
        discourseUsername: "alice",
        message: "Successfully linked alice.near to alice",
      });

      const linkage = initialized.context.linkageStore.get("alice.near");
      expect(linkage?.discourseUsername).toBe("alice");
      expect(initialized.context.nonceManager.get(nonce)).toBeNull();
    });

    it("should respect configured signature TTL during linking", async () => {
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
      const verifySpy = vi
        .spyOn(initialized.context.nearService, "verifySignature")
        .mockReturnValue(Effect.succeed("alice.near"));

      await client.completeLink({
        payload: "encrypted",
        nonce,
        authToken: "valid-auth",
      });

      expect(verifySpy).toHaveBeenCalledWith(
        "valid-auth",
        TEST_CONFIG.variables.signatureTtlMs
      );
    });

    it("should return UNAUTHORIZED when NEAR verification fails", async () => {
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
      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.fail(new Error("invalid signature"))
      );

      await expect(
        client.completeLink({
          payload: "encrypted",
          nonce,
          authToken: "invalid-auth",
        })
      ).rejects.toThrow("NEAR signature verification failed");

      expect(initialized.context.nonceManager.get(nonce)).toBeNull();
    });
  });

  describe("createPost procedure", () => {
    it("should surface signature verification failures", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.fail(new Error("signature failed"))
      );

      await expect(
        client.createPost({
          authToken: "bad-auth-token",
          title: "Test Post Title Here",
          raw: "This is a test post content that is long enough.",
        })
      ).rejects.toThrow("NEAR signature verification failed");
    });

    it("should stringify non-Error signature failures", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.fail(new Error("signature failed as string"))
      );

      await expect(
        client.createPost({
          authToken: "bad-auth-token",
          title: "Test Post Title Here",
          raw: "This is a test post content that is long enough.",
        })
      ).rejects.toThrow("NEAR signature verification failed");
    });

    it("should reject when no linkage exists", async () => {
      const { client } = await useClient();

      await expect(
        client.createPost({
          authToken: "fake-auth-token",
          title: "Test Post Title Here",
          raw: "This is a test post content that is long enough.",
        })
      ).rejects.toThrow();
    });

    it("should return FORBIDDEN with linkage details when signature succeeds but no linkage", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("unlinked.near")
      );

      await expect(
        client.createPost({
          authToken: "valid-auth-token",
          title: "Test Post Title Here",
          raw: "This is a test post content that is long enough.",
        })
      ).rejects.toThrow("No linked Discourse account. Please link your account first.");
    });

    it("should reject when replying without topicId", async () => {
      const { client } = await useClient();

      await expect(
        client.createPost({
          authToken: "fake-auth-token",
          replyToPostNumber: 1,
          raw: "Reply content that is definitely long enough to be valid.",
        })
      ).rejects.toThrow();
    });

    it("should bubble up Discourse errors", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      vi.spyOn(initialized.context.discourseService, "createPost").mockReturnValue(
        Effect.fail(new Error("discourse create failed"))
      );

      await expect(
        client.createPost({
          authToken: "valid-token",
          title: "Valid Title With Enough Length",
          raw: "This is a valid post content that is long enough to post.",
          category: 5,
        })
      ).rejects.toThrow("discourse create failed");
    });

    it("should create a post when linkage exists", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 11,
          topic_id: 22,
          topic_slug: "hello-world",
        }),
      });

      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.createPost({
        authToken: "valid-token",
        title: "Valid Title With Enough Length",
        raw: "This is a valid post content that is long enough to post.",
        category: 5,
      });

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
        success: true,
        postUrl: "https://discuss.near.vote/t/hello-world/22",
        postId: 11,
        topicId: 22,
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
      initialized.context.config.variables.discourseBaseUrl = "https://discuss.near.vote/";

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.createPost({
        authToken: "valid-token",
        title: "Valid Title With Enough Length",
        raw: "This is a valid post content that is long enough to post.",
        category: 5,
      });

      expect(result.postUrl).toBe("https://discuss.near.vote/t/normalized-url/24");

      initialized.context.config.variables.discourseBaseUrl = originalBaseUrl;
    });

    it("should create a reply when linkage exists and replying to a topic", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 12,
          topic_id: 22,
          topic_slug: "hello-world",
        }),
      });

      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.createPost({
        authToken: "valid-token",
        topicId: 22,
        replyToPostNumber: 1,
        raw: "Reply content that is definitely long enough to be valid.",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.near.vote/posts.json",
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
        postUrl: "https://discuss.near.vote/t/hello-world/22",
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

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      await expect(
        client.createPost({
          authToken: "valid-token",
          title: "Valid Title With Enough Length",
          raw: "This is a valid post content that is long enough to post.",
          category: 5,
        })
      ).rejects.toThrow("Discourse response missing topic_slug/topic_id");
    });
  });

  describe("editPost procedure", () => {
    it("should surface signature verification failures", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.fail(new Error("signature failed"))
      );

      await expect(
        client.editPost({
          authToken: "bad-token",
          postId: 123,
          raw: "Updated content that is long enough to be valid.",
        })
      ).rejects.toThrow("NEAR signature verification failed");
    });

    it("should bubble up Discourse errors", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      vi.spyOn(initialized.context.discourseService, "editPost").mockReturnValue(
        Effect.fail(new Error("discourse edit failed"))
      );

      await expect(
        client.editPost({
          authToken: "valid-token",
          postId: 55,
          raw: "Updated content that is long enough to be valid.",
        })
      ).rejects.toThrow("discourse edit failed");
    });

    it("should forbid edit when signature is valid but linkage missing", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("unlinked.near")
      );

      await expect(
        client.editPost({
          authToken: "valid-token",
          postId: 77,
          raw: "Updated content that is long enough to be valid.",
        })
      ).rejects.toThrow("No linked Discourse account. Please link your account first.");
    });

    it("should reject when no linkage exists", async () => {
      const { client } = await useClient();

      await expect(
        client.editPost({
          authToken: "fake-auth-token",
          postId: 123,
          raw: "This is updated content that is long enough to be valid.",
        })
      ).rejects.toThrow();
    });

    it("should edit a post when linkage exists", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          post: {
            id: 55,
            topic_id: 66,
            topic_slug: "edited-topic",
            post_url: "https://discuss.near.vote/p/55",
          },
        }),
      });

      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.editPost({
        authToken: "valid-token",
        postId: 55,
        raw: "Updated content that is long enough to pass validation.",
        editReason: "typo",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.near.vote/posts/55.json",
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
        postUrl: "https://discuss.near.vote/p/55",
        postId: 55,
        topicId: 66,
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

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.editPost({
        authToken: "valid-token",
        postId: 56,
        raw: "Updated content that is long enough.",
      });

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.near.vote/p/56",
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
      initialized.context.config.variables.discourseBaseUrl = "https://discuss.near.vote/";

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.editPost({
        authToken: "valid-token",
        postId: 59,
        raw: "Updated content that is long enough.",
      });

      expect(result.postUrl).toBe("https://discuss.near.vote/p/59");

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
            post_url: "https://discuss.near.vote/p/58",
          },
        }),
      });

      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.editPost({
        authToken: "valid-token",
        postId: 58,
        raw: "Updated content that is long enough.",
      });

      expect(result).toEqual({
        success: true,
        postUrl: "https://discuss.near.vote/p/58",
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

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("linked.near")
      );

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      await expect(
        client.editPost({
          authToken: "valid-token",
          postId: 57,
          raw: "Updated content that is long enough to be valid.",
        })
      ).rejects.toThrow("Discourse response missing topicSlug/topicId");
    });
  });

  describe("validateLinkage procedure", () => {
    it("should report invalid when no linkage exists", async () => {
      const { client } = await useClient();

      const result = await client.validateLinkage({
        nearAccount: "missing.near",
      });

      expect(result).toEqual({
        valid: false,
        error: "No linkage found for this NEAR account",
      });
    });

    it("should report invalid when Discourse key fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      });

      const { client, initialized } = await useClient();

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "bad-key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.validateLinkage({
        nearAccount: "linked.near",
      });

      expect(result).toEqual({
        valid: false,
        discourseUsername: "alice",
        error: expect.stringContaining("401"),
      });
      expect(initialized.context.linkageStore.get("linked.near")).toBeNull();
    });

    it("should not unlink when validation failure is retryable", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => "maintenance",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => "still maintenance",
        });

      const { client, initialized } = await useClient();

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "maybe-ok",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.validateLinkage({
        nearAccount: "linked.near",
      });

      expect(result).toEqual({
        valid: false,
        discourseUsername: "alice",
        error: expect.stringContaining("503"),
      });
      expect(initialized.context.linkageStore.get("linked.near")).not.toBeNull();
    });

    it("should confirm linkage when API key is valid", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_user: {
            id: 42,
            username: "alice",
            name: "Alice",
            avatar_template: "/avatar.png",
            title: "Title",
            trust_level: 2,
            moderator: false,
            admin: false,
          },
        }),
      });

      const { client, initialized } = await useClient();

      initialized.context.linkageStore.set("linked.near", {
        nearAccount: "linked.near",
        discourseUsername: "alice",
        discourseUserId: 42,
        userApiKey: "good-key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.validateLinkage({
        nearAccount: "linked.near",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.near.vote/session/current.json",
        expect.objectContaining({
          headers: expect.objectContaining({
            "User-Api-Key": "good-key",
            Accept: "application/json",
          }),
        })
      );

      expect(result).toEqual({
        valid: true,
        discourseUsername: "alice",
        discourseUser: {
          id: 42,
          username: "alice",
          name: "Alice",
          avatarTemplate: "/avatar.png",
          title: "Title",
          trustLevel: 2,
          moderator: false,
          admin: false,
        },
      });
    });
  });

  describe("unlinkAccount procedure", () => {
    it("should unlink when linkage exists", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("alice.near")
      );

      initialized.context.linkageStore.set("alice.near", {
        nearAccount: "alice.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const result = await client.unlinkAccount({ authToken: "valid-token" });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Successfully unlinked alice.near");
      expect(initialized.context.linkageStore.get("alice.near")).toBeNull();
    });

    it("should return service unavailable when remove fails", async () => {
      const { client, initialized } = await useClient();

      vi.spyOn(initialized.context.nearService, "verifySignature").mockReturnValue(
        Effect.succeed("alice.near")
      );

      initialized.context.linkageStore.set("alice.near", {
        nearAccount: "alice.near",
        discourseUsername: "alice",
        discourseUserId: 1,
        userApiKey: "key",
        verifiedAt: new Date().toISOString(),
      });

      const removeSpy = vi
        .spyOn(initialized.context.linkageStore, "remove")
        .mockReturnValue(false);

      await expect(
        client.unlinkAccount({ authToken: "valid-token" })
      ).rejects.toThrow();

      removeSpy.mockRestore();
    });

    it("should return NOT_FOUND when no linkage exists", async () => {
      const { client, initialized } = await useClient();

      const verifySpy = vi
        .spyOn(initialized.context.nearService, "verifySignature")
        .mockReturnValue(Effect.succeed("ghost.near"));

      await expect(
        client.unlinkAccount({ authToken: "ghost-token" })
      ).rejects.toThrow("No linked Discourse account found for this NEAR account");

      expect(verifySpy).toHaveBeenCalledWith(
        "ghost-token",
        TEST_CONFIG.variables.signatureTtlMs
      );
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
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
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
          users: [
            {
              id: 5,
              username: "alice",
              name: "Alice",
              avatar_template: "/avatar.png",
              title: "Title",
              trust_level: 2,
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
              topic_count: 1,
              post_count: 1,
              parent_category_id: null,
              read_restricted: false,
            },
          ],
          grouped_search_result: {
            post_ids: [1],
            more_full_page_results: "more",
          },
        }),
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
        json: async () => ({
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
        }),
      });

      const { client } = await useClient();

      const result = await client.getTopic({ topicId: 2 });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.near.vote/t/2.json",
        expect.any(Object)
      );
      expect(result.topic.title).toBe("Topic Title");
    });

    it("should fetch a post with topic", async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 5,
            topic_id: 10,
            post_number: 1,
            username: "alice",
            name: "Alice",
            avatar_template: "/avatar.png",
            cooked: "<p>Cooked</p>",
            created_at: "2024-01-01",
            updated_at: "2024-01-02",
            reply_count: 0,
            like_count: 1,
            reply_to_post_number: null,
            can_edit: true,
            version: 2,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
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
          }),
        });

      const { client } = await useClient();

      const result = await client.getPost({ postId: 5, includeRaw: false });

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
      expect(result.post.id).toBe(5);
      expect(result.topic.id).toBe(10);
    });

    it("should fetch a user", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            id: 7,
            username: "bob",
            name: "Bob",
            avatar_template: "/avatar.png",
            title: "Member",
            trust_level: 1,
            moderator: false,
            admin: false,
            created_at: "2024-01-01",
            last_posted_at: null,
            last_seen_at: null,
            post_count: 3,
            badge_count: 1,
            profile_view_count: 5,
          },
        }),
      });

      const { client } = await useClient();

      const result = await client.getUser({ username: "bob" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.near.vote/u/bob.json",
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
              {
                id: 1,
                name: "General",
                slug: "general",
                description: null,
                color: "fff",
                topic_count: 1,
                post_count: 1,
                parent_category_id: null,
                read_restricted: false,
              },
            ],
          },
        }),
      });

      const { client } = await useClient();

      const result = await client.getCategories();

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.near.vote/categories.json",
        expect.any(Object)
      );
      expect(result.categories[0].name).toBe("General");
    });

    it("should fetch category details", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          category: {
            id: 10,
            name: "General",
            slug: "general",
            description: null,
            color: "fff",
            topic_count: 1,
            post_count: 1,
            parent_category_id: null,
            read_restricted: false,
          },
          subcategory_list: [],
        }),
      });

      const { client } = await useClient();

      const result = await client.getCategory({ idOrSlug: "general" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.near.vote/c/general/show.json",
        expect.any(Object)
      );
      expect(result.category.slug).toBe("general");
      expect(result.subcategories).toHaveLength(0);
    });

    it("should fetch latest topics", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          topic_list: {
            topics: [
              {
                id: 1,
                title: "Latest Topic",
                slug: "latest-topic",
                category_id: 3,
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
        "https://discuss.near.vote/c/3/l/latest.json?page=2&order=activity",
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
              {
                id: 9,
                title: "Top Topic",
                slug: "top-topic",
                category_id: 7,
                created_at: "2024-01-01",
                last_posted_at: "2024-01-02",
                posts_count: 3,
                reply_count: 2,
                like_count: 5,
                views: 50,
                pinned: false,
                closed: false,
                archived: false,
                visible: true,
              },
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
        "https://discuss.near.vote/c/7/l/top/weekly.json?page=1",
        expect.any(Object)
      );
      expect(result.topics[0].title).toBe("Top Topic");
      expect(result.hasMore).toBe(false);
      expect(result.nextPage).toBeNull();
    });

    it("should fetch replies for a post", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 6,
            topic_id: 10,
            post_number: 2,
            username: "bob",
            name: "Bob",
            avatar_template: "/avatar2.png",
            cooked: "<p>Reply</p>",
            created_at: "2024-01-02",
            updated_at: "2024-01-02",
            reply_count: 0,
            like_count: 0,
            reply_to_post_number: 1,
          },
        ],
      });

      const { client } = await useClient();

      const result = await client.getPostReplies({ postId: 5 });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://discuss.near.vote/posts/5/replies.json",
        expect.any(Object)
      );
      expect(result.replies[0].id).toBe(6);
      expect(result.replies[0].replyToPostNumber).toBe(1);
    });
  });

  describe("runtime lifecycle", () => {
    it("should shutdown a new runtime cleanly", async () => {
      const tempRuntime = createRuntime();

      const { initialized } = await tempRuntime.usePlugin(
        "@neargov/discourse",
        TEST_CONFIG
      );
      expect(initialized.plugin.id).toBe("@neargov/discourse");

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
        await tempRuntime.usePlugin("@neargov/discourse", {
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
