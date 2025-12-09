import { describe, expect, it } from "vitest";
import { Effect } from "every-plugin/effect";
import { normalizeHeaderValues } from "../../resources/shared";
import { mapTagGroup as mapTagGroupResource } from "../../resources/tags";
import { normalizePermissions } from "../../resources/shared";
import { createPostsResource } from "../../resources/posts";
import type { ResourceClient } from "../../client";

describe("resources helpers", () => {
  const makeStubClient = (response?: Record<string, unknown>) => {
    const requests: any[] = [];
    const client: ResourceClient = {
      buildUrl: (path) => path,
      getNormalizedBaseUrl: () => "",
      resolvePath: (path) => path,
      buildQuery: () => "",
      buildRequest: (_path, _options) =>
        ({
          url: "/posts",
          methodUpper: "POST",
          headers: {},
          effectiveTimeout: 0,
        }) as any,
      normalizeHeaderValues: (headers) => (headers as any) ?? {},
      fetchApi: async (_path, options) => {
        requests.push(options);
        return { success: true, post_action_type_id: 3, id: 7, ...response } as any;
      },
    };

    return { client, requests };
  };

  it("normalizes header values by stringifying and dropping undefined", () => {
    const headers = normalizeHeaderValues({
      Accept: "json",
      "X-Number": 42,
      "X-Undefined": undefined,
      "X-Null": null as any,
    });

    expect(headers).toEqual({
      Accept: "json",
      "X-Number": "42",
    });
  });

  it("normalizes empty header inputs to an empty object", () => {
    expect(normalizeHeaderValues(undefined as any)).toEqual({});
  });

  it("throws when tag group payload is not an object", () => {
    expect(() => mapTagGroupResource(null as any)).toThrow(/Malformed tag group response/);
  });

  it("normalizes permissions booleans and numbers while skipping invalid", () => {
    const normalized = normalizePermissions({
      can_read: true,
      can_write: false,
      priority: 2,
      unknown: "nan" as any,
    });

    expect(normalized).toEqual({
      can_read: 1,
      can_write: 0,
      priority: 2,
    });
  });

  it("marks flagTopic when post actions target the topic", async () => {
    const { client, requests } = makeStubClient();
    const posts = createPostsResource(client);

    const effect = posts.performPostAction({
      postId: 42,
      action: "flag",
      username: "mod",
      mode: { mode: "flag", target: "topic" },
    });

    await Effect.runPromise(effect as any);

    const requestBody = (requests[0] as any).body as any;
    expect(requestBody.flag_topic).toBe(true);
    expect(requestBody.take_action).toBeUndefined();
  });

  it("defaults to undo mode for unlikes when mode is omitted", async () => {
    const { client, requests } = makeStubClient();
    const posts = createPostsResource(client);

    await Effect.runPromise(
      posts.performPostAction({
        postId: 9,
        action: "unlike",
        username: "user",
      }) as any
    );

    const requestBody = (requests[0] as any).body as any;
    expect(requestBody.undo).toBe(true);
    expect(requestBody.flag_topic).toBeUndefined();
    expect(requestBody.take_action).toBeUndefined();
  });

  it("defaults flag mode to post target with no resolution", async () => {
    const { client, requests } = makeStubClient();
    const posts = createPostsResource(client);

    await Effect.runPromise(
      posts.performPostAction({
        postId: 11,
        action: "flag",
        username: "mod",
      }) as any
    );

    const body = (requests[0] as any).body as any;
    expect(body.flag_topic).toBeUndefined();
    expect(body.take_action).toBeUndefined();
    expect(body.undo).toBe(false);
  });

  it("sets take_action flag when provided via resolution", async () => {
    const { client, requests } = makeStubClient();
    const posts = createPostsResource(client);

    await Effect.runPromise(
      posts.performPostAction({
        postId: 17,
        action: "flag",
        username: "mod",
        mode: { mode: "flag", resolution: "take_action" },
      }) as any
    );

    const body = (requests[0] as any).body as any;
    expect(body.take_action).toBe(true);
    expect(body.flag_topic).toBeUndefined();
    expect(body.undo).toBe(false);
  });
});
