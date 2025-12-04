import { z } from "every-plugin/zod";
import type {
  PaginatedTopics,
  Topic,
  TopicNotificationLevel,
} from "../contract";
import { normalizeTopicNotificationLevel } from "../contract";
import type { ResourceClient } from "../client";
import { runWithContext } from "../client";
import { normalizePage, parseWithSchemaOrThrow } from "./shared";

export const RawTopicSchema = z.object({
  id: z.number(),
  slug: z.string(),
  title: z.string(),
  category_id: z.number().nullable().default(null),
  created_at: z.string().nullable().default(null),
  last_posted_at: z.string().nullable().default(null),
  posts_count: z.number().default(0),
  reply_count: z.number().default(0),
  like_count: z.number().default(0),
  views: z.number().default(0),
  pinned: z.boolean().default(false),
  closed: z.boolean().default(false),
  archived: z.boolean().default(false),
  visible: z.boolean().default(true),
});

export type TopicListResponse = { topic_list?: { topics?: any[]; more_topics_url?: string | null } };

export const mapTopic = (topic: any): Topic => {
  const parsed = parseWithSchemaOrThrow(
    RawTopicSchema,
    topic,
    "Topic",
    "Malformed topic response"
  );
  return {
    id: parsed.id,
    title: parsed.title,
    slug: parsed.slug,
    categoryId: parsed.category_id,
    createdAt: parsed.created_at,
    lastPostedAt: parsed.last_posted_at,
    postsCount: parsed.posts_count,
    replyCount: parsed.reply_count,
    likeCount: parsed.like_count,
    views: parsed.views,
    pinned: parsed.pinned,
    closed: parsed.closed,
    archived: parsed.archived,
    visible: parsed.visible,
  };
};

export const mapTopicList = (data: any | undefined, page: number): PaginatedTopics => {
  const hasMore = !!data?.topic_list?.more_topics_url;

  return {
    topics: data?.topic_list?.topics?.map((t: any) => mapTopic(t)) ?? [],
    hasMore,
    nextPage: hasMore ? page + 1 : null,
  };
};

