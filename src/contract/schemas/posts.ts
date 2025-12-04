import { z } from "every-plugin/zod";
import { POST_ACTIONS } from "../../constants";
import {
  NonEmptyString,
  NonNegativeIntSchema,
  OptionalUserApiKeySchema,
  PositiveIntSchema,
  RequiredUsernameSchema,
  TimestampSchema,
  TrimmedString,
} from "./base";

export const PostResultSchema = z.object({
  success: z.boolean(),
  postUrl: z.string().url().optional(),
  postId: PositiveIntSchema.optional(),
  topicId: PositiveIntSchema.optional(),
});

export const PostActionResultSchema = z.object({
  success: z.boolean(),
  action: z.enum(POST_ACTIONS).default("like"),
  postActionTypeId: PositiveIntSchema,
  postActionId: PositiveIntSchema.optional(),
});

export const PostSchema = z.object({
  id: PositiveIntSchema,
  topicId: PositiveIntSchema,
  postNumber: PositiveIntSchema,
  username: z.string(),
  name: z.string().nullable(),
  avatarTemplate: z.string(),
  raw: z.string().optional(),
  cooked: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  replyCount: NonNegativeIntSchema,
  likeCount: NonNegativeIntSchema,
  replyToPostNumber: PositiveIntSchema.nullable(),
  canEdit: z.boolean().optional(),
  version: NonNegativeIntSchema,
});

export const PaginatedPostsSchema = z.object({
  posts: z.array(PostSchema),
  hasMore: z.boolean(),
  nextPage: NonNegativeIntSchema.nullable(),
});

export const RevisionSchema = z
  .object({
    number: NonNegativeIntSchema,
    postId: PositiveIntSchema,
    userId: PositiveIntSchema.optional(),
    username: z.string().optional(),
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
    raw: z.string().optional(),
    cooked: z.string().optional(),
    changes: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

export const PostActionModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("perform") }),
  z.object({ mode: z.literal("undo") }),
  z.object({
    mode: z.literal("flag"),
    target: z.enum(["post", "topic"]).default("post"),
    resolution: z.enum(["flag", "take_action"]).default("flag"),
  }),
]);

export const PostInputSchema = z
  .object({
    username: RequiredUsernameSchema,
    userApiKey: OptionalUserApiKeySchema,
    title: TrimmedString.min(15, "Title must be at least 15 characters").optional(),
    raw: TrimmedString.min(20, "Post content must be at least 20 characters"),
    category: PositiveIntSchema.optional(),
    topicId: PositiveIntSchema.optional(),
    replyToPostNumber: PositiveIntSchema.optional(),
  })
  .refine(
    (data) => Boolean(data.topicId) || Boolean(data.title),
    "Title is required when creating a new topic"
  )
  .refine(
    (data) => !data.replyToPostNumber || Boolean(data.topicId),
    "topicId is required when replying to a specific post"
  );

export const EditPostInputSchema = z.object({
  username: RequiredUsernameSchema,
  userApiKey: OptionalUserApiKeySchema,
  postId: PositiveIntSchema,
  raw: TrimmedString.min(20, "Post content must be at least 20 characters"),
  editReason: TrimmedString.optional(),
});

export const LockPostInputSchema = z.object({
  postId: PositiveIntSchema,
  locked: z.boolean(),
  username: RequiredUsernameSchema,
  userApiKey: OptionalUserApiKeySchema,
});

export const PostActionInputSchema = z.object({
  postId: PositiveIntSchema,
  action: PostActionResultSchema.shape.action.default("like"),
  postActionTypeId: PositiveIntSchema.optional(),
  message: z.string().optional(),
  mode: PostActionModeSchema.optional(),
  username: RequiredUsernameSchema,
  userApiKey: OptionalUserApiKeySchema,
});

export const DeletePostInputSchema = z.object({
  postId: PositiveIntSchema,
  forceDestroy: z.boolean().optional(),
  username: RequiredUsernameSchema,
  userApiKey: OptionalUserApiKeySchema,
});

export const RevisionInputSchema = z.object({
  postId: PositiveIntSchema,
  revision: NonNegativeIntSchema,
});

export const UpdateRevisionInputSchema = z.object({
  postId: PositiveIntSchema,
  revision: NonNegativeIntSchema,
  raw: NonEmptyString.min(1, "Revision content is required"),
  editReason: TrimmedString.optional(),
  username: RequiredUsernameSchema,
  userApiKey: OptionalUserApiKeySchema,
});

export const DeleteRevisionInputSchema = z.object({
  postId: PositiveIntSchema,
  revision: NonNegativeIntSchema,
  username: RequiredUsernameSchema,
  userApiKey: OptionalUserApiKeySchema,
});

export const PostRepliesInputSchema = z.object({ postId: PositiveIntSchema });

export const PostListInputSchema = z.object({ page: NonNegativeIntSchema.default(0) });

export const PostGetInputSchema = z.object({
  postId: PositiveIntSchema,
  includeRaw: z.boolean().default(false),
});
