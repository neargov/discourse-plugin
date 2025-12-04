import { z } from "every-plugin/zod";
import type { Post, PostActionMode, PostActionResult, Revision } from "../contract";
import type { ResourceClient } from "../client";
import { normalizeSuccessFlag, runWithContext } from "../client";
import { POST_ACTION_TYPE_MAP } from "../constants";
import { normalizePage, parseWithSchema, parseWithSchemaOrThrow } from "./shared";
import { mapTopic } from "./topics";

export const RawPostSchema = z.object({
  id: z.number(),
  topic_id: z.number(),
  post_number: z.number(),
  username: z.string(),
  name: z.string().nullable().default(null),
  avatar_template: z.string().default(""),
  raw: z.string().optional(),
  cooked: z.string(),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
  reply_count: z.number().default(0),
  like_count: z.number().default(0),
  reply_to_post_number: z.number().nullable().default(null),
  can_edit: z.boolean().optional(),
  version: z.number().default(1),
});

export const RawRevisionSchema = z
  .object({
    number: z.number().int().nonnegative(),
    post_id: z.number().int().positive(),
    user_id: z.number().int().positive().optional(),
    username: z.string().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    raw: z.string().optional(),
    cooked: z.string().optional(),
    changes: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

export const mapPost = (post: any, includeRaw: boolean): Post => {
  const parsed = parseWithSchemaOrThrow(
    RawPostSchema,
    post,
    "Post",
    "Malformed post response"
  );
  if (includeRaw && typeof parsed.raw !== "string") {
    throw new Error("Post validation failed: raw is required when includeRaw is true");
  }

  return {
    id: parsed.id,
    topicId: parsed.topic_id,
    postNumber: parsed.post_number,
    username: parsed.username,
    name: parsed.name,
    avatarTemplate: parsed.avatar_template,
    raw: includeRaw ? parsed.raw : undefined,
    cooked: parsed.cooked,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    replyCount: parsed.reply_count,
    likeCount: parsed.like_count,
    replyToPostNumber: parsed.reply_to_post_number,
    canEdit: parsed.can_edit,
    version: parsed.version,
  };
};

export const mapRevision = (revision: any, includeRaw: boolean): Revision => {
  const parsed = parseWithSchemaOrThrow(
    RawRevisionSchema,
    revision,
    "Revision",
    "Malformed revision response"
  );

  if (includeRaw && typeof parsed.raw !== "string") {
    throw new Error("Revision validation failed: raw is required when includeRaw is true");
  }

  return {
    number: parsed.number,
    postId: parsed.post_id,
    userId: parsed.user_id,
    username: parsed.username,
    createdAt: parsed.created_at ?? null,
    updatedAt: parsed.updated_at ?? null,
    raw: includeRaw ? parsed.raw : undefined,
    cooked: parsed.cooked,
    changes: parsed.changes,
  };
};

type PostsListResponse = { latest_posts?: any[]; more_posts_url?: string | null };

const resolvePostActionType = (
  action?: PostActionResult["action"],
  explicitTypeId?: number
): number => {
  if (typeof explicitTypeId === "number" && Number.isFinite(explicitTypeId) && explicitTypeId > 0) {
    return Math.floor(explicitTypeId);
  }

  /* c8 ignore start */
  const normalizedAction =
    typeof action === "string" && action.trim()
      ? action.trim().toLowerCase()
      : undefined;

  if (normalizedAction) {
    const mapped = POST_ACTION_TYPE_MAP[normalizedAction];
    if (mapped) {
      return mapped;
    }
  }
  /* c8 ignore stop */

  throw new Error("Unsupported or missing post action type");
};

type NormalizedPostActionMode = {
  flagTopic?: boolean;
  takeAction?: boolean;
  undo: boolean;
};

const normalizePostActionMode = (
  mode: PostActionMode | undefined,
  action: PostActionResult["action"] | undefined
): NormalizedPostActionMode => {
  const resolved = mode ?? (action === "unlike" ? { mode: "undo" as const } : { mode: "perform" as const });

  switch (resolved.mode) {
    case "flag": {
      const target = resolved.target ?? "post";
      const resolution = resolved.resolution ?? "flag";

      return {
        flagTopic: target === "topic" ? true : undefined,
        takeAction: resolution === "take_action" ? true : undefined,
        undo: false,
      };
    }
    case "undo":
      return { undo: true };
    case "perform":
    default:
      return { undo: false };
  }
};

export const createPostsResource = (client: ResourceClient) => ({
  createPost: (params: {
    title?: string;
    raw: string;
    category?: number;
    username: string;
    topicId?: number;
    replyToPostNumber?: number;
    userApiKey?: string;
  }) =>
    runWithContext("Create post", async () => {
      const data = await client.fetchApi<{
        id: number;
        topic_id: number;
        topic_slug: string;
      }>("/posts.json", {
        method: "POST",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: {
          title: params.title,
          raw: params.raw,
          category: params.category,
          topic_id: params.topicId,
          reply_to_post_number: params.replyToPostNumber,
        },
      });

      if (!data) {
        throw new Error("Empty response from create post");
      }

      return {
        id: data.id as number,
        topic_id: data.topic_id as number,
        topic_slug: data.topic_slug as string,
      };
    }),

  getPost: (postId: number, includeRaw: boolean = false) =>
    runWithContext("Get post", async () => {
      const postData = await client.fetchApi<any>(`/posts/${postId}.json`);
      if (!postData) {
        throw new Error("Empty post response");
      }
      const post = mapPost(postData, includeRaw);

      const topicData = await client.fetchApi<any>(`/t/${postData.topic_id}.json`);
      if (!topicData) {
        throw new Error("Empty topic response");
      }
      const topic = mapTopic(topicData);

      return { post, topic };
    }),

  getPostReplies: (postId: number) =>
    runWithContext("Get post replies", async () => {
      const data = await client.fetchApi<any[]>(`/posts/${postId}/replies.json`);
      return (data ?? []).map((p: any) => mapPost(p, false));
    }),

  listPosts: (params: { page?: number } = {}) =>
    runWithContext("List posts", async () => {
      const page = normalizePage(params.page, 0);
      const pageParam = page > 0 ? page : undefined;
      const path = client.buildQuery({ page: pageParam });
      const url = path ? `/posts.json?${path}` : "/posts.json";
      const data = await client.fetchApi<PostsListResponse>(url);
      if (!data) {
        return { posts: [], hasMore: false, nextPage: null };
      }

      const rawPosts = data.latest_posts;
      if (rawPosts != null && !Array.isArray(rawPosts)) {
        throw new Error("Malformed posts response");
      }

      const posts = (rawPosts ?? []).map((p: any) => mapPost(p, false));
      const hasMore = !!data.more_posts_url;

      return {
        posts,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      };
    }),

  editPost: (params: {
    postId: number;
    raw: string;
    username: string;
    editReason?: string;
    userApiKey?: string;
  }) =>
    runWithContext("Edit post", async () => {
      const data = await client.fetchApi<{ post: any }>(
        `/posts/${params.postId}.json`,
        {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: {
            post: {
              raw: params.raw,
              edit_reason: params.editReason,
            },
          },
        }
      );

      if (!data) {
        throw new Error("Empty edit response");
      }

      return {
        id: data.post.id as number,
        topicId: data.post.topic_id as number,
        topicSlug: data.post.topic_slug as string,
        postUrl: data.post.post_url as string | undefined,
      };
    }),

  lockPost: (params: {
    postId: number;
    locked: boolean;
    username: string;
    userApiKey?: string;
  }) =>
    runWithContext("Lock post", async () => {
      const data = await client.fetchApi<{ locked?: boolean }>(
        `/posts/${params.postId}/locked.json`,
        {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: { locked: params.locked },
        }
      );

      return {
        locked: typeof data?.locked === "boolean" ? data.locked : params.locked,
      };
    }),

  performPostAction: (params: {
    postId: number;
    action: PostActionResult["action"];
    postActionTypeId?: number;
    message?: string;
    mode?: PostActionMode;
    username: string;
    userApiKey?: string;
  }) =>
    runWithContext("Post action", async () => {
      const resolvedType = resolvePostActionType(
        params.action,
        params.postActionTypeId
      );
      const normalizedMode = normalizePostActionMode(params.mode, params.action);

      const data = await client.fetchApi<{
        id?: number;
        post_action_type_id?: number;
        success?: boolean | string;
      }>("/post_actions", {
        method: "POST",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: {
          id: params.postId,
          post_action_type_id: resolvedType,
          flag_topic: normalizedMode.flagTopic,
          message: params.message,
          take_action: normalizedMode.takeAction,
          undo: normalizedMode.undo,
        },
      });

      const postActionTypeId =
        typeof data?.post_action_type_id === "number"
          ? data.post_action_type_id
          : resolvedType;
      const postActionId = typeof data?.id === "number" ? data.id : undefined;
      const success = normalizeSuccessFlag(data?.success);

      if (success === undefined) {
        throw new Error("Post action response missing explicit success flag");
      }

      return {
        success,
        action: params.action,
        postActionTypeId,
        postActionId,
      };
    }),

  deletePost: (params: {
    postId: number;
    forceDestroy?: boolean;
    username: string;
    userApiKey?: string;
  }) =>
    runWithContext("Delete post", async () => {
      const path =
        params.forceDestroy === true
          ? `/posts/${params.postId}.json?force_destroy=true`
          : `/posts/${params.postId}.json`;

      const data = await client.fetchApi<{ success?: boolean | string; deleted?: boolean }>(
        path,
        {
          method: "DELETE",
          asUser: params.username,
          userApiKey: params.userApiKey,
        }
      );

      const success =
        normalizeSuccessFlag(data?.success) ??
        (typeof data?.deleted === "boolean" ? data.deleted : undefined);

      if (success === undefined) {
        throw new Error("Delete post response missing explicit success flag");
      }

      return { success };
    }),

  getRevision: (params: {
    postId: number;
    revision: number;
    includeRaw?: boolean;
    username?: string;
    userApiKey?: string;
  }) =>
    runWithContext("Get revision", async () => {
      const data = await client.fetchApi<{ revision?: any }>(
        `/posts/${params.postId}/revisions/${params.revision}.json`,
        {
          method: "GET",
          asUser: params.username,
          userApiKey: params.userApiKey,
        }
      );

      if (!data || !data.revision) {
        throw new Error("Empty revision response");
      }

      return {
        revision: mapRevision(data.revision, params.includeRaw ?? false),
      };
    }),

  updateRevision: (params: {
    postId: number;
    revision: number;
    raw: string;
    editReason?: string;
    username: string;
    userApiKey?: string;
  }) =>
    runWithContext("Update revision", async () => {
      const data = await client.fetchApi<{ revision?: any }>(
        `/posts/${params.postId}/revisions/${params.revision}.json`,
        {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: {
            revision: {
              raw: params.raw,
              edit_reason: params.editReason,
            },
          },
        }
      );

      if (!data || !data.revision) {
        throw new Error("Empty revision response");
      }

      return { revision: mapRevision(data.revision, true) };
    }),

  deleteRevision: (params: {
    postId: number;
    revision: number;
    username: string;
    userApiKey?: string;
  }) =>
    runWithContext("Delete revision", async () => {
      const data = await client.fetchApi<{ success?: boolean | string }>(
        `/posts/${params.postId}/revisions/${params.revision}.json`,
        {
          method: "DELETE",
          asUser: params.username,
          userApiKey: params.userApiKey,
        }
      );

      const success = normalizeSuccessFlag(data?.success);
      if (success === undefined) {
        throw new Error("Delete revision response missing explicit success flag");
      }

      return { success };
    }),

  resolvePostActionType,
});

export type PostsResource = ReturnType<typeof createPostsResource>;
export { resolvePostActionType };
