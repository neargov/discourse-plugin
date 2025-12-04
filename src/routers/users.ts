import type { Implementer } from "every-plugin/orpc";
import type { DiscourseService } from "../service";
import type { contract } from "../contract";
import type { PluginContext, LogFn, RunEffect, MakeHandler } from "../index";

type Builder = Implementer<typeof contract, PluginContext, PluginContext>;

export const buildUsersRouter = (params: {
  builder: Builder;
  discourseService: DiscourseService;
  log: LogFn;
  run: RunEffect;
  makeHandler: MakeHandler;
}) => {
  const { builder, discourseService, log, run, makeHandler } = params;

  return {
    getUser: builder.getUser.handler(
      makeHandler("get-user", async ({ input }) => {
        const user = await run(discourseService.getUser(input.username));
        log("debug", "Fetched user", {
          action: "get-user",
          username: input.username,
        });
        return { user };
      })
    ),

    createUser: builder.createUser.handler(
      makeHandler("create-user", async ({ input }) => {
        const result = await run(
          discourseService.createUser({
            username: input.username,
            email: input.email,
            name: input.name,
            password: input.password,
            active: input.active,
            approved: input.approved,
            externalId: input.externalId,
            externalProvider: input.externalProvider,
            staged: input.staged,
            emailVerified: input.emailVerified,
            locale: input.locale,
          })
        );

        log("info", "Created Discourse user", {
          action: "create-user",
          username: input.username,
          userId: result.userId,
        });

        return result;
      })
    ),

    updateUser: builder.updateUser.handler(
      makeHandler("update-user", async ({ input }) => {
        const result = await run(
          discourseService.updateUser({
            username: input.username,
            email: input.email,
            name: input.name,
            title: input.title,
            trustLevel: input.trustLevel,
            active: input.active,
            suspendedUntil: input.suspendedUntil,
            suspendReason: input.suspendReason,
            staged: input.staged,
            bioRaw: input.bioRaw,
            locale: input.locale,
          })
        );

        log("info", "Updated Discourse user", {
          action: "update-user",
          username: input.username,
        });

        return result;
      })
    ),

    deleteUser: builder.deleteUser.handler(
      makeHandler(
        "delete-user",
        async ({ input }) => {
          const result = await run(
            discourseService.deleteUser({
              userId: input.userId,
              blockEmail: input.blockEmail,
              blockUrls: input.blockUrls,
              blockIp: input.blockIp,
              deletePosts: input.deletePosts,
              context: input.context,
            })
          );

          log("info", "Deleted Discourse user", {
            action: "delete-user",
            userId: input.userId,
            deletePosts: input.deletePosts,
          });

          return result;
        },
        (input) => ({
          userId: input.userId,
          deletePosts: input.deletePosts,
        })
      )
    ),

    listUsers: builder.listUsers.handler(
      makeHandler("list-users", async ({ input }) => {
        const users = await run(discourseService.listUsers({ page: input.page }));
        log("debug", "Listed Discourse users", {
          action: "list-users",
          page: input.page,
        });
        return { users };
      })
    ),

    listAdminUsers: builder.listAdminUsers.handler(
      makeHandler(
        "list-admin-users",
        async ({ input }) => {
          const users = await run(
            discourseService.listAdminUsers({
              filter: input.filter,
              page: input.page,
              showEmails: input.showEmails,
            })
          );
          log("debug", "Listed admin users", {
            action: "list-admin-users",
            filter: input.filter,
            page: input.page,
            showEmails: input.showEmails,
          });
          return { users };
        },
        (input) => ({
          filter: input.filter,
          page: input.page,
          showEmails: input.showEmails,
        })
      )
    ),

    getUserByExternal: builder.getUserByExternal.handler(
      makeHandler("get-user-by-external", async ({ input }) => {
        const user = await run(
          discourseService.getUserByExternal({
            externalId: input.externalId,
            provider: input.provider,
          })
        );

        log("debug", "Fetched user by external id", {
          action: "get-user-by-external",
          provider: input.provider,
        });

        return { user };
      })
    ),

    forgotPassword: builder.forgotPassword.handler(
      makeHandler("forgot-password", async ({ input }) => {
        const result = await run(discourseService.forgotPassword(input.login));

        log("info", "Requested password reset", {
          action: "forgot-password",
          login: input.login,
        });

        return result;
      })
    ),

    changePassword: builder.changePassword.handler(
      makeHandler("change-password", async ({ input }) => {
        const result = await run(
          discourseService.changePassword({
            token: input.token,
            password: input.password,
          })
        );

        log("info", "Changed user password via token", {
          action: "change-password",
        });

        return result;
      })
    ),

    logoutUser: builder.logoutUser.handler(
      makeHandler("logout-user", async ({ input }) => {
        const result = await run(discourseService.logoutUser(input.userId));

        log("info", "Logged out Discourse user", {
          action: "logout-user",
          userId: input.userId,
        });

        return result;
      })
    ),

    syncSso: builder.syncSso.handler(
      makeHandler("sync-sso", async ({ input }) => {
        const result = await run(
          discourseService.syncSso({
            sso: input.sso,
            sig: input.sig,
          })
        );

        log("info", "Synchronized SSO payload", {
          action: "sync-sso",
          userId: result.userId,
        });

        return result;
      })
    ),

    getUserStatus: builder.getUserStatus.handler(
      makeHandler("get-user-status", async ({ input }) => {
        const result = await run(discourseService.getUserStatus(input.username));

        log("debug", "Fetched user status", {
          action: "get-user-status",
          username: input.username,
        });

        return result;
      })
    ),

    updateUserStatus: builder.updateUserStatus.handler(
      makeHandler("update-user-status", async ({ input }) => {
        const result = await run(
          discourseService.updateUserStatus({
            username: input.username,
            emoji: input.emoji,
            description: input.description,
            endsAt: input.endsAt,
          })
        );

        log("info", "Updated user status", {
          action: "update-user-status",
          username: input.username,
        });

        return result;
      })
    ),
  };
};
