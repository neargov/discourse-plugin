import { z } from "every-plugin/zod";
import {
  NonEmptyString,
  NonNegativeIntSchema,
  PositiveIntSchema,
  RequiredUsernameSchema,
  TimestampSchema,
} from "./base";

export const DiscourseUserSchema = z.object({
  id: PositiveIntSchema,
  username: z.string(),
  name: z.string().nullable(),
  avatarTemplate: z.string(),
  title: z.string().nullable(),
  trustLevel: NonNegativeIntSchema,
  moderator: z.boolean(),
  admin: z.boolean(),
});

export const UserProfileSchema = DiscourseUserSchema.extend({
  createdAt: z.string().optional(),
  lastPostedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  postCount: NonNegativeIntSchema,
  badgeCount: NonNegativeIntSchema,
  profileViewCount: NonNegativeIntSchema,
});

export const AdminUserSchema = DiscourseUserSchema.extend({
  email: z.string().email().optional(),
  active: z.boolean().optional(),
  lastSeenAt: z.string().nullable().optional(),
  staged: z.boolean().optional(),
});

export const DirectoryItemSchema = z.object({
  user: DiscourseUserSchema,
  likesReceived: NonNegativeIntSchema,
  likesGiven: NonNegativeIntSchema,
  topicsEntered: NonNegativeIntSchema,
  postsRead: NonNegativeIntSchema,
  daysVisited: NonNegativeIntSchema,
  topicCount: NonNegativeIntSchema,
  postCount: NonNegativeIntSchema,
});

export const UserStatusSchema = z.object({
  emoji: z.string().nullable(),
  description: z.string().nullable(),
  endsAt: z.string().nullable(),
});

export const UserStatusInputSchema = z.object({
  username: RequiredUsernameSchema,
  emoji: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  endsAt: TimestampSchema.optional().nullable(),
});
