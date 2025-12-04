import type { Implementer } from "every-plugin/orpc";
import type { DiscourseService } from "../service";
import type { contract } from "../contract";
import type { PluginContext, LogFn, RunEffect, MakeHandler } from "../index";

type Builder = Implementer<typeof contract, PluginContext, PluginContext>;

export const buildSearchRouter = (params: {
  builder: Builder;
  discourseService: DiscourseService;
  log: LogFn;
  run: RunEffect;
  makeHandler: MakeHandler;
}) => {
  const { builder, discourseService, log, run, makeHandler } = params;

  return {
    search: builder.search.handler(
      makeHandler("search", async ({ input }) => {
        const result = await run(
          discourseService.search({
            query: input.query,
            category: input.category,
            username: input.username,
            tags: input.tags,
            before: input.before,
            after: input.after,
            order: input.order,
            status: input.status,
            in: input.in,
            page: input.page,
            userApiKey: input.userApiKey,
          })
        );
        log("debug", "Performed search", {
          action: "search",
          query: input.query,
          category: input.category,
          username: input.username,
          page: input.page,
        });
        return result;
      })
    ),

    getDirectory: builder.getDirectory.handler(
      makeHandler("get-directory", async ({ input }) => {
        const result = await run(
          discourseService.getDirectory({
            period: input.period,
            order: input.order,
            page: input.page,
          })
        );

        log("debug", "Fetched user directory", {
          action: "get-directory",
          period: input.period,
          order: input.order,
          page: input.page,
        });

        return result;
      })
    ),
  };
};
