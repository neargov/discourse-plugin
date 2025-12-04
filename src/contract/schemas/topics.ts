import { z } from "every-plugin/zod";
import {
  NonEmptyString,
  NonNegativeIntSchema,
  OptionalUserApiKeySchema,
  OptionalUsernameSchema,
  PageSchema,
  PositiveIntSchema,
  TimestampSchema,
} from "./base";
import {
  TOPIC_NOTIFICATION_LEVEL_MAP,
  TOPIC_NOTIFICATION_LEVEL_NAMES,
  TOPIC_TIMER_STATUSES,
} from "../../constants";
import { CategorySchema } from "./categories";

export type TopicNotificationLevelName = (typeof TOPIC_NOTIFICATION_LEVEL_NAMES)[number];
export type TopicNotificationLevel = number | TopicNotificationLevelName;

export const TopicSchema = z.object({
  id: PositiveIntSchema,
  title: z.string(),
  slug: z.string(),
  categoryId: PositiveIntSchema.nullable(),
  createdAt: z.string().nullable(),
  lastPostedAt: z.string().nullable(),
  postsCount: NonNegativeIntSchema,
  replyCount: NonNegativeIntSchema,
  likeCount: NonNegativeIntSchema,
  views: NonNegativeIntSchema,
  pinned: z.boolean(),
  closed: z.boolean(),
  archived: z.boolean(),
  visible: z.boolean(),
});

export const PaginatedTopicsSchema = z.object({
  topics: z.array(TopicSchema),
  hasMore: z.boolean(),
  nextPage: NonNegativeIntSchema.nullable(),
});

export const normalizeTopicNotificationLevel = (
  value: TopicNotificationLevel
): number => {
  if (typeof value === "number") return value;
  return TOPIC_NOTIFICATION_LEVEL_MAP[value] ?? 1;
};

export const TopicNotificationLevelSchema = z
  .union([z.number().int().min(0).max(4), z.enum(TOPIC_NOTIFICATION_LEVEL_NAMES)])
  .transform((value) => normalizeTopicNotificationLevel(value))
  .refine((value) => value >= 0 && value <= 4, {
    message: "Invalid topic notification level",
  });

export const TopicTimerStatusSchema = z.enum(TOPIC_TIMER_STATUSES);

export const ListTopicListInputSchema = z
  .object({
    type: z.enum(["latest", "new", "top"]).default("latest"),
    categoryId: PositiveIntSchema.optional(),
    page: PageSchema,
    order: z
      .enum(["default", "created", "activity", "views", "posts", "likes"])
      .default("default"),
    period: z
      .enum(["all", "yearly", "quarterly", "monthly", "weekly", "daily"])
      .default("monthly"),
  })
  .refine((data) => data.type !== "top" || Boolean(data.period), "period is required for top topic lists");

export const TopicActionResultSchema = z.object({
  topic: TopicSchema,
});

export const TopicNotificationResultSchema = z.object({
  success: z.boolean(),
  notificationLevel: z.number().int().min(0).max(4),
});

export const TopicTimerResultSchema = z.object({
  success: z.boolean(),
  status: z.string(),
});

export const BookmarkResultSchema = z.object({
  success: z.boolean(),
  bookmarkId: z.number().optional(),
});

export const TopicMetadataInputSchema = z
  .object({
    topicId: PositiveIntSchema,
    title: NonEmptyString.min(15, "Title must be at least 15 characters").optional(),
    categoryId: PositiveIntSchema.optional(),
    username: OptionalUsernameSchema,
    userApiKey: OptionalUserApiKeySchema,
  })
  .refine(
    (value) => Boolean(value.title) || value.categoryId !== undefined,
    "Provide a new title or categoryId to update"
  );

export const TopicTimestampInputSchema = z.object({
  topicId: PositiveIntSchema,
  timestamp: TimestampSchema,
});

export const TopicTimerInputSchema = z.object({
  topicId: PositiveIntSchema,
  statusType: TopicTimerStatusSchema,
  time: TimestampSchema,
  basedOnLastPost: z.boolean().optional(),
  durationMinutes: PositiveIntSchema.optional(),
  categoryId: PositiveIntSchema.optional(),
});

export const CategoryTopicsInputSchema = z.object({
  slug: NonEmptyString,
  categoryId: PositiveIntSchema,
  page: PageSchema,
});
