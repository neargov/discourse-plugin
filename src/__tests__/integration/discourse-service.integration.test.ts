import { Effect } from "every-plugin/effect";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DiscourseService } from "../../service";

const baseUrl = "https://discuss.example.com";
const systemApiKey = "system-key";
const systemUsername = "system-user";

const makeService = (fetchImpl: any) =>
  new DiscourseService(baseUrl, systemApiKey, systemUsername, undefined, {
    fetchImpl,
    requestLogger: vi.fn(),
  });

describe("DiscourseService (integration-style with mocked fetch)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("maps categories end-to-end", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : undefined,
      },
      text: async () =>
        JSON.stringify({
          category_list: {
            categories: [
              {
                id: 1,
                name: "General",
                slug: "general",
                description: "Welcome",
                color: "0088CC",
                topic_count: 5,
                post_count: 10,
                parent_category_id: null,
                read_restricted: false,
              },
            ],
          },
        }),
    });

    const service = makeService(fetchMock);
    const categories = await Effect.runPromise(service.getCategories());

    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/categories.json`,
      expect.objectContaining({ method: "GET" })
    );
    expect(categories).toEqual([
      {
        id: 1,
        name: "General",
        slug: "general",
        description: "Welcome",
        color: "0088CC",
        topicCount: 5,
        postCount: 10,
        parentCategoryId: null,
        readRestricted: false,
      },
    ]);
  });

  it("maps search results and totals", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : undefined,
      },
      text: async () =>
        JSON.stringify({
          posts: [
          {
            id: 10,
            topic_id: 2,
            post_number: 1,
            username: "alice",
            cooked: "<p>hello</p>",
            topic_title_headline: "Hello world",
            blurb: "hello",
          },
          ],
          topics: [
            {
              id: 2,
              slug: "hello-world",
              title: "Hello world",
              category_id: null,
              created_at: "2024-01-01T00:00:00Z",
              last_posted_at: null,
              posts_count: 1,
              reply_count: 0,
              like_count: 0,
              views: 10,
              pinned: false,
              closed: false,
              archived: false,
              visible: true,
            },
          ],
          users: [
            {
              id: 99,
              username: "alice",
              name: "Alice",
              avatar_template: "/images/avatar.png",
              title: null,
              trust_level: 1,
              moderator: false,
              admin: false,
            },
          ],
          categories: [],
          grouped_search_result: {
            post_ids: [10],
            more_full_page_results: false,
          },
        }),
    });

    const service = makeService(fetchMock);
    const result = await Effect.runPromise(service.search({ query: "hello" }));

    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/search.json?q=hello&page=1`,
      expect.objectContaining({ method: "GET" })
    );
    expect(result.posts[0]).toMatchObject({
      id: 10,
      topicId: 2,
      postNumber: 1,
      username: "alice",
      topicTitle: "Hello world",
      blurb: "hello",
    });
    expect(result.topics[0]).toMatchObject({
      id: 2,
      title: "Hello world",
      slug: "hello-world",
    });
    expect(result.users[0]).toMatchObject({
      id: 99,
      username: "alice",
      name: "Alice",
    });
    expect(result.totalResults).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("creates a post happy-path and surfaces errors", async () => {
    // First call succeeds
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "application/json" : undefined,
      },
      text: async () =>
        JSON.stringify({
          id: 123,
          topic_id: 456,
          topic_slug: "hello-world",
        }),
    });

    const service = makeService(fetchMock);
    const post = await Effect.runPromise(
      service.createPost({
        title: "Hello world title",
        raw: "This is the content of the post",
        category: 1,
        username: "alice",
      })
    );

    expect(post).toEqual({ id: 123, topic_id: 456, topic_slug: "hello-world" });
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/posts.json`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Api-Key": systemApiKey,
          "Api-Username": "alice",
        }),
      })
    );

    // Error path surfaces with informative message
    const errorFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: { get: () => "0" },
      text: async () => "",
    });

    const errorService = makeService(errorFetch);
    await expect(
      Effect.runPromise(
        errorService.createPost({
          title: "Title",
          raw: "Content content content",
          category: 1,
          username: "bob",
        })
      )
    ).rejects.toThrow(/503/);
  });
});
