import type { Implementer } from "every-plugin/orpc";
import type { DiscourseService } from "../service";
import type { contract } from "../contract";
import type {
  DiscoursePluginConfig,
  LogFn,
  MakeHandler,
  PluginContext,
  RunEffect,
} from "../index";
import type { PluginErrorConstructors } from "../plugin-errors";
import type { createWithErrorLogging } from "../index";

type Builder = Implementer<typeof contract, PluginContext, PluginContext>;
type WithErrorLogging = ReturnType<typeof createWithErrorLogging>;

export const buildMetaRouter = (params: {
  builder: Builder;
  discourseService: DiscourseService;
  log: LogFn;
  run: RunEffect;
  config: DiscoursePluginConfig;
  cleanupFiber: PluginContext["cleanupFiber"];
  withErrorLogging: WithErrorLogging;
  enforceRateLimit: (action: string, errors: PluginErrorConstructors) => void;
  withCache: <T>(params: { action: string; key: string; fetch: () => Promise<T> }) => Promise<T>;
  cacheStats: () => { size: number; hits: number; misses: number; ttlMs: number };
}) => {
  const {
    builder,
    discourseService,
    log,
    run,
    config,
    cleanupFiber,
    withErrorLogging,
    enforceRateLimit,
    withCache,
    cacheStats,
  } = params;

  const cached = <T>(action: string, key: string, fetch: () => Promise<T>) =>
    withCache({ action, key, fetch });

  const resolveStatus = (checks: { discourse: boolean; cache: boolean; cleanup: boolean }) => {
    const values = Object.values(checks);
    const healthyCount = values.filter(Boolean).length;
    if (healthyCount === values.length) return "healthy" as const;
    if (healthyCount === 0) return "unhealthy" as const;
    return "degraded" as const;
  };

  return {
    ping: builder.ping.handler(async ({ errors }) => {
      enforceRateLimit("ping", errors);
      const timeoutMs = Math.min(config.variables.requestTimeoutMs, 2000);

      const discourse = await run(
        discourseService.checkHealth({
          timeoutMs,
        })
      );

      const cacheStatus = cacheStats();
      const cache = cacheStatus.ttlMs > 0;
      const cleanup = Boolean(cleanupFiber);

      const checks = { discourse, cache, cleanup };
      const status = resolveStatus(checks);

      log(status === "healthy" ? "debug" : status === "degraded" ? "warn" : "error", "Ping Discourse", {
        action: "ping",
        checks,
        timeoutMs,
        cache: cacheStatus,
        status,
      });

      return {
        status,
        checks,
        timestamp: new Date().toISOString(),
      };
    }),

    getTags: builder.getTags.handler(async ({ errors }) =>
      (enforceRateLimit("get-tags", errors),
      withErrorLogging(
        "get-tags",
        async () =>
          cached("get-tags", "meta:get-tags", async () => {
            const tags = await run(discourseService.getTags());
            log("debug", "Fetched tags", {
              action: "get-tags",
              count: tags.length,
            });
            return { tags };
          }),
        errors
      ))
    ),

    getTag: builder.getTag.handler(async ({ input, errors }) =>
      (enforceRateLimit("get-tag", errors),
      withErrorLogging(
        "get-tag",
        async () =>
          cached("get-tag", `meta:get-tag:${input.name}`, async () => {
            const tag = await run(discourseService.getTag(input.name));
            log("debug", "Fetched tag", {
              action: "get-tag",
              name: input.name,
            });
            return { tag };
          }),
        errors
      ))
    ),

    getTagGroups: builder.getTagGroups.handler(async ({ errors }) =>
      (enforceRateLimit("get-tag-groups", errors),
      withErrorLogging(
        "get-tag-groups",
        async () =>
          cached("get-tag-groups", "meta:get-tag-groups", async () => {
            const tagGroups = await run(discourseService.getTagGroups());
            log("debug", "Fetched tag groups", {
              action: "get-tag-groups",
              count: tagGroups.length,
            });
            return { tagGroups };
          }),
        errors
      ))
    ),

    getTagGroup: builder.getTagGroup.handler(async ({ input, errors }) =>
      (enforceRateLimit("get-tag-group", errors),
      withErrorLogging(
        "get-tag-group",
        async () =>
          cached("get-tag-group", `meta:get-tag-group:${input.tagGroupId}`, async () => {
            const tagGroup = await run(discourseService.getTagGroup(input.tagGroupId));
            log("debug", "Fetched tag group", {
              action: "get-tag-group",
              tagGroupId: input.tagGroupId,
            });
            return { tagGroup };
          }),
        errors
      ))
    ),

    createTagGroup: builder.createTagGroup.handler(async ({ input, errors }) =>
      (enforceRateLimit("create-tag-group", errors),
      withErrorLogging(
        "create-tag-group",
        async () => {
          const tagGroup = await run(
            discourseService.createTagGroup({
              name: input.name,
              tagNames: input.tagNames,
              parentTagNames: input.parentTagNames,
              onePerTopic: input.onePerTopic,
              permissions: input.permissions,
            })
          );
          log("info", "Created tag group", {
            action: "create-tag-group",
            name: input.name,
          });
          return { tagGroup };
        },
        errors
      ))
    ),

    updateTagGroup: builder.updateTagGroup.handler(async ({ input, errors }) =>
      (enforceRateLimit("update-tag-group", errors),
      withErrorLogging(
        "update-tag-group",
        async () => {
          const tagGroup = await run(
            discourseService.updateTagGroup({
              tagGroupId: input.tagGroupId,
              name: input.name,
              tagNames: input.tagNames,
              parentTagNames: input.parentTagNames,
              onePerTopic: input.onePerTopic,
              permissions: input.permissions,
            })
          );
          log("info", "Updated tag group", {
            action: "update-tag-group",
            tagGroupId: input.tagGroupId,
          });
          return { tagGroup };
        },
        errors
      ))
    ),

    getCategories: builder.getCategories.handler(async ({ errors }) =>
      (enforceRateLimit("get-categories", errors),
      withErrorLogging(
        "get-categories",
        async () =>
          cached("get-categories", "meta:get-categories", async () => {
            const categories = await run(discourseService.getCategories());
            log("debug", "Fetched categories", { action: "get-categories" });
            return { categories };
          }),
        errors
      ))
    ),

    getCategory: builder.getCategory.handler(async ({ input, errors }) =>
      (enforceRateLimit("get-category", errors),
      withErrorLogging(
        "get-category",
        async () =>
          cached("get-category", `meta:get-category:${JSON.stringify(input)}`, async () => {
            const result = await run(discourseService.getCategory(input.idOrSlug));
            log("debug", "Fetched category", {
              action: "get-category",
              idOrSlug: input.idOrSlug,
            });
            return result;
          }),
        errors
      ))
    ),

    getSiteInfo: builder.getSiteInfo.handler(async ({ errors }) =>
      (enforceRateLimit("get-site-info", errors),
      withErrorLogging(
        "get-site-info",
        async () =>
          cached("get-site-info", "meta:get-site-info", async () => {
            const site = await run(discourseService.getSiteInfo());
            log("debug", "Fetched site info", {
              action: "get-site-info",
              categories: site.categories.length,
            });
            return site;
          }),
        errors
      ))
    ),

    getSiteBasicInfo: builder.getSiteBasicInfo.handler(async ({ errors }) =>
      (enforceRateLimit("get-site-basic-info", errors),
      withErrorLogging(
        "get-site-basic-info",
        async () =>
          cached("get-site-basic-info", "meta:get-site-basic-info", async () => {
            const site = await run(discourseService.getSiteBasicInfo());
            log("debug", "Fetched site basic info", {
              action: "get-site-basic-info",
              title: site.title,
            });
            return site;
          }),
        errors
      ))
    ),
  };
};
