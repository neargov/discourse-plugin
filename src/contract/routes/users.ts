import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";
import {
  AdminUserSchema,
  DirectoryItemSchema,
  DiscourseUserSchema,
  NonEmptyString,
  NonNegativeIntSchema,
  OptionalUserApiKeySchema,
  PageSchema,
  PositiveIntSchema,
  RequiredUsernameSchema,
  SuccessSchema,
  UserProfileSchema,
  UserStatusInputSchema,
  UserStatusSchema,
} from "../schemas";

export const usersRoutes = {
  getUser: oc
    .route({ method: "POST", path: "/users/get" })
    .input(z.object({ username: RequiredUsernameSchema }))
    .output(z.object({ user: UserProfileSchema }))
    .errors(CommonPluginErrors),

  createUser: oc
    .route({ method: "POST", path: "/users/create" })
    .input(
      z.object({
        username: NonEmptyString.min(1, "Username is required"),
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
        username: NonEmptyString.min(1, "Username is required"),
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
        userId: PositiveIntSchema,
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
    .input(z.object({ page: PageSchema }))
    .output(z.object({ users: z.array(DiscourseUserSchema) }))
    .errors(CommonPluginErrors),

  listAdminUsers: oc
    .route({ method: "POST", path: "/admin/users/list" })
    .input(
      z.object({
        filter: z
          .enum(["active", "new", "staff", "suspended", "blocked", "trust_level_0"])
          .default("active"),
        page: PageSchema,
        showEmails: z.boolean().default(false),
      })
    )
    .output(z.object({ users: z.array(AdminUserSchema) }))
    .errors(CommonPluginErrors),

  getUserByExternal: oc
    .route({ method: "POST", path: "/users/by-external" })
    .input(
      z.object({
        externalId: NonEmptyString.min(1, "External ID is required"),
        provider: NonEmptyString.min(1, "Provider is required"),
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
        page: PageSchema,
      })
    )
    .output(
      z.object({
        items: z.array(DirectoryItemSchema),
        totalRows: NonNegativeIntSchema,
      })
    )
    .errors(CommonPluginErrors),

  getUserStatus: oc
    .route({ method: "POST", path: "/users/status/get" })
    .input(z.object({ username: RequiredUsernameSchema }))
    .output(z.object({ status: UserStatusSchema.nullable() }))
    .errors(CommonPluginErrors),

  updateUserStatus: oc
    .route({ method: "POST", path: "/users/status/update" })
    .input(UserStatusInputSchema)
    .output(z.object({ status: UserStatusSchema }))
    .errors(CommonPluginErrors),
};
