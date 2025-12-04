import { Effect } from "every-plugin/effect";
import { z } from "every-plugin/zod";
import type {
  AdminUser,
  DirectoryItem,
  DiscourseUser,
  UserProfile,
  UserStatus,
} from "../contract";
import type { ResourceClient } from "../client";
import { isRetryableValidationError, runWithContext } from "../client";
import { formatError } from "../utils";
import { normalizePage, parseWithSchemaOrThrow } from "./shared";

export const RawUserSummarySchema = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string().nullable().default(null),
  avatar_template: z.string().default(""),
  title: z.string().nullable().default(null),
  trust_level: z.number().default(0),
  moderator: z.boolean().default(false),
  admin: z.boolean().default(false),
});

export const RawUserProfileSchema = RawUserSummarySchema.extend({
  created_at: z.string().optional(),
  last_posted_at: z.string().nullable().default(null),
  last_seen_at: z.string().nullable().default(null),
  post_count: z.number().default(0),
  badge_count: z.number().default(0),
  profile_view_count: z.number().default(0),
});

export const RawAdminUserSchema = RawUserSummarySchema.extend({
  email: z.string().email().optional(),
  active: z.boolean().default(false),
  last_seen_at: z.string().nullable().default(null),
  staged: z.boolean().default(false),
});

export const RawDirectoryItemSchema = z.object({
  user: RawUserSummarySchema,
  likes_received: z.number().default(0),
  likes_given: z.number().default(0),
  topics_entered: z.number().default(0),
  posts_read: z.number().default(0),
  days_visited: z.number().default(0),
  topic_count: z.number().default(0),
  post_count: z.number().default(0),
});

export const RawUserStatusSchema = z.object({
  emoji: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  ends_at: z.string().nullable().default(null),
});

export const mapUserSummary = (user: any): DiscourseUser => {
  const parsed = parseWithSchemaOrThrow(
    RawUserSummarySchema,
    user,
    "User",
    "Malformed user response"
  );
  return {
    id: parsed.id,
    username: parsed.username,
    name: parsed.name,
    avatarTemplate: parsed.avatar_template,
    title: parsed.title,
    trustLevel: parsed.trust_level,
    moderator: parsed.moderator,
    admin: parsed.admin,
  };
};

export const mapUserProfile = (user: any): UserProfile => {
  const parsed = parseWithSchemaOrThrow(
    RawUserProfileSchema,
    user,
    "User profile",
    "Malformed user response"
  );
  const summary = mapUserSummary(parsed);

  return {
    ...summary,
    createdAt: parsed.created_at,
    lastPostedAt: parsed.last_posted_at,
    lastSeenAt: parsed.last_seen_at,
    postCount: parsed.post_count,
    badgeCount: parsed.badge_count,
    profileViewCount: parsed.profile_view_count,
  };
};

export const mapAdminUser = (user: any): AdminUser => {
  const parsed = parseWithSchemaOrThrow(
    RawAdminUserSchema,
    user,
    "Admin user",
    "Malformed admin user response"
  );

  return {
    id: parsed.id,
    username: parsed.username,
    name: parsed.name,
    avatarTemplate: parsed.avatar_template,
    title: parsed.title,
    trustLevel: parsed.trust_level,
    moderator: parsed.moderator,
    admin: parsed.admin,
    email: parsed.email ?? undefined,
    active: parsed.active,
    lastSeenAt: parsed.last_seen_at,
    staged: parsed.staged,
  };
};

export const mapDirectoryItem = (item: any): DirectoryItem => {
  const parsed = parseWithSchemaOrThrow(
    RawDirectoryItemSchema,
    item,
    "Directory item",
    "Malformed directory response"
  );

  return {
    user: mapUserSummary(parsed.user),
    likesReceived: parsed.likes_received,
    likesGiven: parsed.likes_given,
    topicsEntered: parsed.topics_entered,
    postsRead: parsed.posts_read,
    daysVisited: parsed.days_visited,
    topicCount: parsed.topic_count,
    postCount: parsed.post_count,
  };
};

export const mapUserStatus = (status: any): UserStatus => {
  const parsed = parseWithSchemaOrThrow(
    RawUserStatusSchema,
    status,
    "User status",
    "Malformed user status response"
  );

  return {
    emoji: parsed.emoji,
    description: parsed.description,
    endsAt: parsed.ends_at,
  };
};

type AdminUsersResponse = any[];
type DirectoryResponse = {
  directory_items?: any[];
  meta?: { total_rows_directory_items?: number };
};