export const createTopicsResource = (client: ResourceClient) => {
  const buildTopicListPath = (
    basePath: string,
    query: Record<string, string | number | undefined>
  ) => {
    const queryString = client.buildQuery(query);
    return queryString ? `${basePath}?${queryString}` : basePath;
  };

  const requestTopicList = (path: string) => client.fetchApi<TopicListResponse>(path);
  const requestTopic = (topicId: number) => client.fetchApi<any>(`/t/${topicId}.json`);

  return {
    getTopic: (topicId: number) =>
      runWithContext("Get topic", async () => {
        const data = await requestTopic(topicId);
        if (!data) {
          throw new Error("Empty topic response");
        }
        return mapTopic(data);
      }),

    getLatestTopics: (params: { categoryId?: number; page?: number; order?: string }) =>
      runWithContext("Get latest topics", async () => {
        const page = normalizePage(params.page, 0);

        const pageParam = page > 0 ? page : undefined;
        const orderParam =
          params.order && params.order !== "default" ? params.order : undefined;
        /* c8 ignore start */
        const basePath =
          params.categoryId != null
            ? `/c/${params.categoryId}/l/latest.json`
            : "/latest.json";
        /* c8 ignore stop */

        const path = buildTopicListPath(basePath, {
          page: pageParam,
          order: orderParam,
        });

        const data = await requestTopicList(path);
        return mapTopicList(data, page);
      }),

    getTopTopics: (params: { period: string; categoryId?: number; page?: number }) =>
      runWithContext("Get top topics", async () => {
        const page = normalizePage(params.page, 0);
        const pageParam = page > 0 ? page : undefined;
        /* c8 ignore start */
        const basePath = params.categoryId
          ? `/c/${params.categoryId}/l/top/${params.period}.json`
          : `/top/${params.period}.json`;
        /* c8 ignore stop */

        const path = buildTopicListPath(basePath, {
          page: pageParam,
        });

        const data = await requestTopicList(path);
        return mapTopicList(data, page);
      }),

    getTopicList: (params: {
      type: "latest" | "new" | "top";
      categoryId?: number;
      page?: number;
      order?: string;
      period?: string;
    }) =>
      runWithContext("Get topic list", async () => {
        const page = normalizePage(params.page, 0);
        const pageParam = page > 0 ? page : undefined;
        const orderParam =
          params.type === "latest" && params.order && params.order !== "default"
            ? params.order
            : undefined;
        const periodParam = params.period || "monthly";

        /* c8 ignore start */
        const basePath =
          params.type === "top"
            ? params.categoryId != null
              ? `/c/${params.categoryId}/l/top/${periodParam}.json`
              : `/top/${periodParam}.json`
            : params.type === "new"
              ? params.categoryId != null
                ? `/c/${params.categoryId}/l/new.json`
                : "/new.json"
              : params.categoryId != null
                ? `/c/${params.categoryId}/l/latest.json`
                : "/latest.json";
        /* c8 ignore stop */

        const path = buildTopicListPath(basePath, {
          page: pageParam,
          order: orderParam,
        });

        const data = await requestTopicList(path);
        return mapTopicList(data, page);
      }),

    getCategoryTopics: (params: { slug: string; categoryId: number; page?: number }) =>
      runWithContext("Get category topics", async () => {
        const page = normalizePage(params.page, 0);
        const pageParam = page > 0 ? page : undefined;
        const path = buildTopicListPath(
          `/c/${params.slug}/${params.categoryId}.json`,
          { page: pageParam }
        );

        const data = await requestTopicList(path);
        return mapTopicList(data, page);
      }),

    updateTopicStatus: (params: {
      topicId: number;
      status: "closed" | "archived" | "pinned" | "visible";
      enabled: boolean;
      username?: string;
      userApiKey?: string;
    }) =>
      runWithContext("Update topic status", async () => {
        await client.fetchApi<void>(`/t/${params.topicId}/status`, {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: {
            status: params.status,
            enabled: params.enabled,
          },
        });

        const data = await requestTopic(params.topicId);
        if (!data) {
          throw new Error("Empty topic response");
        }

        return { topic: mapTopic(data) };
      }),

    updateTopicMetadata: (params: {
      topicId: number;
      title?: string;
      categoryId?: number;
      username?: string;
      userApiKey?: string;
    }) =>
      runWithContext("Update topic metadata", async () => {
        await client.fetchApi<void>(`/t/${params.topicId}.json`, {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: {
            title: params.title,
            category_id: params.categoryId,
          },
        });

        const data = await requestTopic(params.topicId);
        if (!data) {
          throw new Error("Empty topic response");
        }

        return { topic: mapTopic(data) };
      }),

    bookmarkTopic: (params: {
      topicId: number;
      postNumber: number;
      username: string;
      userApiKey?: string;
      reminderAt?: string;
    }) =>
      runWithContext("Bookmark topic", async () => {
        const data = await client.fetchApi<any>(`/t/${params.topicId}/bookmark`, {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: {
            bookmarked: true,
            post_number: params.postNumber,
            reminder_at: params.reminderAt,
          },
        });

        const bookmarkId =
          data && typeof (data as any).bookmark_id === "number"
            ? (data as any).bookmark_id
            : undefined;

        return { success: true as const, bookmarkId };
      }),

    inviteToTopic: (params: {
      topicId: number;
      usernames?: string[];
      groupNames?: string[];
      username?: string;
      userApiKey?: string;
    }) =>
      runWithContext("Invite to topic", async () => {
        await client.fetchApi<void>(`/t/${params.topicId}/invite`, {
          method: "POST",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: {
            usernames:
              params.usernames && params.usernames.length
                ? params.usernames.join(",")
                : undefined,
            group_names:
              params.groupNames && params.groupNames.length
                ? params.groupNames.join(",")
                : undefined,
          },
        });

        return { success: true as const };
      }),

    setTopicNotification: (params: {
      topicId: number;
      level: TopicNotificationLevel;
      username: string;
      userApiKey?: string;
    }) =>
      runWithContext("Set topic notification", async () => {
        const notificationLevel = normalizeTopicNotificationLevel(params.level);

        const data = await client.fetchApi<any>(`/t/${params.topicId}/notifications`, {
          method: "POST",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: { notification_level: notificationLevel },
        });

        const resolvedLevel =
          data && typeof (data as any).notification_level === "number"
            ? (data as any).notification_level
            : notificationLevel;

        return { success: true as const, notificationLevel: resolvedLevel };
      }),

    changeTopicTimestamp: (params: {
      topicId: number;
      timestamp: string;
      username?: string;
      userApiKey?: string;
    }) =>
      runWithContext("Change topic timestamp", async () => {
        await client.fetchApi<void>(`/t/${params.topicId}/change-timestamp`, {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: { timestamp: params.timestamp },
        });

        const data = await requestTopic(params.topicId);
        if (!data) {
          throw new Error("Empty topic response");
        }

        return { topic: mapTopic(data) };
      }),

    addTopicTimer: (params: {
      topicId: number;
      statusType: string;
      time: string;
      basedOnLastPost?: boolean;
      durationMinutes?: number;
      categoryId?: number;
      username?: string;
      userApiKey?: string;
    }) =>
      runWithContext("Add topic timer", async () => {
        const data = await client.fetchApi<any>(`/t/${params.topicId}/timers`, {
          method: "POST",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: {
            status_type: params.statusType,
            time: params.time,
            based_on_last_post: params.basedOnLastPost,
            duration: params.durationMinutes,
            category_id: params.categoryId,
          },
        });

        const status =
          data && typeof (data as any).status_type === "string"
            ? (data as any).status_type
            : params.statusType;

        return { success: true as const, status };
      }),

    requestTopic,
  };
};

export type TopicsResource = ReturnType<typeof createTopicsResource>;
