import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";
import { authRoutes } from "./contract/routes/auth";
import { postsRoutes } from "./contract/routes/posts";
import { topicsRoutes } from "./contract/routes/topics";
import { usersRoutes } from "./contract/routes/users";
import { uploadsRoutes } from "./contract/routes/uploads";
import { metaRoutes } from "./contract/routes/meta";
import { searchRoutes } from "./contract/routes/search";
import {
  AdminUserSchema,
  AuthUrlSchema,
  BookmarkResultSchema,
  CategorySchema,
  CompleteLinkResultSchema,
  DirectoryItemSchema,
  DiscourseUserSchema,
  MultipartPresignSchema,
  PaginatedTopicsSchema,
  PostActionModeSchema,
  PostActionResultSchema,
  PostResultSchema,
  PostSchema,
  PresignedUploadSchema,
  RevisionSchema,
  SearchPostSchema,
  SearchResultSchema,
  SiteBasicInfoSchema,
  SiteInfoSchema,
  TagGroupSchema,
  TagSchema,
  TopicActionResultSchema,
  ListTopicListInputSchema,
  TopicNotificationLevelName,
  TopicNotificationLevel as TopicNotificationLevelValue,
  TopicNotificationLevelSchema,
  TopicNotificationResultSchema,
  TopicSchema,
  TopicTimerStatusSchema,
  TopicTimerResultSchema,
  UploadRequestSchema,
  UploadSchema,
  UserProfileSchema,
  UserStatusSchema,
  ValidateUserApiKeyResultSchema,
  normalizeTopicNotificationLevel,
} from "./contract/schemas";

export const contract = oc.router({
  ...authRoutes,
  ...postsRoutes,
  ...topicsRoutes,
  ...usersRoutes,
  ...uploadsRoutes,
  ...metaRoutes,
  ...searchRoutes,
});

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
export type TopicNotificationResult = z.infer<typeof TopicNotificationResultSchema>;
export type TopicTimerResult = z.infer<typeof TopicTimerResultSchema>;
export type PostActionMode = z.infer<typeof PostActionModeSchema>;
export type TopicNotificationLevel = TopicNotificationLevelValue;
export type TopicNotificationLevelTypeName = TopicNotificationLevelName;

export {
  normalizeTopicNotificationLevel,
  TopicNotificationLevelSchema,
  TopicTimerStatusSchema,
  ListTopicListInputSchema,
};
