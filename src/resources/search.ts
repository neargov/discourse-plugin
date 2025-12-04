import { z } from "every-plugin/zod";
import type { SearchPost, SearchResult } from "../contract";
import type { ResourceClient } from "../client";
import { runWithContext } from "../client";
import { normalizePage } from "./shared";
import { mapTopic } from "./topics";
import { mapCategory } from "./categories";
import { mapUserSummary } from "./users";

export const RawSearchPostSchema = z.preprocess(
  (value) => (value && typeof value === "object" ? value : {}),
  z.object({
    id: z.number().int().nonnegative().default(0).catch(0),
    topic_id: z.number().int().nonnegative().default(0).catch(0),
    post_number: z.number().int().nonnegative().default(0).catch(0),
    username: z.string().default("").catch(""),
    name: z.string().nullable().default(null).catch(null),
    avatar_template: z.string().default("").catch(""),
    raw: z.string().optional(),
    cooked: z.string().default("").catch(""),
    created_at: z.string().nullable().default(null).catch(null),
    updated_at: z.string().nullable().default(null).catch(null),
    reply_count: z.number().int().nonnegative().default(0).catch(0),
    like_count: z.number().int().nonnegative().default(0).catch(0),
    reply_to_post_number: z.number().int().nullable().default(null).catch(null),
    can_edit: z.boolean().optional(),
    version: z.number().int().default(1).catch(1),
    blurb: z.string().default("").catch(""),
  })
);

export const mapSearchPost = (post: any): SearchPost => {
  const parsed = RawSearchPostSchema.parse(post);

  const topicTitle =
    typeof post?.topic?.title === "string"
      ? post.topic.title
      : typeof post?.topic_title_headline === "string"
        ? post.topic_title_headline
        : "";

  return {
    id: parsed.id,
    topicId: parsed.topic_id,
    postNumber: parsed.post_number,
    username: parsed.username,
    name: parsed.name,
    avatarTemplate: parsed.avatar_template,
    raw: typeof parsed.raw === "string" ? parsed.raw : undefined,
    cooked: parsed.cooked,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    replyCount: parsed.reply_count,
    likeCount: parsed.like_count,
    replyToPostNumber: parsed.reply_to_post_number,
    canEdit: parsed.can_edit,
    version: parsed.version,
    topicTitle,
    blurb: parsed.blurb,
  };
};

type SearchResponse = {
  posts?: any[];
  topics?: any[];
  users?: any[];
  categories?: any[];
  grouped_search_result?: {
    post_ids?: number[];
    more_full_page_results?: string | null;
  };
};

export const createSearchResource = (client: ResourceClient) => {
  const buildSearchPath = (params: {
    query: string;
    category?: string;
    username?: string;
    tags?: string[];
    before?: string;
    after?: string;
    order?: string;
    status?: string;
    in?: string;
    page?: number;
  }) => {
    let searchQuery = params.query.trim();

    if (params.category) searchQuery += ` #${params.category}`;
    if (params.username) searchQuery += ` @${params.username}`;
    if (params.tags?.length) searchQuery += ` tags:${params.tags.join(",")}`;
    if (params.before) searchQuery += ` before:${params.before}`;
    if (params.after) searchQuery += ` after:${params.after}`;
    if (params.order) searchQuery += ` order:${params.order}`;
    if (params.status) searchQuery += ` status:${params.status}`;
    if (params.in) searchQuery += ` in:${params.in}`;

    searchQuery = searchQuery.replace(/\s+/g, " ").trim();
    const page = normalizePage(params.page, 1);

    const queryParams = new URLSearchParams({
      q: searchQuery,
      page: page.toString(),
    });

    return { path: `/search.json?${queryParams}`, page };
  };

  const requestSearch = (params: {
    query: string;
    category?: string;
    username?: string;
    tags?: string[];
    before?: string;
    after?: string;
    order?: string;
    status?: string;
    in?: string;
    page?: number;
    userApiKey?: string;
  }) => {
    const { path, page } = buildSearchPath(params);
    return client
      .fetchApi<SearchResponse>(path, {
        userApiKey: params.userApiKey,
      })
      .then((data) => ({ data, page }));
  };

  return {
    search: (params: {
      query: string;
      category?: string;
      username?: string;
      tags?: string[];
      before?: string;
      after?: string;
      order?: string;
      status?: string;
      in?: string;
      page?: number;
      userApiKey?: string;
    }) =>
      runWithContext("Search", async () => {
        const { data, page } = await requestSearch(params);
        const safeData = data ?? {};
        const posts = (safeData.posts ?? []).map((p: any) => mapSearchPost(p));

        const users = (safeData.users ?? [])
          .filter(
            (u: any) => u && typeof u.id === "number" && typeof u.username === "string"
          )
          .map((u: any) => mapUserSummary(u));

        return {
          posts,
          topics: (safeData.topics ?? []).map((t: any) => mapTopic(t)),
          users,
          categories: (safeData.categories ?? []).map((c: any) => mapCategory(c)),
          totalResults: safeData.grouped_search_result?.post_ids?.length ?? 0,
          hasMore: !!safeData.grouped_search_result?.more_full_page_results,
        } satisfies SearchResult;
      }),
  };
};

export type SearchResource = ReturnType<typeof createSearchResource>;
