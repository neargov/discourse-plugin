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
    .input(
      z.object({ username: RequiredUsernameSchema }).describe("Discourse username to retrieve")
    )
    .output(z.object({ user: UserProfileSchema }).describe("Full Discourse user profile"))
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
      }).describe("Create a new Discourse user with optional attributes")
    )
    .output(
      z.object({
        success: z.boolean(),
        userId: z.number().int().optional(),
        active: z.boolean().optional(),
      }).describe("Result of creating a user, including id and activation status")
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
      }).describe("Update existing user fields such as email, title, suspension, or bio")
    )
    .output(SuccessSchema.describe("Indicates whether the user update succeeded"))
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
      }).describe("Delete a user with optional blocking flags and post deletion")
    )
    .output(SuccessSchema.describe("Indicates whether the user was deleted"))
    .errors(CommonPluginErrors),

  listUsers: oc
    .route({ method: "POST", path: "/users/list" })
    .input(z.object({ page: PageSchema }).describe("Paginated request for users list"))
    .output(
      z
        .object({ users: z.array(DiscourseUserSchema) })
        .describe("Page of users with basic profile details")
    )
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
      }).describe("List admin-visible users filtered by status with optional email visibility")
    )
    .output(
      z
        .object({ users: z.array(AdminUserSchema) })
        .describe("Page of admin user records including staff and status details")
    )
    .errors(CommonPluginErrors),

  getUserByExternal: oc
    .route({ method: "POST", path: "/users/by-external" })
    .input(
      z.object({
        externalId: NonEmptyString.min(1, "External ID is required"),
        provider: NonEmptyString.min(1, "Provider is required"),
      }).describe("Find a user by external id and provider mapping")
    )
    .output(z.object({ user: UserProfileSchema }).describe("User profile matched by external id"))
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
      }).describe("Retrieve user directory with period/order filters and pagination")
    )
    .output(
      z.object({
        items: z.array(DirectoryItemSchema),
        totalRows: NonNegativeIntSchema,
      }).describe("Directory items with aggregate totals for pagination")
    )
    .errors(CommonPluginErrors),

  getUserStatus: oc
    .route({ method: "POST", path: "/users/status/get" })
    .input(
      z.object({ username: RequiredUsernameSchema }).describe("Username whose status to fetch")
    )
    .output(
      z.object({ status: UserStatusSchema.nullable() }).describe("User status payload if present")
    )
    .errors(CommonPluginErrors),

  updateUserStatus: oc
    .route({ method: "POST", path: "/users/status/update" })
    .input(UserStatusInputSchema.describe("Update a user's status text and emoji"))
    .output(
      z.object({ status: UserStatusSchema }).describe("Updated user status returned by Discourse")
    )
    .errors(CommonPluginErrors),
};
