import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";

/**
 * Discourse Plugin Contract
 * */

// Schema for auth URL response
export const AuthUrlSchema = z.object({
  authUrl: z.string().url(),
  nonce: z.string(),
  expiresAt: z.string().datetime(),
});

// Schema for link completion response
export const CompleteLinkResultSchema = z.object({
  userApiKey: z.string().min(1),
  discourseUsername: z.string(),
  discourseUserId: z.number().int().positive(),
});

// Schema for post creation result
export const PostResultSchema = z.object({
  success: z.boolean(),
  postUrl: z.string().url().optional(),
  postId: z.number().optional(),
  topicId: z.number().optional(),
});

export const PostActionResultSchema = z.object({
  success: z.boolean(),
  action: z
    .enum([
      "like",
      "unlike",
      "flag",
      "flag_off_topic",
      "flag_inappropriate",
      "flag_spam",
      "notify_user",
      "notify_moderators",
      "custom",
    ])
    .default("like"),
  postActionTypeId: z.number().int().positive(),
  postActionId: z.number().int().optional(),
});

// Schema for Discourse categories
export const CategorySchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  color: z.string(),
  topicCount: z.number(),
  postCount: z.number(),
  parentCategoryId: z.number().nullable(),
  readRestricted: z.boolean(),
});

export const TagSchema = z.object({
  id: z.number(),
  name: z.string(),
  topicCount: z.number(),
  pmTopicCount: z.number(),
  synonyms: z.array(z.string()),
  targetTag: z.string().nullable(),
  description: z.string().nullable(),
});

export const TagGroupSchema = z.object({
  id: z.number(),
  name: z.string(),
  tagNames: z.array(z.string()),
  parentTagNames: z.array(z.string()),
  onePerTopic: z.boolean(),
  permissions: z.record(z.string(), z.number()),
  tags: z.array(TagSchema).optional(),
});

// Schema for Discourse topics
export const TopicSchema = z.object({
  id: z.number(),
  title: z.string(),
  slug: z.string(),
  categoryId: z.number().nullable(),
  createdAt: z.string().nullable(),
  lastPostedAt: z.string().nullable(),
  postsCount: z.number(),
  replyCount: z.number(),
  likeCount: z.number(),
  views: z.number(),
  pinned: z.boolean(),
  closed: z.boolean(),
  archived: z.boolean(),
  visible: z.boolean(),
});

// Schema for paginated topic lists
export const PaginatedTopicsSchema = z.object({
  topics: z.array(TopicSchema),
  hasMore: z.boolean(),
  nextPage: z.number().nullable(),
});

// Schema for Discourse posts
export const PostSchema = z.object({
  id: z.number(),
  topicId: z.number(),
  postNumber: z.number(),
  username: z.string(),
  name: z.string().nullable(),
  avatarTemplate: z.string(),
  raw: z.string().optional(),
  cooked: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  replyCount: z.number(),
  likeCount: z.number(),
  replyToPostNumber: z.number().nullable(),
  canEdit: z.boolean().optional(),
  version: z.number(),
});

export const PaginatedPostsSchema = z.object({
  posts: z.array(PostSchema),
  hasMore: z.boolean(),
  nextPage: z.number().nullable(),
});

// Schema for Discourse users
export const DiscourseUserSchema = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string().nullable(),
  avatarTemplate: z.string(),
  title: z.string().nullable(),
  trustLevel: z.number(),
  moderator: z.boolean(),
  admin: z.boolean(),
});

// Extended user profile schema
export const UserProfileSchema = DiscourseUserSchema.extend({
  createdAt: z.string().optional(),
  lastPostedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  postCount: z.number(),
  badgeCount: z.number(),
  profileViewCount: z.number(),
});

// Extended post schema for search results
export const SearchPostSchema = PostSchema.extend({
  topicTitle: z.string(),
  blurb: z.string(),
});

