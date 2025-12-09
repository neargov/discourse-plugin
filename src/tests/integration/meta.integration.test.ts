import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "every-plugin/effect";
import {
  validCategoryPayload,
  validPostPayload,
  validSearchResponse,
  validTagGroupPayload,
  validTagPayload,
  validTopicPayload,
  validUserPayload,
} from "../fixtures";
import { setupIntegrationTest, TEST_CONFIG } from "./helpers";

const ctx = setupIntegrationTest();

describe("meta and content flows", () => {
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  describe("logging and metrics wiring", () => {
    it("records request logger payloads and retry metrics through the router", async () => {
      const requestLogs: any[] = [];
      ctx.fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          headers: {
            get: (key: string) =>
              key.toLowerCase() === "content-length"
                ? "0"
                : key.toLowerCase() === "retry-after"
                ? "0.01"
                : null,
          },
          text: async () => "",
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: {
            get: (key: string) =>
              key.toLowerCase() === "content-type"
                ? "application/json"
                : key.toLowerCase() === "content-length"
                ? "2"
                : null,
          },
          text: async () =>
            JSON.stringify({ category_list: { categories: [] } }),
        });

      const loggingConfig = {
        ...TEST_CONFIG,
        requestLogger: (payload: unknown) => {
          requestLogs.push(payload);
        },
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      };

      const { client, initialized } = await ctx.runtime.usePlugin(
        "discourse-plugin",
        loggingConfig
      );

      (initialized.context.discourseService as any).requestLogger = (
        payload: unknown
      ) => requestLogs.push(payload);

      await client.getCategories();

      expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
      expect(requestLogs.length).toBeGreaterThanOrEqual(2);
      const [firstLog, secondLog] = requestLogs;
      expect(firstLog).toMatchObject({
        method: "GET",
        path: "https://discuss.example.com/categories.json",
        attempt: 1,
        outcome: expect.stringMatching(/fail|retry/),
        status: 503,
      });
      expect(secondLog).toMatchObject({
        method: "GET",
        path: "https://discuss.example.com/categories.json",
        outcome: "success",
      });
      expect(initialized.context.metrics.retryAttempts).toBe(1);
    });
  });

  describe("retry-after backoff", () => {
    it("retries once using retryAfterMs before surfacing result", async () => {
      const { client } = await ctx.useClient();

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

      ctx.fetchMock
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

      expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
      expect(result.categories).toEqual(categories);
    });

    it("retries server errors with retry-after metadata", async () => {
      const { client } = await ctx.useClient();

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

      ctx.fetchMock
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

      expect(ctx.fetchMock).toHaveBeenCalledTimes(2);
      expect(result.categories).toEqual(expected);
    });

    // Removed redundant timing-heavy retry test
  });

  describe("search procedure", () => {
    it("returns mapped search results", async () => {
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

      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => searchResponse,
      });

      const { client } = await ctx.useClient();

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

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/search.json?q=hello+%23general+%40alice+tags%3Atag1+before%3A2024-02-01+after%3A2023-12-01+order%3Alatest+status%3Aopen+in%3Atitle&page=2",
        expect.any(Object)
      );

      expect(result.posts[0]).toEqual(
        expect.objectContaining({
          id: 1,
          topicId: 2,
          topicTitle: "Topic Title",
          blurb: "snippet",
        })
      );
      expect(result.topics[0].id).toBe(2);
      expect(result.users[0].username).toBe("alice");
      expect(result.categories[0].id).toBe(10);
      expect(result.totalResults).toBe(1);
      expect(result.hasMore).toBe(true);
    });
  });

  describe("read operations", () => {
    it("fetches a topic", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getTopic({ topicId: 2 });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/t/2.json",
        expect.any(Object)
      );
      expect(result.topic.title).toBe("Topic Title");
    });

    it("fetches a post with topic", async () => {
      ctx.fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => validPostPayload(),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => validTopicPayload(),
        });

      const { client } = await ctx.useClient();

      const result = await client.getPost({ postId: 5, includeRaw: false });

      expect(ctx.fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://discuss.example.com/posts/5.json",
        expect.any(Object)
      );
      expect(ctx.fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://discuss.example.com/t/10.json",
        expect.any(Object)
      );
      expect(result.post.id).toBe(5);
      expect(result.topic.id).toBe(10);
    });

    it("fetches a user", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getUser({ username: "bob" });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/u/bob.json",
        expect.any(Object)
      );
      expect(result.user.username).toBe("bob");
      expect(result.user.postCount).toBe(3);
    });

    it("fetches categories", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getCategories();

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/categories.json",
        expect.any(Object)
      );
      expect(result.categories[0].name).toBe("General");
    });

    it("fetches category details", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getCategory({ idOrSlug: "general" });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/c/general/show.json",
        expect.any(Object)
      );
      expect(result.category.slug).toBe("general");
      expect(result.subcategories).toHaveLength(0);
    });

    it("fetches site info", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const site = await client.getSiteInfo();

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/site.json",
        expect.any(Object)
      );
      expect(site.title).toBe("Example Forum");
      expect(site.categories[0].name).toBe("General");
    });

    it("fetches site basic info", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const site = await client.getSiteBasicInfo();

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/site/basic-info.json",
        expect.any(Object)
      );
      expect(site.title).toBe("Basic Forum");
      expect(site.canonicalHostname).toBe("basic.example.com");
    });

    it("fetches tags", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getTags();

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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

    it("fetches a tag", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getTag({ name: "feature" });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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

    it("fetches tag groups", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getTagGroups();

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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

    it("fetches a single tag group", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getTagGroup({ tagGroupId: 7 });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/tag_groups/7.json",
        expect.any(Object)
      );
      expect(result.tagGroup.tags?.[0].name).toBe("updates");
    });

    it("creates a tag group", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.createTagGroup({
        name: "New Group",
        tagNames: ["fresh"],
        parentTagNames: [],
        onePerTopic: true,
        permissions: { staff: 1 },
      });

      const [, options] = ctx.fetchMock.mock.calls[0];
      expect(ctx.fetchMock).toHaveBeenCalledWith(
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

    it("updates a tag group", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_group: validTagGroupPayload({
            id: 10,
            name: "Updated Group",
            tag_names: ["alpha"],
          }),
        }),
      });

      const { client } = await ctx.useClient();

      const result = await client.updateTagGroup({
        tagGroupId: 10,
        name: "Updated Group",
        tagNames: ["alpha"],
      });

      const [url, options] = ctx.fetchMock.mock.calls[0];
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

    it("fetches latest topics", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getLatestTopics({
        categoryId: 3,
        page: 2,
        order: "activity",
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/c/3/l/latest.json?page=2&order=activity",
        expect.any(Object)
      );
      expect(result.topics[0].title).toBe("Latest Topic");
      expect(result.hasMore).toBe(true);
      expect(result.nextPage).toBe(3);
    });

    it("fetches top topics", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getTopTopics({
        period: "weekly",
        categoryId: 7,
        page: 1,
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/c/7/l/top/weekly.json?page=1",
        expect.any(Object)
      );
      expect(result.topics[0].title).toBe("Top Topic");
      expect(result.hasMore).toBe(false);
      expect(result.nextPage).toBeNull();
    });

    it("fetches topic lists for new topics", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.listTopicList({ type: "new", page: 1 });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/new.json?page=1",
        expect.any(Object)
      );
      expect(result.topics[0].title).toBe("New Topic");
      expect(result.nextPage).toBeNull();
    });

    it("fetches category topics by slug and id", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getCategoryTopics({
        slug: "general",
        categoryId: 10,
        page: 2,
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/c/general/10.json?page=2",
        expect.any(Object)
      );
      expect(result.topics[0].slug).toBe("category-topic");
      expect(result.hasMore).toBe(true);
      expect(result.nextPage).toBe(3);
    });

    it("lists recent posts", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.listPosts({ page: 1 });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts.json?page=1",
        expect.any(Object)
      );
      expect(result.posts[0].id).toBe(21);
      expect(result.hasMore).toBe(true);
      expect(result.nextPage).toBe(2);
    });

    it("fetches replies for a post", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
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

      const { client } = await ctx.useClient();

      const result = await client.getPostReplies({ postId: 5 });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/posts/5/replies.json",
        expect.any(Object)
      );
      expect(result.replies[0].id).toBe(6);
      expect(result.replies[0].replyToPostNumber).toBe(1);
    });
  });

  describe("topic administration", () => {
    it("updates topic status and returns the refreshed topic", async () => {
      ctx.fetchMock
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

      const { client } = await ctx.useClient();

      const result = await client.updateTopicStatus({
        topicId: 42,
        status: "closed",
        enabled: true,
      });

      expect(ctx.fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://discuss.example.com/t/42/status",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ status: "closed", enabled: true }),
        })
      );
      expect(ctx.fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://discuss.example.com/t/42.json",
        expect.any(Object)
      );
      expect(result.topic.id).toBe(42);
      expect(result.topic.closed).toBe(true);
    });

    it("updates topic metadata when title and category are provided", async () => {
      const updatedTitle = "Updated topic title with enough length";
      ctx.fetchMock
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

      const { client } = await ctx.useClient();

      const result = await client.updateTopicMetadata({
        topicId: 10,
        title: updatedTitle,
        categoryId: 9,
      });

      expect(ctx.fetchMock).toHaveBeenNthCalledWith(
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
      const { client } = await ctx.useClient();

      await expect(client.updateTopicMetadata({ topicId: 1 })).rejects.toThrow(
        /input validation failed/i
      );
    });

    it("bookmarks a topic for the requesting user", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bookmark_id: 99 }),
      });

      const { client } = await ctx.useClient();

      const result = await client.bookmarkTopic({
        topicId: 5,
        username: "alice",
        userApiKey: "user-key",
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const { client } = await ctx.useClient();

      const result = await client.inviteToTopic({
        topicId: 7,
        usernames: ["alice", "bob"],
        groupNames: ["staff"],
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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
      const { client } = await ctx.useClient();

      await expect(
        client.inviteToTopic({
          topicId: 7,
          usernames: [],
          groupNames: [],
        })
      ).rejects.toThrow(/input validation failed/i);
    });

    it("sets topic notification level from string aliases", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ notification_level: 3 }),
      });

      const { client } = await ctx.useClient();

      const result = await client.setTopicNotification({
        topicId: 8,
        level: "watching",
        username: "alice",
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
        "https://discuss.example.com/t/8/notifications",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ notification_level: 3 }),
        })
      );
      expect(result.notificationLevel).toBe(3);
    });

    it("changes the topic timestamp and returns the updated topic", async () => {
      ctx.fetchMock
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

      const { client } = await ctx.useClient();

      const result = await client.changeTopicTimestamp({
        topicId: 11,
        timestamp: "2024-03-03T00:00:00.000Z",
      });

      expect(ctx.fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://discuss.example.com/t/11/change-timestamp",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            timestamp: "2024-03-03T00:00:00.000Z",
          }),
        })
      );
      expect(ctx.fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://discuss.example.com/t/11.json",
        expect.any(Object)
      );
      expect(result.topic.id).toBe(11);
      expect(result.topic.createdAt).toBe("2024-03-03T00:00:00.000Z");
    });

    it("adds a topic timer with timing options", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status_type: "close" }),
      });

      const { client } = await ctx.useClient();

      const result = await client.addTopicTimer({
        topicId: 12,
        statusType: "close",
        time: "2024-04-01T00:00:00.000Z",
        basedOnLastPost: true,
        durationMinutes: 45,
        categoryId: 4,
        username: "moderator",
      });

      expect(ctx.fetchMock).toHaveBeenCalledWith(
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
      ctx.fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current_user: validUserPayload({ id: 5, username: "alice" }),
        }),
      });

      const { client } = await ctx.useClient();

      const result = await client.validateUserApiKey({
        userApiKey: "user-key",
      });

      expect(result).toEqual({
        valid: true,
        user: expect.objectContaining({
          id: 5,
          username: "alice",
        }),
      });
    });

    it("maps retryable errors to TOO_MANY_REQUESTS", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "maintenance",
        headers: { get: () => null },
      });

      const { client } = await ctx.useClient();

      await expect(
        client.validateUserApiKey({ userApiKey: "user-key" })
      ).rejects.toThrow();
    });

    it("maps invalid keys to UNAUTHORIZED", async () => {
      ctx.fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
        headers: { get: () => null },
      });

      const { client } = await ctx.useClient();

      await expect(
        client.validateUserApiKey({ userApiKey: "bad-key" })
      ).rejects.toThrow();
    });
  });
});
