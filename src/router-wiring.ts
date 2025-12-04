import type { Implementer } from "every-plugin/orpc";
import type { contract } from "./contract";
import { buildAuthRouter } from "./routers/auth";
import { buildMetaRouter } from "./routers/meta";
import { buildPostsRouter } from "./routers/posts";
import { buildSearchRouter } from "./routers/search";
import { buildTopicsRouter } from "./routers/topics";
import { buildUsersRouter } from "./routers/users";
import { buildUploadsRouter } from "./routers/uploads";
import { mapValidateUserApiKeyResult } from "./plugin-config";
import { sanitizeErrorForLog } from "./plugin-errors";
import type { PluginContext } from "./index";
import type { RouterHelpers } from "./router-helpers";
import { createRouterHelpers, RouterConfigError } from "./router-helpers";

type MergeRouters<Routers extends readonly unknown[]> = Routers extends readonly [
  infer Head,
  ...infer Tail
]
  ? Head & MergeRouters<Tail>
  : {};

const assembleRouters = (
  builder: Implementer<typeof contract, PluginContext, PluginContext>,
  context: PluginContext,
  helpers: RouterHelpers
) => {
  const routers = buildAllRouters({ builder, context, helpers });
  return Object.assign(
    {},
    ...routers
  ) as MergeRouters<ReturnType<typeof buildAllRouters>>;
};

const buildAllRouters = ({
  builder,
  context,
  helpers,
}: {
  builder: Implementer<typeof contract, PluginContext, PluginContext>;
  context: PluginContext;
  helpers: RouterHelpers;
}) => {
  const {
    discourseService,
    cryptoService,
    nonceManager,
    normalizedUserApiScopes,
    config,
    cleanupFiber,
  } = context;
  const {
    log,
    run,
    withErrorLogging,
    makeHandler,
    wrapRoute,
    enforceRateLimit,
    withCache,
    invalidateCache,
    invalidateCacheByPrefix,
    cacheStats,
  } = helpers;

  const uploadsRouter = buildUploadsRouter({
    builder,
    discourseService,
    log,
    run,
    withErrorLogging,
    enforceRateLimit,
  });

  const metaRouter = buildMetaRouter({
    builder,
    discourseService,
    log,
    run,
    config,
    cleanupFiber,
    wrapRoute,
    cacheStats,
    invalidateCache,
    invalidateCacheByPrefix,
  });

  return [
    buildAuthRouter({
      builder,
      cryptoService,
      discourseService,
      nonceManager,
      normalizedUserApiScopes,
      log,
      run,
      makeHandler,
      sanitizeErrorForLog,
      mapValidateUserApiKeyResult,
      RouterConfigError,
    }),
    buildPostsRouter({
      builder,
      discourseService,
      log,
      run,
      makeHandler,
      withCache,
      invalidateCache,
      invalidateCacheByPrefix,
      RouterConfigError,
    }),
    buildSearchRouter({
      builder,
      discourseService,
      log,
      run,
      makeHandler,
    }),
    buildTopicsRouter({
      builder,
      discourseService,
      log,
      run,
      makeHandler,
      withCache,
      invalidateCache,
      invalidateCacheByPrefix,
    }),
    buildUsersRouter({
      builder,
      discourseService,
      log,
      run,
      makeHandler,
    }),
    uploadsRouter,
    metaRouter,
  ] as const;
};

export const createRouter = (
  context: PluginContext,
  builder: Implementer<typeof contract, PluginContext, PluginContext>
) => {
  const helpers = createRouterHelpers(context);
  return assembleRouters(builder, context, helpers);
};

export { assembleRouters, buildAllRouters };
