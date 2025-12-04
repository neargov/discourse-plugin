import { z } from "every-plugin/zod";
import {
  NonEmptyString,
  RequiredUserApiKeySchema,
  TimestampSchema,
} from "./base";
import { DiscourseUserSchema } from "./users";

export const AuthUrlSchema = z.object({
  authUrl: z.string().url(),
  nonce: NonEmptyString,
  expiresAt: TimestampSchema,
});

export const CompleteLinkResultSchema = z.object({
  userApiKey: RequiredUserApiKeySchema,
  discourseUsername: NonEmptyString,
  discourseUserId: z.number().int().positive(),
});

export const ValidateUserApiKeyResultSchema = z.object({
  valid: z.literal(true).or(z.literal(false)),
  retryable: z.boolean().optional(),
  error: z.string().optional(),
  user: DiscourseUserSchema.optional(),
});
