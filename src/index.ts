import { createPlugin } from "every-plugin";
import type {
  PluginClientType,
  PluginConfigInput,
  PluginContext as RuntimePluginContext,
  PluginContract as RuntimePluginContract,
  PluginRouterType,
} from "every-plugin";
import { Effect, Fiber } from "every-plugin/effect";
import { contract } from "./contract";
import {
  CryptoService,
  DiscourseService,
  NonceManager,
  createSafeLogger,
  noopLogger,
  type SafeLogger,
} from "./service";
import {
  DiscoursePluginConfig,
  SecretsSchema,
  VariablesSchema,
  normalizeUserApiScopes,
  type NormalizedUserApiScopes,
  type Secrets,
  type Variables,
} from "./plugin-config";
import { createRateLimiter } from "./rate-limit";
import { createCache } from "./cache";
import { createRouter } from "./router-wiring";
import {
  createDiscourseDeps,
  interruptCleanupFiber,
  startNonceCleanup,
} from "./runtime/deps";
import { createRouterHelpers } from "./router-helpers";
import type { Cache } from "./cache";
import type { RateLimiter } from "./rate-limit";

export type PluginContext = {
  discourseService: DiscourseService;
  cryptoService: CryptoService;
  nonceManager: NonceManager;
  config: DiscoursePluginConfig;
  logger: SafeLogger;
  normalizedUserApiScopes: NormalizedUserApiScopes;
  cleanupFiber: Fiber.RuntimeFiber<never, never>;
  bodySnippetLength: number;
  metrics: {
    retryAttempts: number;
    nonceEvictions: number;
  };
  rateLimiter: RateLimiter;
  cache: Cache;
};

/**
 * Discourse Plugin
 *
 * Enables authenticated users to interact with Discourse forums.
 * Uses system API key with impersonation for user operations.
 *
 * Features:
 * - OAuth flow for linking Discourse accounts
 * - Create and edit posts via impersonation
 * - Search and browse forum content
 * - RSA encryption for secure OAuth key exchange
 *
 * Note: Authentication is handled by the host application.
 * This plugin expects username to be provided for write operations.
 */

export {
  mapValidateUserApiKeyResult,
  normalizeUserApiScopes,
  RawUserApiScopesSchema,
  SecretsSchema,
  VariablesSchema,
} from "./plugin-config";

export {
  mapDiscourseApiError,
  mapPluginError,
  resolveBodySnippet,
  resolveCause,
  sanitizeErrorForLog,
} from "./plugin-errors";

export {
  RouterConfigError,
  createRouterHelpers,
  createWithErrorLogging,
} from "./router-helpers";
export type { LogFn, MakeHandler, RunEffect } from "./router-helpers";
export { createRateLimiter } from "./rate-limit";
export { createCache } from "./cache";
export { createRouter } from "./router-wiring";

// Internal exports for tests
export const __internalCreateRouterHelpers = createRouterHelpers;
export const __internalCreateCache = createCache;
export const __internalCreateRateLimiter = createRateLimiter;

export type {
  DiscoursePluginConfig,
  NormalizedUserApiScopes,
  Secrets,
  Variables,
} from "./plugin-config";

export type { PluginErrorConstructors } from "./plugin-errors";

const discoursePlugin = createPlugin({
  variables: VariablesSchema,

  secrets: SecretsSchema,

  contract,

  initialize: (config: DiscoursePluginConfig) =>
    Effect.gen(function* () {
      const logger = createSafeLogger(config.logger ?? noopLogger);
      const metrics = { retryAttempts: 0, nonceEvictions: 0 };
      const rateLimiter = createRateLimiter({
        requestsPerSecond: config.variables.requestsPerSecond,
        strategy: config.variables.rateLimitStrategy,
        maxBuckets: config.variables.rateLimitMaxBuckets,
        bucketTtlMs: config.variables.rateLimitBucketTtlMs,
      });
      const cache = createCache(
        config.variables.cacheMaxSize,
        config.variables.cacheTtlMs,
        { logger }
      );
      const normalizedUserApiScopes = normalizeUserApiScopes(
        config.variables.userApiScopes
      );
      const { discourseService, cryptoService, nonceManager, bodySnippetLength } =
        createDiscourseDeps(config, logger, metrics);
      const cleanupFiber = yield* startNonceCleanup(
        nonceManager,
        config.variables.nonceCleanupIntervalMs,
        logger
      );

      return {
        discourseService,
        cryptoService,
        nonceManager,
        config,
        logger,
        normalizedUserApiScopes,
        cleanupFiber,
        bodySnippetLength,
        metrics,
        rateLimiter,
        cache,
      };
    }),

  shutdown: (context: PluginContext) =>
    Effect.zipRight(
      Effect.sync(() => context.nonceManager.cleanup()),
      interruptCleanupFiber(context.cleanupFiber)
    ),

  createRouter,
});

export default discoursePlugin;

// Type helpers for consumers
export type DiscoursePlugin = typeof discoursePlugin;
export type DiscoursePluginContract = RuntimePluginContract<DiscoursePlugin>;
export type DiscoursePluginConfigInput = PluginConfigInput<DiscoursePlugin> &
  Pick<
    DiscoursePluginConfig,
    "logger" | "requestLogger" | "fetch" | "operationRetryPolicy"
  >;
export type DiscoursePluginRouter = PluginRouterType<DiscoursePlugin>;
export type DiscoursePluginClient = PluginClientType<DiscoursePlugin>;
export type DiscoursePluginContext = RuntimePluginContext<DiscoursePlugin>;
