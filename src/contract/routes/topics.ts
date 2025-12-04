import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";
import {
  BookmarkResultSchema,
  CategoryTopicsInputSchema,
  ListTopicListInputSchema,
  PaginatedTopicsSchema,
  TopicActionResultSchema,
  TopicMetadataInputSchema,
  TopicNotificationLevelSchema,
  TopicNotificationResultSchema,
  TopicSchema,
  TopicTimestampInputSchema,
  TopicTimerInputSchema,
  TopicTimerResultSchema,
} from "../schemas/topics";
import {
  NonEmptyString,
  OptionalUserApiKeySchema,
  OptionalUsernameSchema,
  PageSchema,
  PositiveIntSchema,
  RequiredUsernameSchema,
} from "../schemas";

export const topicsRoutes = {
  getTopic: oc
    .route({ method: "POST", path: "/topics/get" })
    .input(z.object({ topicId: PositiveIntSchema }))
    .output(z.object({ topic: TopicSchema }))
    .errors(CommonPluginErrors),

  getLatestTopics: oc
    .route({ method: "POST", path: "/topics/latest" })
    .input(
      z.object({
        categoryId: PositiveIntSchema.optional(),
        page: PageSchema,
        order: z
          .enum(["default", "created", "activity", "views", "posts", "likes"])
          .default("default"),
      })
    )
    .output(PaginatedTopicsSchema)
    .errors(CommonPluginErrors),

  listTopicList: oc
    .route({ method: "POST", path: "/topics/list" })
    .input(ListTopicListInputSchema)
    .output(PaginatedTopicsSchema)
    .errors(CommonPluginErrors),

  getCategoryTopics: oc
    .route({ method: "POST", path: "/categories/topics" })
    .input(CategoryTopicsInputSchema)
    .output(PaginatedTopicsSchema)
    .errors(CommonPluginErrors),

  getTopTopics: oc
    .route({ method: "POST", path: "/topics/top" })
    .input(
      z.object({
        period: z
          .enum(["all", "yearly", "quarterly", "monthly", "weekly", "daily"])
          .default("monthly"),
        categoryId: PositiveIntSchema.optional(),
        page: PageSchema,
      })
    )
    .output(PaginatedTopicsSchema)
    .errors(CommonPluginErrors),

  updateTopicStatus: oc
    .route({ method: "POST", path: "/topics/status" })
    .input(
      z.object({
        topicId: PositiveIntSchema,
        status: z.enum(["closed", "archived", "pinned", "visible"]),
        enabled: z.boolean(),
        username: OptionalUsernameSchema,
        userApiKey: OptionalUserApiKeySchema,
      })
    )
    .output(TopicActionResultSchema)
    .errors(CommonPluginErrors),

  updateTopicMetadata: oc
    .route({ method: "POST", path: "/topics/metadata" })
    .input(TopicMetadataInputSchema)
    .output(TopicActionResultSchema)
    .errors(CommonPluginErrors),

  bookmarkTopic: oc
    .route({ method: "POST", path: "/topics/bookmark" })
    .input(
      z.object({
        topicId: PositiveIntSchema,
        postNumber: PositiveIntSchema.default(1),
        username: RequiredUsernameSchema,
        userApiKey: OptionalUserApiKeySchema,
        reminderAt: z.string().datetime().optional(),
      })
    )
    .output(BookmarkResultSchema)
    .errors(CommonPluginErrors),

  inviteToTopic: oc
    .route({ method: "POST", path: "/topics/invite" })
    .input(
      z
        .object({
          topicId: PositiveIntSchema,
          usernames: z.array(NonEmptyString).default([]),
          groupNames: z.array(NonEmptyString).default([]),
          username: OptionalUsernameSchema,
          userApiKey: OptionalUserApiKeySchema,
        })
        .refine(
          (value) => value.usernames.length > 0 || value.groupNames.length > 0,
          "Provide at least one username or groupName"
        )
    )
    .output(z.object({ success: z.boolean() }))
    .errors(CommonPluginErrors),

  setTopicNotification: oc
    .route({ method: "POST", path: "/topics/notifications" })
    .input(
      z.object({
        topicId: PositiveIntSchema,
        level: TopicNotificationLevelSchema,
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: OptionalUserApiKeySchema,
      })
    )
    .output(TopicNotificationResultSchema)
    .errors(CommonPluginErrors),

  changeTopicTimestamp: oc
    .route({ method: "POST", path: "/topics/change-timestamp" })
    .input(
      TopicTimestampInputSchema.extend({
        username: OptionalUsernameSchema,
        userApiKey: OptionalUserApiKeySchema,
      })
    )
    .output(TopicActionResultSchema)
    .errors(CommonPluginErrors),

  addTopicTimer: oc
    .route({ method: "POST", path: "/topics/timers" })
    .input(
      TopicTimerInputSchema.extend({
        basedOnLastPost: z.boolean().optional(),
        durationMinutes: PositiveIntSchema.optional(),
        categoryId: PositiveIntSchema.optional(),
        username: OptionalUsernameSchema,
        userApiKey: OptionalUserApiKeySchema,
      })
    )
    .output(TopicTimerResultSchema)
    .errors(CommonPluginErrors),
};
