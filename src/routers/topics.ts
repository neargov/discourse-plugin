import type { Implementer } from "every-plugin/orpc";
import type { DiscourseService } from "../service";
import type { contract } from "../contract";
import type { PluginContext, LogFn, RunEffect, MakeHandler } from "../index";

type Builder = Implementer<typeof contract, PluginContext, PluginContext>;

export const buildTopicsRouter = (params: {
  builder: Builder;
  discourseService: DiscourseService;
  log: LogFn;
  run: RunEffect;
  makeHandler: MakeHandler;
  withCache: <T>(params: { action: string; key: string; fetch: () => Promise<T> }) => Promise<T>;
}) => {
  const { builder, discourseService, log, run, makeHandler, withCache } = params;

  return {
    getTopic: builder.getTopic.handler(
      makeHandler("get-topic", async ({ input }) => {
        const topic = await withCache({
          action: "get-topic",
          key: `topic:${input.topicId}`,
          fetch: async () => run(discourseService.getTopic(input.topicId)),
        });
        log("debug", "Fetched topic", {
          action: "get-topic",
          topicId: input.topicId,
        });
        return { topic };
      })
    ),

    getLatestTopics: builder.getLatestTopics.handler(
      makeHandler("get-latest-topics", async ({ input }) => {
        const result = await withCache({
          action: "get-latest-topics",
          key: `topics:latest:${JSON.stringify(input)}`,
          fetch: async () =>
            run(
              discourseService.getLatestTopics({
                categoryId: input.categoryId,
                page: input.page,
                order: input.order,
              })
            ),
        });
        log("debug", "Fetched latest topics", {
          action: "get-latest-topics",
          categoryId: input.categoryId,
          page: input.page,
          order: input.order,
        });
        return result;
      })
    ),

    listTopicList: builder.listTopicList.handler(
      makeHandler("list-topic-list", async ({ input }) => {
        const result = await withCache({
          action: "list-topic-list",
          key: `topics:list:${JSON.stringify(input)}`,
          fetch: async () =>
            run(
              discourseService.getTopicList({
                type: input.type,
                categoryId: input.categoryId,
                page: input.page,
                order: input.order,
                period: input.period,
              })
            ),
        });
        log("debug", "Fetched topic list", {
          action: "list-topic-list",
          type: input.type,
          categoryId: input.categoryId,
          page: input.page,
          order: input.order,
          period: input.period,
        });
        return result;
      })
    ),

    getTopTopics: builder.getTopTopics.handler(
      makeHandler("get-top-topics", async ({ input }) => {
        const result = await withCache({
          action: "get-top-topics",
          key: `topics:top:${JSON.stringify(input)}`,
          fetch: async () =>
            run(
              discourseService.getTopTopics({
                period: input.period,
                categoryId: input.categoryId,
                page: input.page,
              })
            ),
        });
        log("debug", "Fetched top topics", {
          action: "get-top-topics",
          categoryId: input.categoryId,
          page: input.page,
          period: input.period,
        });
        return result;
      })
    ),

    getCategoryTopics: builder.getCategoryTopics.handler(
      makeHandler("get-category-topics", async ({ input }) => {
        const result = await withCache({
          action: "get-category-topics",
          key: `topics:category:${JSON.stringify(input)}`,
          fetch: async () =>
            run(
              discourseService.getCategoryTopics({
                slug: input.slug,
                categoryId: input.categoryId,
                page: input.page,
              })
            ),
        });
        log("debug", "Fetched category topics", {
          action: "get-category-topics",
          slug: input.slug,
          categoryId: input.categoryId,
          page: input.page,
        });
        return result;
      })
    ),

    updateTopicStatus: builder.updateTopicStatus.handler(
      makeHandler("update-topic-status", async ({ input }) => {
        const result = await run(
          discourseService.updateTopicStatus({
            topicId: input.topicId,
            status: input.status,
            enabled: input.enabled,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );

        log("info", "Updated topic status", {
          action: "update-topic-status",
          topicId: input.topicId,
          status: input.status,
          enabled: input.enabled,
        });

        return result;
      })
    ),

    updateTopicMetadata: builder.updateTopicMetadata.handler(
      makeHandler("update-topic-metadata", async ({ input }) => {
        const result = await run(
          discourseService.updateTopicMetadata({
            topicId: input.topicId,
            title: input.title,
            categoryId: input.categoryId,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );

        log("info", "Updated topic metadata", {
          action: "update-topic-metadata",
          topicId: input.topicId,
          hasTitle: Boolean(input.title),
          hasCategory: input.categoryId != null,
        });

        return result;
      })
    ),

    bookmarkTopic: builder.bookmarkTopic.handler(
      makeHandler("bookmark-topic", async ({ input }) => {
        const result = await run(
          discourseService.bookmarkTopic({
            topicId: input.topicId,
            postNumber: input.postNumber,
            username: input.username,
            userApiKey: input.userApiKey,
            reminderAt: input.reminderAt,
          })
        );

        log("info", "Bookmarked topic", {
          action: "bookmark-topic",
          topicId: input.topicId,
          postNumber: input.postNumber,
          bookmarkId: result.bookmarkId,
          username: input.username,
        });

        return result;
      })
    ),

    inviteToTopic: builder.inviteToTopic.handler(
      makeHandler("invite-to-topic", async ({ input }) => {
        const result = await run(
          discourseService.inviteToTopic({
            topicId: input.topicId,
            usernames: input.usernames,
            groupNames: input.groupNames,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );

        log("info", "Invited users/groups to topic", {
          action: "invite-to-topic",
          topicId: input.topicId,
          usernames: input.usernames,
          groupNames: input.groupNames,
        });

        return result;
      })
    ),

    setTopicNotification: builder.setTopicNotification.handler(
      makeHandler("set-topic-notification", async ({ input }) => {
        const result = await run(
          discourseService.setTopicNotification({
            topicId: input.topicId,
            level: input.level,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );

        log("info", "Updated topic notification level", {
          action: "set-topic-notification",
          topicId: input.topicId,
          level: result.notificationLevel,
          username: input.username,
        });

        return result;
      })
    ),

    changeTopicTimestamp: builder.changeTopicTimestamp.handler(
      makeHandler("change-topic-timestamp", async ({ input }) => {
        const result = await run(
          discourseService.changeTopicTimestamp({
            topicId: input.topicId,
            timestamp: input.timestamp,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );

        log("info", "Changed topic timestamp", {
          action: "change-topic-timestamp",
          topicId: input.topicId,
          timestamp: input.timestamp,
        });

        return result;
      })
    ),

    addTopicTimer: builder.addTopicTimer.handler(
      makeHandler("add-topic-timer", async ({ input }) => {
        const result = await run(
          discourseService.addTopicTimer({
            topicId: input.topicId,
            statusType: input.statusType,
            time: input.time,
            basedOnLastPost: input.basedOnLastPost,
            durationMinutes: input.durationMinutes,
            categoryId: input.categoryId,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );

        log("info", "Added topic timer", {
          action: "add-topic-timer",
          topicId: input.topicId,
          statusType: result.status,
          time: input.time,
          basedOnLastPost: input.basedOnLastPost,
          durationMinutes: input.durationMinutes,
          categoryId: input.categoryId,
        });

        return result;
      })
    ),
  };
};