export const createUsersResource = (client: ResourceClient) => ({
  getCurrentUser: (userApiKey: string) =>
    runWithContext("Get user", async () => {
      const data = await client.fetchApi<{ current_user?: any }>(
        "/session/current.json",
        { userApiKey }
      );

      if (!data || !data.current_user) {
        throw new Error("Empty or invalid user response");
      }

      const user = data.current_user;
      const mapped = mapUserSummary(user);

      return {
        id: mapped.id,
        username: mapped.username,
        name: mapped.name,
      };
    }),

  getUser: (username: string) =>
    runWithContext("Get user", async () => {
      const data = await client.fetchApi<{ user: any }>(`/u/${username}.json`);
      if (!data) {
        throw new Error("Empty user response");
      }
      const u = data.user;
      const mapped = mapUserProfile(u);
      return mapped;
    }),

  createUser: (params: {
    username: string;
    email: string;
    name?: string;
    password?: string;
    active?: boolean;
    approved?: boolean;
    externalId?: string;
    externalProvider?: string;
    staged?: boolean;
    emailVerified?: boolean;
    locale?: string;
  }) =>
    runWithContext("Create user", async () => {
      const data = await client.fetchApi<{ success?: boolean; user_id?: number; active?: boolean }>(
        "/users",
        {
          method: "POST",
          body: {
            username: params.username,
            email: params.email,
            name: params.name,
            password: params.password,
            active: params.active,
            approved: params.approved,
            external_id: params.externalId,
            external_provider: params.externalProvider,
            staged: params.staged,
            email_verified: params.emailVerified,
            locale: params.locale,
          },
        }
      );

      if (!data) {
        throw new Error("Empty create user response");
      }

      return {
        success: data.success !== false,
        userId: typeof (data as any).user_id === "number" ? (data as any).user_id : undefined,
        active: typeof data.active === "boolean" ? data.active : undefined,
      };
    }),

  updateUser: (params: {
    username: string;
    email?: string;
    name?: string;
    title?: string;
    trustLevel?: number;
    active?: boolean;
    suspendedUntil?: string | null;
    suspendReason?: string;
    staged?: boolean;
    bioRaw?: string;
    locale?: string;
  }) =>
    runWithContext("Update user", async () => {
      const data = await client.fetchApi<{ success?: boolean }>(`/u/${params.username}.json`, {
        method: "PUT",
        body: {
          name: params.name,
          email: params.email,
          title: params.title,
          trust_level: params.trustLevel,
          active: params.active,
          suspend_until: params.suspendedUntil,
          suspend_reason: params.suspendReason,
          staged: params.staged,
          bio_raw: params.bioRaw,
          locale: params.locale,
        },
      });

      if (!data) {
        throw new Error("Empty update user response");
      }

      return { success: data.success !== false };
    }),

  deleteUser: (params: {
    userId: number;
    blockEmail?: boolean;
    blockUrls?: boolean;
    blockIp?: boolean;
    deletePosts?: boolean;
    context?: string;
  }) =>
    runWithContext("Delete user", async () => {
      const query = client.buildQuery({
        context: params.context,
        delete_posts: params.deletePosts ? "true" : undefined,
        block_email: params.blockEmail ? "true" : undefined,
        block_urls: params.blockUrls ? "true" : undefined,
        block_ip: params.blockIp ? "true" : undefined,
      });
      const path = query
        ? `/admin/users/${params.userId}.json?${query}`
        : `/admin/users/${params.userId}.json`;

      const data = await client.fetchApi<{ success?: boolean }>(path, {
        method: "DELETE",
      });

      if (!data) {
        throw new Error("Empty delete user response");
      }

      return { success: data.success !== false };
    }),

  listUsers: (params: { page?: number }) =>
    runWithContext("List users", async () => {
      const page = normalizePage(params.page, 0);
      const path = page > 0 ? `/users.json?page=${page}` : "/users.json";
      const data = await client.fetchApi<{ users?: any[] }>(path);
      const users = data?.users ?? [];
      if (!Array.isArray(users)) {
        throw new Error("Malformed users response");
      }
      return users.map((u: any) => mapUserSummary(u));
    }),

  listAdminUsers: (params: { filter: string; page?: number; showEmails?: boolean }) =>
    runWithContext("List admin users", async () => {
      const query = client.buildQuery({
        page: normalizePage(params.page, 0) || undefined,
        show_emails: params.showEmails ? "true" : undefined,
      });
      const suffix = query ? `?${query}` : "";
      const data = await client.fetchApi<AdminUsersResponse>(
        `/admin/users/list/${params.filter}.json${suffix}`
      );
      if (!data || !Array.isArray(data)) {
        throw new Error("Empty admin users response");
      }
      return data.map((user) => mapAdminUser(user));
    }),

  getUserByExternal: (params: { externalId: string; provider: string }) =>
    runWithContext("Get user by external id", async () => {
      const data = await client.fetchApi<{ user?: any }>(
        `/u/by-external/${encodeURIComponent(params.provider)}/${encodeURIComponent(params.externalId)}.json`
      );

      if (!data || !data.user) {
        throw new Error("Empty external user response");
      }

      return mapUserProfile(data.user);
    }),

  getDirectory: (params: { period: string; order: string; page?: number }) =>
    runWithContext("Get directory", async () => {
      const page = normalizePage(params.page, 0);
      const query = client.buildQuery({
        period: params.period,
        order: params.order,
        page: page > 0 ? page : undefined,
      });
      const path = `/directory_items.json?${query}`;
      const data = await client.fetchApi<DirectoryResponse>(path);
      const items = data?.directory_items ?? [];
      if (!Array.isArray(items)) {
        throw new Error("Malformed directory response");
      }
      const mapped = items.map((item) => mapDirectoryItem(item));
      const total =
        typeof data?.meta?.total_rows_directory_items === "number"
          ? data.meta.total_rows_directory_items
          : mapped.length;
      return { items: mapped, totalRows: total };
    }),

  forgotPassword: (login: string) =>
    runWithContext("Forgot password", async () => {
      const data = await client.fetchApi<{ success?: boolean }>(
        "/session/forgot_password",
        {
          method: "POST",
          body: { login },
        }
      );

      return { success: data?.success !== false };
    }),

  changePassword: (params: { token: string; password: string }) =>
    runWithContext("Change password", async () => {
      const data = await client.fetchApi<{ success?: boolean }>(
        `/u/password-reset/${encodeURIComponent(params.token)}.json`,
        {
          method: "PUT",
          body: {
            password: params.password,
            password_confirmation: params.password,
          },
        }
      );

      if (!data) {
        throw new Error("Empty password change response");
      }

      return { success: data.success !== false };
    }),

  logoutUser: (userId: number) =>
    runWithContext("Logout user", async () => {
      const data = await client.fetchApi<{ success?: boolean }>(
        `/admin/users/${userId}/log_out`,
        { method: "POST" }
      );

      if (!data) {
        throw new Error("Empty logout response");
      }

      return { success: data.success !== false };
    }),

  syncSso: (params: { sso: string; sig: string }) =>
    runWithContext("Sync SSO", async () => {
      const data = await client.fetchApi<{ success?: boolean; user_id?: number }>(
        "/admin/users/sync_sso",
        {
          method: "POST",
          body: {
            sso: params.sso,
            sig: params.sig,
          },
        }
      );

      if (!data) {
        throw new Error("Empty SSO sync response");
      }

      return {
        success: data.success !== false,
        userId: typeof data.user_id === "number" ? data.user_id : undefined,
      };
    }),

  getUserStatus: (username: string) =>
    runWithContext("Get user status", async () => {
      const data = await client.fetchApi<{ status?: any }>(`/u/${username}/status.json`);
      if (!data || !data.status) {
        return { status: null as UserStatus | null };
      }
      return { status: mapUserStatus(data.status) };
    }),

  updateUserStatus: (params: {
    username: string;
    emoji?: string | null;
    description?: string | null;
    endsAt?: string | null;
  }) =>
    runWithContext("Update user status", async () => {
      const data = await client.fetchApi<{ status?: any }>(
        `/u/${params.username}/status.json`,
        {
          method: "PUT",
          body: {
            status: {
              emoji: params.emoji ?? null,
              description: params.description ?? null,
              ends_at: params.endsAt ?? null,
            },
          },
        }
      );

      if (!data || !data.status) {
        throw new Error("Empty status response");
      }

      return { status: mapUserStatus(data.status) };
    }),

  validateUserApiKey: (userApiKey: string) =>
    Effect.tryPromise(async () => {
      try {
        if (typeof userApiKey !== "string" || !userApiKey.trim()) {
          return {
            valid: false as const,
            error: "API key invalid: User API key is required",
            retryable: false as const,
          };
        }

        try {
          const data = await client.fetchApi<{ current_user: any }>(
            "/session/current.json",
            { userApiKey }
          );

          if (!data || !data.current_user) {
            return {
              valid: false as const,
              error: "Invalid response: no current_user",
              retryable: false as const,
            };
          }

          const user = data.current_user;

          let mapped: DiscourseUser;
          try {
            mapped = mapUserSummary(user);
          } catch {
            return {
              valid: false as const,
              error: "Invalid response: malformed current_user",
              retryable: false as const,
            };
          }

          return {
            valid: true as const,
            user: mapped,
          };
        } catch (error) {
          return {
            valid: false as const,
            error: `API key invalid: ${formatError(error)}`,
            retryable: isRetryableValidationError(error),
          };
        }
      } catch (error) {
        return {
          valid: false as const,
          error: `Validation failed: ${formatError(error)}`,
          retryable: true as const,
        };
      }
    }),
});

export type UsersResource = ReturnType<typeof createUsersResource>;
