import type { Implementer } from "every-plugin/orpc";
import type { DiscourseService } from "../service";
import type { contract } from "../contract";
import type {
  DiscoursePluginConfig,
  LogFn,
  PluginContext,
  RunEffect,
} from "../index";
import type { WrapRoute } from "../router-helpers";

type Builder = Implementer<typeof contract, PluginContext, PluginContext>;

export const buildMetaRouter = (params: {
  builder: Builder;
  discourseService: DiscourseService;
  log: LogFn;
  run: RunEffect;
  config: DiscoursePluginConfig;
  cleanupFiber: PluginContext["cleanupFiber"];
  wrapRoute: WrapRoute;
  cacheStats: () => { size: number; hits: number; misses: number; ttlMs: number };
  invalidateCache?: (keys: string[]) => void;
  invalidateCacheByPrefix?: (prefixes: string[]) => void;
}) => {
  const {
    builder,
    discourseService,
    log,
    run,
    config,
    cleanupFiber,
    wrapRoute,
    cacheStats,
    invalidateCache = () => {},
    invalidateCacheByPrefix = () => {},
  } = params;

  const resolveStatus = (checks: { discourse: boolean; cache: boolean; cleanup: boolean }) => {
    const values = Object.values(checks);
    const healthyCount = values.filter(Boolean).length;
    if (healthyCount === values.length) return "healthy" as const;
    if (healthyCount === 0) return "unhealthy" as const;
    return "degraded" as const;
  };

  const invalidateTagCaches = () => {
    invalidateCache(["meta:get-tags", "meta:get-tag-groups"]);
    invalidateCacheByPrefix(["meta:get-tag:", "meta:get-tag-group:"]);
  };

  return {
    ping: builder.ping.handler(
      wrapRoute({
        action: "ping",
        handler: async () => {
          const timeoutMs = Math.min(config.variables.requestTimeoutMs, 2000);
          const cacheConfigured =
            (config.variables.cacheMaxSize ?? 0) > 0 && (config.variables.cacheTtlMs ?? 0) > 0;
          const discourse = await run(
            discourseService.checkHealth({
              timeoutMs,
            })
          );

          const cacheStatus = cacheStats();
          const cache = cacheConfigured ? cacheStatus.ttlMs > 0 : true;
          const cleanup = Boolean(cleanupFiber);

          const checks = { discourse, cache, cleanup };
          const status = resolveStatus(checks);

          log(
            status === "healthy" ? "debug" : status === "degraded" ? "warn" : "error",
            "Ping Discourse",
            {
              action: "ping",
              checks,
              timeoutMs,
              cache: cacheStatus,
              cacheDisabled: !cacheConfigured,
              status,
            }
          );

          return {
            status,
            checks,
            timestamp: new Date().toISOString(),
          };
        },
      })
    ),

    getTags: builder.getTags.handler(
      wrapRoute({
        action: "get-tags",
        cacheKey: "meta:get-tags",
        handler: async () => {
          const tags = await run(discourseService.getTags());
          log("debug", "Fetched tags", {
            action: "get-tags",
            count: tags.length,
          });
          return { tags };
        },
      })
    ),

    getTag: builder.getTag.handler(
      wrapRoute({
        action: "get-tag",
        cacheKey: (input) => `meta:get-tag:${input.name}`,
        handler: async ({ input }) => {
          const tag = await run(discourseService.getTag(input.name));
          log("debug", "Fetched tag", {
            action: "get-tag",
            name: input.name,
          });
          return { tag };
        },
      })
    ),

    getTagGroups: builder.getTagGroups.handler(
      wrapRoute({
        action: "get-tag-groups",
        cacheKey: "meta:get-tag-groups",
        handler: async () => {
          const tagGroups = await run(discourseService.getTagGroups());
          log("debug", "Fetched tag groups", {
            action: "get-tag-groups",
            count: tagGroups.length,
          });
          return { tagGroups };
        },
      })
    ),

    getTagGroup: builder.getTagGroup.handler(
      wrapRoute({
        action: "get-tag-group",
        cacheKey: (input) => `meta:get-tag-group:${input.tagGroupId}`,
        handler: async ({ input }) => {
          const tagGroup = await run(discourseService.getTagGroup(input.tagGroupId));
          log("debug", "Fetched tag group", {
            action: "get-tag-group",
            tagGroupId: input.tagGroupId,
          });
          return { tagGroup };
        },
      })
    ),

    createTagGroup: builder.createTagGroup.handler(
      wrapRoute({
        action: "create-tag-group",
        handler: async ({ input }) => {
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
          invalidateTagCaches();
          return { tagGroup };
        },
      })
    ),

    updateTagGroup: builder.updateTagGroup.handler(
      wrapRoute({
        action: "update-tag-group",
        handler: async ({ input }) => {
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
          invalidateTagCaches();
          return { tagGroup };
        },
      })
    ),

    getCategories: builder.getCategories.handler(
      wrapRoute({
        action: "get-categories",
        cacheKey: "meta:get-categories",
        handler: async () => {
          const categories = await run(discourseService.getCategories());
          log("debug", "Fetched categories", { action: "get-categories" });
          return { categories };
        },
      })
    ),

    getCategory: builder.getCategory.handler(
      wrapRoute({
        action: "get-category",
        cacheKey: (input) => `meta:get-category:${JSON.stringify(input)}`,
        handler: async ({ input }) => {
          const result = await run(discourseService.getCategory(input.idOrSlug));
          log("debug", "Fetched category", {
            action: "get-category",
            idOrSlug: input.idOrSlug,
          });
          return result;
        },
      })
    ),

    getSiteInfo: builder.getSiteInfo.handler(
      wrapRoute({
        action: "get-site-info",
        cacheKey: "meta:get-site-info",
        handler: async () => {
          const site = await run(discourseService.getSiteInfo());
          log("debug", "Fetched site info", {
            action: "get-site-info",
            categories: site.categories.length,
          });
          return site;
        },
      })
    ),

    getSiteBasicInfo: builder.getSiteBasicInfo.handler(
      wrapRoute({
        action: "get-site-basic-info",
        cacheKey: "meta:get-site-basic-info",
        handler: async () => {
          const site = await run(discourseService.getSiteBasicInfo());
          log("debug", "Fetched site basic info", {
            action: "get-site-basic-info",
            title: site.title,
          });
          return site;
        },
      })
    ),
  };
};
