import { Effect } from "every-plugin/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupIntegrationTest, TEST_CONFIG } from "./helpers";

const ctx = setupIntegrationTest();

describe("post flows", () => {
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  describe("router flows", () => {
    it("creates a post for a provided username", async () => {
      const { client, initialized } = await ctx.useClient();

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
      const { client, initialized } = await ctx.useClient();

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

  describe("createPost procedure", () => {
    it("rejects when replying without topicId", async () => {
      const { client } = await ctx.useClient();

      await expect(
        client.createPost({
          username: "alice",
          replyToPostNumber: 1,
          raw: "Reply content that is definitely long enough to be valid.",
        })
      ).rejects.toThrow();
    });

    it("bubbles up Discourse errors", async () => {
      const { client, initialized } = await ctx.useClient();

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

    it("creates a post", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 11,
          topic_id: 22,
          topic_slug: "hello-world",
        }),
      });

      const { client, initialized } = await ctx.useClient();

      const result = await client.createPost({
        username: "alice",
        title: "Valid Title With Enough Length",
        raw: "This is a valid post content that is long enough to post.",
        category: 5,
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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

      initialized.context.config.variables = TEST_CONFIG.variables;
    });

    it("sends User-Api-Key when provided", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 21,
          topic_id: 42,
          topic_slug: "user-auth",
        }),
      });

      const { client } = await ctx.useClient();

      const result = await client.createPost({
        username: "alice",
        userApiKey: "user-key",
        title: "Valid Title With Enough Length",
        raw: "This is a valid post content that is long enough to post.",
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts.json",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "User-Api-Key": "user-key",
          }),
        })
      );
      expect(ctx.fetchMock).toHaveBeenCalledWith(
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
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 13,
          topic_id: 24,
          topic_slug: "normalized-url",
        }),
      });

      const { client, initialized } = await ctx.useClient();
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

    it("creates a reply when replying to a topic", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 12,
          topic_id: 22,
          topic_slug: "hello-world",
        }),
      });

      const { client } = await ctx.useClient();

      const result = await client.createPost({
        username: "alice",
        topicId: 22,
        replyToPostNumber: 1,
        raw: "Reply content that is definitely long enough to be valid.",
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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

    it("throws SERVICE_UNAVAILABLE when Discourse response is missing topic fields", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: undefined,
          topic_id: undefined,
          topic_slug: undefined,
        }),
      });

      const { client } = await ctx.useClient();

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
    it("bubbles up Discourse errors", async () => {
      const { client, initialized } = await ctx.useClient();

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

    it("edits a post", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.editPost({
        username: "alice",
        postId: 55,
        raw: "Updated content that is long enough to pass validation.",
        editReason: "typo",
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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

    it("sends User-Api-Key when provided for edits", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.editPost({
        username: "alice",
        userApiKey: "user-key",
        postId: 65,
        raw: "Updated content that is long enough to pass validation.",
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts/65.json",
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            "User-Api-Key": "user-key",
          }),
        })
      );
      expect(ctx.fetchMock).toHaveBeenCalledWith(
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

    it("falls back to constructed postUrl when missing", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

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
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client, initialized } = await ctx.useClient();
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

    it("returns provided postUrl when present", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

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

    it("throws SERVICE_UNAVAILABLE when response lacks topic metadata", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      await expect(
        client.editPost({
          username: "alice",
          postId: 57,
          raw: "Updated content that is long enough to be valid.",
        })
      ).rejects.toThrow("Discourse response missing topicSlug/topicId");
    });
  });
});