export const RevisionSchema = z
  .object({
    number: z.number().int().nonnegative(),
    postId: z.number().int().positive(),
    userId: z.number().int().positive().optional(),
    username: z.string().optional(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    raw: z.string().optional(),
    cooked: z.string().optional(),
    changes: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

// Search results schema
export const SearchResultSchema = z.object({
  posts: z.array(SearchPostSchema),
  topics: z.array(TopicSchema),
  users: z.array(DiscourseUserSchema),
  categories: z.array(CategorySchema),
  totalResults: z.number(),
  hasMore: z.boolean(),
});

export const AdminUserSchema = DiscourseUserSchema.extend({
  email: z.string().email().optional(),
  active: z.boolean().optional(),
  lastSeenAt: z.string().nullable().optional(),
  staged: z.boolean().optional(),
});

export const DirectoryItemSchema = z.object({
  user: DiscourseUserSchema,
  likesReceived: z.number(),
  likesGiven: z.number(),
  topicsEntered: z.number(),
  postsRead: z.number(),
  daysVisited: z.number(),
  topicCount: z.number(),
  postCount: z.number(),
});

export const UserStatusSchema = z.object({
  emoji: z.string().nullable(),
  description: z.string().nullable(),
  endsAt: z.string().nullable(),
});

const SuccessSchema = z.object({ success: z.boolean() });

export const UploadSchema = z.object({
  id: z.number(),
  url: z.string(),
  shortUrl: z.string().optional(),
  originalFilename: z.string().optional(),
  filesize: z.number().optional(),
  humanFileSize: z.string().optional(),
  extension: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbnailUrl: z.string().optional(),
});

export const UploadRequestSchema = z.object({
  url: z.string(),
  method: z.literal("POST"),
  headers: z.record(z.string(), z.string()),
  fields: z.record(z.string(), z.string()),
});

export const PresignedUploadSchema = z.object({
  method: z.literal("PUT"),
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  key: z.string(),
  uniqueIdentifier: z.string(),
});

export const MultipartPresignPartSchema = z.object({
  partNumber: z.number().int().positive(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
});

export const MultipartPresignSchema = z.object({
  uploadId: z.string(),
  key: z.string(),
  uniqueIdentifier: z.string(),
  parts: z.array(MultipartPresignPartSchema),
});

export const SiteBasicInfoSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  logoUrl: z.string().nullable(),
  mobileLogoUrl: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  contactEmail: z.string().nullable(),
  canonicalHostname: z.string().nullable(),
  defaultLocale: z.string().nullable(),
});

export const SiteInfoSchema = SiteBasicInfoSchema.extend({
  categories: z.array(CategorySchema),
});

const ValidateUserApiKeyResultSchema = z.object({
  valid: z.literal(true).or(z.literal(false)),
  retryable: z.boolean().optional(),
  error: z.string().optional(),
  user: DiscourseUserSchema.optional(),
});

const TopicStatusSchema = z.enum(["closed", "archived", "pinned", "visible"]);

const TopicNotificationLevelNames = [
  "muted",
  "regular",
  "tracking",
  "watching",
  "watching_first_post",
] as const;

const TopicNotificationLevelMap: Record<(typeof TopicNotificationLevelNames)[number], number> = {
  muted: 0,
  regular: 1,
  tracking: 2,
  watching: 3,
  watching_first_post: 4,
};

export type TopicNotificationLevelName = (typeof TopicNotificationLevelNames)[number];
export type TopicNotificationLevel = number | TopicNotificationLevelName;

export const normalizeTopicNotificationLevel = (
  value: TopicNotificationLevel
): number => {
  if (typeof value === "number") return value;
  return TopicNotificationLevelMap[value] ?? 1;
};

export const TopicNotificationLevelSchema = z
  .union([z.number().int().min(0).max(4), z.enum(TopicNotificationLevelNames)])
  .transform((value) => normalizeTopicNotificationLevel(value));

export const TopicTimerStatusSchema = z.enum([
  "open",
  "close",
  "delete",
  "publish",
  "auto_close",
  "auto_delete",
  "reminder",
]);

export const ListTopicListInputSchema = z
  .object({
    type: z.enum(["latest", "new", "top"]).default("latest"),
    categoryId: z.number().optional(),
    page: z.number().default(0),
    order: z
      .enum(["default", "created", "activity", "views", "posts", "likes"])
      .default("default"),
    period: z
      .enum(["all", "yearly", "quarterly", "monthly", "weekly", "daily"])
      .default("monthly"),
  })
  .refine((data) => data.type !== "top" || Boolean(data.period), "period is required for top topic lists");

const TopicActionResultSchema = z.object({
  topic: TopicSchema,
});

const BookmarkResultSchema = z.object({
  success: z.boolean(),
  bookmarkId: z.number().optional(),
});

const TopicNotificationResultSchema = z.object({
  success: z.boolean(),
  notificationLevel: z.number().int().min(0).max(4),
});

const TopicTimerResultSchema = z.object({
  success: z.boolean(),
  status: z.string(),
});

// Exported types inferred from schemas for consumer convenience
export type AuthUrl = z.infer<typeof AuthUrlSchema>;
export type CompleteLinkResult = z.infer<typeof CompleteLinkResultSchema>;
export type PostResult = z.infer<typeof PostResultSchema>;
export type PostActionResult = z.infer<typeof PostActionResultSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Tag = z.infer<typeof TagSchema>;
export type TagGroup = z.infer<typeof TagGroupSchema>;
export type Topic = z.infer<typeof TopicSchema>;
export type PaginatedTopics = z.infer<typeof PaginatedTopicsSchema>;
export type Post = z.infer<typeof PostSchema>;
export type DiscourseUser = z.infer<typeof DiscourseUserSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type SearchPost = z.infer<typeof SearchPostSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type Upload = z.infer<typeof UploadSchema>;
export type UploadRequest = z.infer<typeof UploadRequestSchema>;
export type PresignedUpload = z.infer<typeof PresignedUploadSchema>;
export type MultipartPresign = z.infer<typeof MultipartPresignSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type DirectoryItem = z.infer<typeof DirectoryItemSchema>;
export type UserStatus = z.infer<typeof UserStatusSchema>;
export type SiteBasicInfo = z.infer<typeof SiteBasicInfoSchema>;
export type SiteInfo = z.infer<typeof SiteInfoSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type TopicActionResult = z.infer<typeof TopicActionResultSchema>;
export type BookmarkResult = z.infer<typeof BookmarkResultSchema>;
export type TopicNotificationResult = z.infer<
  typeof TopicNotificationResultSchema
>;
export type TopicTimerResult = z.infer<typeof TopicTimerResultSchema>;

// oRPC Contract definition
export const contract = oc.router({
  // Step 1: Generate User API auth URL for Discourse
  initiateLink: oc
    .route({ method: "POST", path: "/auth/initiate" })
    .input(
      z.object({
        clientId: z.string().min(1, "Client ID is required"),
        applicationName: z.string().min(1, "Application name is required"),
      })
    )
    .output(AuthUrlSchema)
    .errors(CommonPluginErrors),

  // Step 2: Complete OAuth flow and return Discourse credentials
  completeLink: oc
    .route({ method: "POST", path: "/auth/complete" })
    .input(
      z.object({
        payload: z.string().min(1, "Encrypted payload is required"), // Encrypted User API key from Discourse (base64)
        nonce: z.string().min(1, "Nonce is required"),
      })
    )
    .output(CompleteLinkResultSchema)
    .errors(CommonPluginErrors),

  // Step 3: Create a Discourse post (host app provides username)
  createPost: oc
    .route({ method: "POST", path: "/posts/create" })
    .input(
      z
        .object({
          username: z.string().min(1, "Discourse username is required"),
          userApiKey: z.string().min(1).optional(),
          title: z
            .string()
            .min(15, "Title must be at least 15 characters")
            .optional(),
          raw: z
            .string()
            .min(20, "Post content must be at least 20 characters"),
          category: z.number().int().positive().optional(),
          topicId: z.number().int().positive().optional(),
          replyToPostNumber: z.number().int().positive().optional(),
        })
        .refine(
          (data) => Boolean(data.topicId) || Boolean(data.title),
          "Title is required when creating a new topic"
        )
        .refine(
          (data) => !data.replyToPostNumber || Boolean(data.topicId),
          "topicId is required when replying to a specific post"
        )
    )
    .output(PostResultSchema)
    .errors(CommonPluginErrors),

  // Edit an existing post (host app provides username)
  editPost: oc
    .route({ method: "POST", path: "/posts/edit" })
    .input(
      z.object({
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: z.string().min(1).optional(),
        postId: z.number().int().positive(),
        raw: z.string().min(20, "Post content must be at least 20 characters"),
        editReason: z.string().optional(),
      })
    )
    .output(PostResultSchema)
    .errors(CommonPluginErrors),

  prepareUpload: oc
    .route({ method: "POST", path: "/uploads/prepare" })
    .input(
      z.object({
        uploadType: z.string().default("composer"),
        username: z.string().min(1).optional(),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(z.object({ request: UploadRequestSchema }))
    .errors(CommonPluginErrors),

  presignUpload: oc
    .route({ method: "POST", path: "/uploads/presign" })
    .input(
      z.object({
        filename: z.string().min(1),
        byteSize: z.number().int().positive(),
        contentType: z.string().optional(),
        uploadType: z.string().default("composer"),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(PresignedUploadSchema)
    .errors(CommonPluginErrors),

  batchPresignMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/presign" })
    .input(
      z.object({
        uniqueIdentifier: z.string().min(1),
        partNumbers: z.array(z.number().int().positive()).nonempty(),
        uploadId: z.string().min(1).optional(),
        key: z.string().min(1).optional(),
        contentType: z.string().optional(),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(MultipartPresignSchema)
    .errors(CommonPluginErrors),

  completeMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/complete" })
    .input(
      z.object({
        uniqueIdentifier: z.string().min(1),
        uploadId: z.string().min(1),
        key: z.string().min(1),
        parts: z
          .array(
            z.object({
              partNumber: z.number().int().positive(),
              etag: z.string().min(1),
            })
          )
          .nonempty(),
        filename: z.string().min(1),
        uploadType: z.string().default("composer"),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(z.object({ upload: UploadSchema }))
    .errors(CommonPluginErrors),

  abortMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/abort" })
    .input(
      z.object({
        uniqueIdentifier: z.string().min(1),
        uploadId: z.string().min(1),
        key: z.string().min(1),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(z.object({ aborted: z.boolean() }))
    .errors(CommonPluginErrors),

  lockPost: oc
    .route({ method: "POST", path: "/posts/lock" })
    .input(
      z.object({
        postId: z.number().int().positive(),
        locked: z.boolean(),
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(z.object({ locked: z.boolean() }))
    .errors(CommonPluginErrors),

  performPostAction: oc
    .route({ method: "POST", path: "/posts/action" })
    .input(
      z.object({
        postId: z.number().int().positive(),
        action: PostActionResultSchema.shape.action.default("like"),
        postActionTypeId: z.number().int().positive().optional(),
        message: z.string().optional(),
        flagTopic: z.boolean().optional(),
        takeAction: z.boolean().optional(),
        undo: z.boolean().optional(),
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(PostActionResultSchema)
    .errors(CommonPluginErrors),

  deletePost: oc
    .route({ method: "POST", path: "/posts/delete" })
    .input(
      z.object({
        postId: z.number().int().positive(),
        forceDestroy: z.boolean().optional(),
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .errors(CommonPluginErrors),

  // Search the forum
  search: oc
    .route({ method: "POST", path: "/search" })
    .input(
      z.object({
        query: z.string().min(1, "Search query is required"),
        category: z.string().optional(),
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
        page: z.number().default(1),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(SearchResultSchema)
    .errors(CommonPluginErrors),

  // Health check procedure
  ping: oc
    .route({ method: "GET", path: "/ping" })
    .output(
      z.object({
        status: z.enum(["ok", "degraded"]),
        timestamp: z.string().datetime(),
        discourseConnected: z.boolean(),
      })
    )
    .errors(CommonPluginErrors),

  // Get all categories
  getCategories: oc
    .route({ method: "GET", path: "/categories" })
    .output(z.object({ categories: z.array(CategorySchema) }))
    .errors(CommonPluginErrors),

  getTags: oc
    .route({ method: "GET", path: "/tags" })
    .output(z.object({ tags: z.array(TagSchema) }))
    .errors(CommonPluginErrors),

  getTag: oc
    .route({ method: "POST", path: "/tags/get" })
    .input(z.object({ name: z.string().min(1) }))
    .output(z.object({ tag: TagSchema }))
    .errors(CommonPluginErrors),

  getTagGroups: oc
    .route({ method: "GET", path: "/tag-groups" })
    .output(z.object({ tagGroups: z.array(TagGroupSchema) }))
    .errors(CommonPluginErrors),

  getTagGroup: oc
    .route({ method: "POST", path: "/tag-groups/get" })
    .input(z.object({ tagGroupId: z.number().int().positive() }))
    .output(z.object({ tagGroup: TagGroupSchema }))
    .errors(CommonPluginErrors),

  createTagGroup: oc
    .route({ method: "POST", path: "/tag-groups/create" })
    .input(
      z.object({
        name: z.string().min(1, "Tag group name is required"),
        tagNames: z.array(z.string()).default([]),
        parentTagNames: z.array(z.string()).default([]),
        onePerTopic: z.boolean().optional(),
        permissions: z
          .record(z.string(), z.coerce.number())
          .optional(),
      })
    )
    .output(z.object({ tagGroup: TagGroupSchema }))
    .errors(CommonPluginErrors),

  updateTagGroup: oc
    .route({ method: "POST", path: "/tag-groups/update" })
    .input(
      z.object({
        tagGroupId: z.number().int().positive(),
        name: z.string().min(1).optional(),
        tagNames: z.array(z.string()).optional(),
        parentTagNames: z.array(z.string()).optional(),
        onePerTopic: z.boolean().optional(),
        permissions: z
          .record(z.string(), z.coerce.number())
          .optional(),
      })
    )
    .output(z.object({ tagGroup: TagGroupSchema }))
    .errors(CommonPluginErrors),

  // Get single category with subcategories
  getCategory: oc
    .route({ method: "POST", path: "/categories/get" })
    .input(
      z.object({
        idOrSlug: z.union([z.number().int().positive(), z.string()]),
      })
    )
    .output(
      z.object({
        category: CategorySchema,
        subcategories: z.array(CategorySchema),
      })
    )
    .errors(CommonPluginErrors),

  // Get a single topic
  getTopic: oc
    .route({ method: "POST", path: "/topics/get" })
    .input(z.object({ topicId: z.number().int().positive() }))
    .output(z.object({ topic: TopicSchema }))
    .errors(CommonPluginErrors),

  // Get latest topics
  getLatestTopics: oc
    .route({ method: "POST", path: "/topics/latest" })
    .input(
      z.object({
        categoryId: z.number().optional(),
        page: z.number().default(0),
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
    .input(
      z.object({
        slug: z.string().min(1),
        categoryId: z.number().int().positive(),
        page: z.number().default(0),
      })
    )
    .output(PaginatedTopicsSchema)
    .errors(CommonPluginErrors),

  // Get top topics by time period
  getTopTopics: oc
    .route({ method: "POST", path: "/topics/top" })
    .input(
      z.object({
        period: z
          .enum(["all", "yearly", "quarterly", "monthly", "weekly", "daily"])
          .default("monthly"),
        categoryId: z.number().optional(),
        page: z.number().default(0),
      })
    )
    .output(PaginatedTopicsSchema)
    .errors(CommonPluginErrors),

  updateTopicStatus: oc
    .route({ method: "POST", path: "/topics/status" })
    .input(
      z.object({
        topicId: z.number().int().positive(),
        status: TopicStatusSchema,
        enabled: z.boolean(),
        username: z.string().min(1).optional(),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(TopicActionResultSchema)
    .errors(CommonPluginErrors),

  updateTopicMetadata: oc
    .route({ method: "POST", path: "/topics/metadata" })
    .input(
      z
        .object({
          topicId: z.number().int().positive(),
          title: z
            .string()
            .min(15, "Title must be at least 15 characters")
            .optional(),
          categoryId: z.number().int().positive().optional(),
          username: z.string().min(1).optional(),
          userApiKey: z.string().min(1).optional(),
        })
        .refine(
          (value) => Boolean(value.title) || value.categoryId !== undefined,
          "Provide a new title or categoryId to update"
        )
    )
    .output(TopicActionResultSchema)
    .errors(CommonPluginErrors),

  bookmarkTopic: oc
    .route({ method: "POST", path: "/topics/bookmark" })
    .input(
      z.object({
        topicId: z.number().int().positive(),
        postNumber: z.number().int().positive().default(1),
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: z.string().min(1).optional(),
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
          topicId: z.number().int().positive(),
          usernames: z.array(z.string().min(1)).default([]),
          groupNames: z.array(z.string().min(1)).default([]),
          username: z.string().min(1).optional(),
          userApiKey: z.string().min(1).optional(),
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
        topicId: z.number().int().positive(),
        level: TopicNotificationLevelSchema,
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(TopicNotificationResultSchema)
    .errors(CommonPluginErrors),

  changeTopicTimestamp: oc
    .route({ method: "POST", path: "/topics/change-timestamp" })
    .input(
      z.object({
        topicId: z.number().int().positive(),
        timestamp: z.string().datetime(),
        username: z.string().min(1).optional(),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(TopicActionResultSchema)
    .errors(CommonPluginErrors),

  addTopicTimer: oc
    .route({ method: "POST", path: "/topics/timers" })
    .input(
      z.object({
        topicId: z.number().int().positive(),
        statusType: TopicTimerStatusSchema,
        time: z.string().datetime(),
        basedOnLastPost: z.boolean().optional(),
        durationMinutes: z.number().int().positive().optional(),
        categoryId: z.number().int().positive().optional(),
        username: z.string().min(1).optional(),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(TopicTimerResultSchema)
    .errors(CommonPluginErrors),

  // Get a single post with its topic
  getPost: oc
    .route({ method: "POST", path: "/posts/get" })
    .input(
      z.object({
        postId: z.number().int().positive(),
        includeRaw: z.boolean().default(false),
      })
    )
    .output(
      z.object({
        post: PostSchema,
        topic: TopicSchema,
      })
    )
    .errors(CommonPluginErrors),

  // Get replies to a post
  getPostReplies: oc
    .route({ method: "POST", path: "/posts/replies" })
    .input(z.object({ postId: z.number().int().positive() }))
    .output(z.object({ replies: z.array(PostSchema) }))
    .errors(CommonPluginErrors),

  // List recent posts
  listPosts: oc
    .route({ method: "POST", path: "/posts/list" })
    .input(z.object({ page: z.number().default(0) }))
    .output(PaginatedPostsSchema)
    .errors(CommonPluginErrors),

  getRevision: oc
    .route({ method: "POST", path: "/posts/revisions/get" })
    .input(
      z.object({
        postId: z.number().int().positive(),
        revision: z.number().int().nonnegative(),
        includeRaw: z.boolean().default(false),
        username: z.string().optional(),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(z.object({ revision: RevisionSchema }))
    .errors(CommonPluginErrors),

  updateRevision: oc
    .route({ method: "POST", path: "/posts/revisions/update" })
    .input(
      z.object({
        postId: z.number().int().positive(),
        revision: z.number().int().nonnegative(),
        raw: z.string().min(1, "Revision content is required"),
        editReason: z.string().optional(),
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(z.object({ revision: RevisionSchema }))
    .errors(CommonPluginErrors),

  deleteRevision: oc
    .route({ method: "POST", path: "/posts/revisions/delete" })
    .input(
      z.object({
        postId: z.number().int().positive(),
        revision: z.number().int().nonnegative(),
        username: z.string().min(1, "Discourse username is required"),
        userApiKey: z.string().min(1).optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .errors(CommonPluginErrors),

  // Get user profile
  getUser: oc
    .route({ method: "POST", path: "/users/get" })
    .input(z.object({ username: z.string().min(1) }))
    .output(z.object({ user: UserProfileSchema }))
    .errors(CommonPluginErrors),

  createUser: oc
    .route({ method: "POST", path: "/users/create" })
    .input(
      z.object({
        username: z.string().min(1, "Username is required"),
        email: z.string().email("Valid email is required"),
        name: z.string().optional(),
        password: z.string().min(8).optional(),
        active: z.boolean().optional(),
        approved: z.boolean().optional(),
        externalId: z.string().optional(),
        externalProvider: z.string().optional(),
        staged: z.boolean().optional(),
        emailVerified: z.boolean().optional(),
        locale: z.string().optional(),
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        userId: z.number().int().optional(),
        active: z.boolean().optional(),
      })
    )
    .errors(CommonPluginErrors),

  updateUser: oc
    .route({ method: "POST", path: "/users/update" })
    .input(
      z.object({
        username: z.string().min(1, "Username is required"),
        email: z.string().email().optional(),
        name: z.string().optional(),
        title: z.string().optional(),
        trustLevel: z.number().int().nonnegative().optional(),
        active: z.boolean().optional(),
        suspendedUntil: z.string().nullable().optional(),
        suspendReason: z.string().optional(),
        staged: z.boolean().optional(),
        bioRaw: z.string().optional(),
        locale: z.string().optional(),
      })
    )
    .output(SuccessSchema)
    .errors(CommonPluginErrors),

  deleteUser: oc
    .route({ method: "POST", path: "/users/delete" })
    .input(
      z.object({
        userId: z.number().int().positive(),
        blockEmail: z.boolean().default(false),
        blockUrls: z.boolean().default(false),
        blockIp: z.boolean().default(false),
        deletePosts: z.boolean().default(false),
        context: z.string().optional(),
      })
    )
    .output(SuccessSchema)
    .errors(CommonPluginErrors),

  listUsers: oc
    .route({ method: "POST", path: "/users/list" })
    .input(
      z.object({
        page: z.number().int().nonnegative().default(0),
      })
    )
    .output(z.object({ users: z.array(DiscourseUserSchema) }))
    .errors(CommonPluginErrors),

  listAdminUsers: oc
    .route({ method: "POST", path: "/admin/users/list" })
    .input(
      z.object({
        filter: z
          .enum(["active", "new", "staff", "suspended", "blocked", "trust_level_0"])
          .default("active"),
        page: z.number().int().nonnegative().default(0),
        showEmails: z.boolean().default(false),
      })
    )
    .output(z.object({ users: z.array(AdminUserSchema) }))
    .errors(CommonPluginErrors),

  getUserByExternal: oc
    .route({ method: "POST", path: "/users/by-external" })
    .input(
      z.object({
        externalId: z.string().min(1, "External ID is required"),
        provider: z.string().min(1, "Provider is required"),
      })
    )
    .output(z.object({ user: UserProfileSchema }))
    .errors(CommonPluginErrors),

  getDirectory: oc
    .route({ method: "POST", path: "/users/directory" })
    .input(
      z.object({
        period: z
          .enum(["daily", "weekly", "monthly", "quarterly", "yearly", "all"])
          .default("weekly"),
        order: z
          .enum([
            "likes_received",
            "likes_given",
            "topics_entered",
            "posts_read",
            "days_visited",
            "topic_count",
            "post_count",
          ])
          .default("likes_received"),
        page: z.number().int().nonnegative().default(0),
      })
    )
    .output(
      z.object({
        items: z.array(DirectoryItemSchema),
        totalRows: z.number().int().nonnegative(),
      })
    )
    .errors(CommonPluginErrors),

  forgotPassword: oc
    .route({ method: "POST", path: "/auth/forgot" })
    .input(z.object({ login: z.string().min(1) }))
    .output(SuccessSchema)
    .errors(CommonPluginErrors),

  changePassword: oc
    .route({ method: "POST", path: "/auth/password/change" })
    .input(
      z.object({
        token: z.string().min(1),
        password: z.string().min(8),
      })
    )
    .output(SuccessSchema)
    .errors(CommonPluginErrors),

  logoutUser: oc
    .route({ method: "POST", path: "/auth/logout" })
    .input(z.object({ userId: z.number().int().positive() }))
    .output(SuccessSchema)
    .errors(CommonPluginErrors),

  syncSso: oc
    .route({ method: "POST", path: "/auth/sso/sync" })
    .input(
      z.object({
        sso: z.string().min(1),
        sig: z.string().min(1),
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        userId: z.number().int().optional(),
      })
    )
    .errors(CommonPluginErrors),

  getUserStatus: oc
    .route({ method: "POST", path: "/users/status/get" })
    .input(z.object({ username: z.string().min(1) }))
    .output(z.object({ status: UserStatusSchema.nullable() }))
    .errors(CommonPluginErrors),

  updateUserStatus: oc
    .route({ method: "POST", path: "/users/status/update" })
    .input(
      z.object({
        username: z.string().min(1),
        emoji: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        endsAt: z.string().nullable().optional(),
      })
    )
    .output(z.object({ status: UserStatusSchema }))
    .errors(CommonPluginErrors),

  getSiteInfo: oc
    .route({ method: "GET", path: "/site" })
    .output(SiteInfoSchema)
    .errors(CommonPluginErrors),

  getSiteBasicInfo: oc
    .route({ method: "GET", path: "/site/basic-info" })
    .output(SiteBasicInfoSchema)
    .errors(CommonPluginErrors),

  validateUserApiKey: oc
    .route({ method: "POST", path: "/auth/validate" })
    .input(z.object({ userApiKey: z.string().min(1) }))
    .output(ValidateUserApiKeyResultSchema)
    .errors(CommonPluginErrors),
});
