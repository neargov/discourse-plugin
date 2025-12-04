import { Effect } from "every-plugin/effect";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { DiscourseService } from "../../service";

const baseUrl = "https://discuss.example.com";
const systemApiKey = "system-key";
const systemUsername = "system-user";

const makeJsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: {
    get: (name: string) =>
      name.toLowerCase() === "content-type" ? "application/json" : undefined,
  },
  text: async () => JSON.stringify(body),
});

const makeService = (fetchImpl: any) =>
  new DiscourseService(baseUrl, systemApiKey, systemUsername, undefined, {
    fetchImpl,
  });

describe("DiscourseService resource smoke tests", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("retrieves a post with its topic", async () => {
    fetchMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 10,
          topic_id: 2,
          post_number: 1,
          username: "alice",
          name: "Alice",
          avatar_template: "",
          raw: "hello world",
          cooked: "<p>hello world</p>",
          created_at: null,
          updated_at: null,
          reply_count: 0,
          like_count: 0,
          reply_to_post_number: null,
          version: 1,
        })
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 2,
          slug: "hello-world",
          title: "Hello world",
          category_id: null,
          created_at: "2024-01-01T00:00:00Z",
          last_posted_at: null,
          posts_count: 1,
          reply_count: 0,
          like_count: 0,
          views: 1,
          pinned: false,
          closed: false,
          archived: false,
          visible: true,
        })
      );

    const service = makeService(fetchMock);
    const result = await Effect.runPromise(service.getPost(10, true));

    expect(result.post.raw).toBe("hello world");
    expect(result.topic.title).toBe("Hello world");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${baseUrl}/posts/10.json`,
      expect.objectContaining({ method: "GET" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${baseUrl}/t/2.json`,
      expect.objectContaining({ method: "GET" })
    );
  });

  it("presigns uploads and normalizes headers", async () => {
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        key: "uploads/key",
        upload_url: "https://uploads.example.com/part",
        headers: { "content-type": "text/plain" },
        unique_identifier: "abc123",
      })
    );

    const service = makeService(fetchMock);
    const result = await Effect.runPromise(
      service.presignUpload({
        filename: "note.txt",
        byteSize: 42,
        contentType: "text/plain",
      })
    );

    expect(result.method).toBe("PUT");
    expect(result.headers).toEqual({ "content-type": "text/plain" });
    expect(result.uploadUrl).toContain("uploads.example.com");
  });

  it("fetches user status", async () => {
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        status: {
          emoji: ":wave:",
          description: "Hello",
          ends_at: null,
        },
      })
    );

    const service = makeService(fetchMock);
    const result = await Effect.runPromise(service.getUserStatus("alice"));

    expect(result.status).toEqual({
      emoji: ":wave:",
      description: "Hello",
      endsAt: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/u/alice/status.json`,
      expect.objectContaining({ method: "GET" })
    );
  });
});
