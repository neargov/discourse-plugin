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
    .input(
      z.object({ topicId: PositiveIntSchema }).describe("Topic id to fetch from Discourse")
    )
    .output(z.object({ topic: TopicSchema }).describe("Normalized topic details"))
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
      }).describe("List latest topics optionally filtered by category and sorted")
    )
    .output(PaginatedTopicsSchema.describe("Paginated latest topics with continuation cursor"))
    .errors(CommonPluginErrors),

  listTopicList: oc
    .route({ method: "POST", path: "/topics/list" })
    .input(ListTopicListInputSchema.describe("List topics by list type (new, unread, etc.)"))
    .output(PaginatedTopicsSchema.describe("Paginated topics for the requested list type"))
    .errors(CommonPluginErrors),

  getCategoryTopics: oc
    .route({ method: "POST", path: "/categories/topics" })
    .input(CategoryTopicsInputSchema.describe("List topics within a specific category"))
    .output(PaginatedTopicsSchema.describe("Paginated topics for the requested category"))
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
      }).describe("List top topics over a period with optional category filter")
    )
    .output(PaginatedTopicsSchema.describe("Paginated top topics with next page marker"))
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
      }).describe("Update a topic's status (close, archive, pin, or hide)")
    )
    .output(TopicActionResultSchema.describe("Result of updating topic status"))
    .errors(CommonPluginErrors),

  updateTopicMetadata: oc
    .route({ method: "POST", path: "/topics/metadata" })
    .input(TopicMetadataInputSchema.describe("Update topic metadata such as title or tags"))
    .output(TopicActionResultSchema.describe("Updated topic metadata result"))
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
      }).describe("Bookmark a topic with optional reminder and post number")
    )
    .output(BookmarkResultSchema.describe("Bookmark result with identifiers and reminder info"))
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
        .describe("Invite users or groups to a topic via usernames or group names")
    )
    .output(
      z
        .object({ success: z.boolean() })
        .describe("Indicates whether invites were accepted by Discourse")
    )
    .errors(CommonPluginErrors),

  setTopicNotification: oc
    .route({ method: "POST", path: "/topics/notifications" })
    .input(
      z.object({
        topicId: PositiveIntSchema,
        level: TopicNotificationLevelSchema,
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: OptionalUserApiKeySchema,
      }).describe("Set a user's notification level for a topic")
    )
    .output(TopicNotificationResultSchema.describe("Result of updating topic notification level"))
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
      }).describe("Add or update a topic timer (auto-close/open) with optional metadata")
    )
    .output(TopicTimerResultSchema.describe("Details of the created or updated topic timer"))
    .errors(CommonPluginErrors),
};
