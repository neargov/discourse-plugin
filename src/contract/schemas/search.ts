import { z } from "every-plugin/zod";
import { NonNegativeIntSchema, NonEmptyString, OptionalUserApiKeySchema, SlugSchema } from "./base";
import { PostSchema } from "./posts";
import { TopicSchema } from "./topics";
import { DiscourseUserSchema } from "./users";
import { CategorySchema } from "./categories";

export const SearchPostSchema = PostSchema.extend({
  topicTitle: z.string(),
  blurb: z.string(),
}).describe("Post search result with topic context and snippet");

export const SearchResultSchema = z.object({
  posts: z.array(SearchPostSchema),
  topics: z.array(TopicSchema),
  users: z.array(DiscourseUserSchema),
  categories: z.array(CategorySchema),
  totalResults: NonNegativeIntSchema,
  hasMore: z.boolean(),
}).describe("Aggregated search results across posts, topics, users, and categories");

export const SearchInputSchema = z.object({
  query: NonEmptyString.min(1, "Search query is required"),
  category: SlugSchema.optional(),
  username: z.string().optional(),
  tags: z.array(z.string()).optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  order: z.enum(["latest", "likes", "views", "latest_topic"]).optional(),
  status: z
    .enum([
      "open",
      "closed",
      "public",
      "archived",
      "noreplies",
      "solved",
      "unsolved",
    ])
    .optional(),
  in: z
    .enum([
      "title",
      "likes",
      "personal",
      "messages",
      "seen",
      "unseen",
      "posted",
      "created",
      "watching",
      "tracking",
      "bookmarks",
      "first",
      "pinned",
      "wiki",
    ])
    .optional(),
  page: NonNegativeIntSchema.min(1).default(1),
  userApiKey: OptionalUserApiKeySchema,
}).describe("Search parameters including query text, filters, and pagination");
