import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";

/**
 * Discourse NEAR Plugin Contract
 *
 * Enables NEAR account holders to connect and interact with forums
 */

// Schema for linkage information
export const LinkageSchema = z.object({
  nearAccount: z.string(),
  discourseUsername: z.string(),
  verifiedAt: z.string().datetime(),
});

// Schema for auth URL response
export const AuthUrlSchema = z.object({
  authUrl: z.string().url(),
  nonce: z.string(),
  expiresAt: z.string().datetime(),
});

// Schema for link completion response
export const LinkResultSchema = z.object({
  success: z.boolean(),
  nearAccount: z.string(),
  discourseUsername: z.string(),
  message: z.string(),
});

// Schema for post creation result
export const PostResultSchema = z.object({
  success: z.boolean(),
  postUrl: z.string().url().optional(),
  postId: z.number().optional(),
  topicId: z.number().optional(),
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

// Search results schema
export const SearchResultSchema = z.object({
  posts: z.array(SearchPostSchema),
  topics: z.array(TopicSchema),
  users: z.array(DiscourseUserSchema),
  categories: z.array(CategorySchema),
  totalResults: z.number(),
  hasMore: z.boolean(),
});

// Exported types inferred from schemas for consumer convenience
export type Linkage = z.infer<typeof LinkageSchema>;
export type AuthUrl = z.infer<typeof AuthUrlSchema>;
export type LinkResult = z.infer<typeof LinkResultSchema>;
export type PostResult = z.infer<typeof PostResultSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Topic = z.infer<typeof TopicSchema>;
export type PaginatedTopics = z.infer<typeof PaginatedTopicsSchema>;
export type Post = z.infer<typeof PostSchema>;
export type DiscourseUser = z.infer<typeof DiscourseUserSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type SearchPost = z.infer<typeof SearchPostSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;

// oRPC Contract definition
export const contract = oc.router({
  // Step 1: Generate User API auth URL for Discourse
  getUserApiAuthUrl: oc
    .route({ method: "POST", path: "/auth/user-api-url" })
    .input(
      z.object({
        clientId: z.string().min(1, "Client ID is required"),
        applicationName: z.string().min(1, "Application name is required"),
      })
    )
    .output(AuthUrlSchema)
    .errors(CommonPluginErrors),

  // Step 2: Complete link between NEAR account and Discourse user
  completeLink: oc
    .route({ method: "POST", path: "/auth/complete" })
    .input(
      z.object({
        payload: z.string().min(1, "Encrypted payload is required"), // Encrypted User API key from Discourse (base64)
        nonce: z.string().min(1, "Nonce is required"),
        authToken: z.string().min(1, "NEAR auth token is required"), // NEAR NEP-413 signature
      })
    )
    .output(LinkResultSchema)
    .errors(CommonPluginErrors),

  // Step 3: Create a Discourse post (requires linked account)
  createPost: oc
    .route({ method: "POST", path: "/posts/create" })
    .input(
      z
        .object({
          authToken: z.string().min(1, "NEAR auth token is required"), // NEAR signature for verification
          title: z.string().min(15, "Title must be at least 15 characters").optional(),
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

  // Edit an existing post (requires linked account)
  editPost: oc
    .route({ method: "POST", path: "/posts/edit" })
    .input(
      z.object({
        authToken: z.string().min(1, "NEAR auth token is required"),
        postId: z.number().int().positive(),
        raw: z.string().min(20, "Post content must be at least 20 characters"),
        editReason: z.string().optional(),
      })
    )
    .output(PostResultSchema)
    .errors(CommonPluginErrors),

  // Get linkage information for a NEAR account
  getLinkage: oc
    .route({ method: "POST", path: "/linkage/get" })
    .input(
      z.object({
        nearAccount: z.string().min(1, "NEAR account is required"),
      })
    )
    .output(LinkageSchema.nullable())
    .errors(CommonPluginErrors),

  // Unlink a NEAR account from Discourse
  unlinkAccount: oc
    .route({ method: "POST", path: "/auth/unlink" })
    .input(
      z.object({
        authToken: z.string().min(1, "NEAR auth token is required"),
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        message: z.string(),
      })
    )
    .errors(CommonPluginErrors),

  // Validate an existing linkage
  validateLinkage: oc
    .route({ method: "POST", path: "/linkage/validate" })
    .input(
      z.object({
        nearAccount: z.string().min(1),
      })
    )
    .output(
      z.object({
        valid: z.boolean(),
        discourseUsername: z.string().optional(),
        discourseUser: DiscourseUserSchema.optional(),
        error: z.string().optional(),
      })
    )
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
        order: z
          .enum(["latest", "likes", "views", "latest_topic"])
          .optional(),
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

  // Get user profile
  getUser: oc
    .route({ method: "POST", path: "/users/get" })
    .input(z.object({ username: z.string().min(1) }))
    .output(z.object({ user: UserProfileSchema }))
    .errors(CommonPluginErrors),
});
