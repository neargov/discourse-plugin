import { createPlugin } from "every-plugin";
import type {
  PluginClientType,
  PluginConfigInput,
  PluginContext as RuntimePluginContext,
  PluginContract as RuntimePluginContract,
  PluginRouterType,
} from "every-plugin";
import type { Implementer } from "every-plugin/orpc";
import { Effect, Fiber } from "every-plugin/effect";
import { contract } from "./contract";
import { registerHandlers } from "./handlers";
import { buildAuthRouter } from "./routers/auth";
import { buildMetaRouter } from "./routers/meta";
import { buildPostsRouter } from "./routers/posts";
import { buildSearchRouter } from "./routers/search";
import { buildTopicsRouter } from "./routers/topics";
import { buildUsersRouter } from "./routers/users";
import { buildUploadsRouter } from "./routers/uploads";
import {
  CryptoService,
  DiscourseService,
  NonceManager,
  createSafeLogger,
  noopLogger,
  type SafeLogger,
} from "./service";
import { DEFAULT_BODY_SNIPPET_LENGTH } from "./constants";
import {
  DiscoursePluginConfig,
  RawUserApiScopesSchema,
  SecretsSchema,
  VariablesSchema,
  mapValidateUserApiKeyResult,
  normalizeUserApiScopes,
  type NormalizedUserApiScopes,
  type Secrets,
  type Variables,
} from "./plugin-config";
import {
  mapDiscourseApiError,
  mapPluginError,
  resolveBodySnippet,
  resolveCause,
  sanitizeErrorForLog,
  type PluginErrorConstructors,
} from "./plugin-errors";
import { normalizeMeta, unwrapError } from "./utils";
import {
  createDiscourseDeps,
  interruptCleanupFiber,
  startNonceCleanup,
} from "./runtime/deps";

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

export class RouterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterConfigError";
  }
}

export type LogFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>
) => void;

export type RunEffect = <A, E>(eff: Effect.Effect<A, E, never>) => Promise<A>;

export type MakeHandler = <I, O>(
  action: string,
  effect: (ctx: { input: I; errors: PluginErrorConstructors }) =>
    | Effect.Effect<O, any, never>
    | Promise<O>,
  logMeta?: (input: I) => Record<string, unknown>
) => (args: { input: I; errors: PluginErrorConstructors }) => Promise<O>;

type RateLimiter = {
  take: (action: string, clientId?: string) => { allowed: boolean; retryAfterMs: number };
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type Cache = {
  get: <T>(key: string) => T | undefined;
  set: <T>(key: string, value: T) => void;
  delete: (key: string) => void;
  deleteByPrefix?: (prefix: string) => number;
  stats: () => { size: number; hits: number; misses: number; evictions: number; ttlMs: number };
};

type WithErrorLoggingDeps = {
  log: LogFn;
  run: RunEffect;
  nonceManager: NonceManager;
  config: DiscoursePluginConfig;
  bodySnippetLength?: number;
  metrics?: { retryAttempts: number };
};

type RateLimitStrategy = "global" | "perAction" | "perClient" | "perActionClient";

const createRateLimiter = (params: {
  requestsPerSecond: number;
  strategy?: RateLimitStrategy;
  maxBuckets?: number;
  bucketTtlMs?: number;
}): RateLimiter => {
  const rate =
    Number.isFinite(params.requestsPerSecond) && params.requestsPerSecond > 0
      ? params.requestsPerSecond
      : 1;
  const capacity = Math.max(1, rate);
  const strategy = params.strategy ?? "global";
  const maxBucketsInput = params.maxBuckets ?? Number.NaN;
  const maxBuckets =
    Number.isFinite(maxBucketsInput) && maxBucketsInput > 0
      ? Math.floor(maxBucketsInput)
      : null;
  const bucketTtlMsInput = params.bucketTtlMs ?? Number.NaN;
  const bucketTtlMs =
    Number.isFinite(bucketTtlMsInput) && bucketTtlMsInput > 0
      ? bucketTtlMsInput
      : null;
  const buckets = new Map<
    string,
    {
      tokens: number;
      lastRefill: number;
    }
  >();

  const resolveKey = (action: string, clientId?: string) => {
    const safeAction = action || "default";
    const safeClient = clientId?.trim() || "default";
    if (strategy === "perAction") return `action:${safeAction}`;
    if (strategy === "perClient") return `client:${safeClient}`;
    if (strategy === "perActionClient") return `action-client:${safeAction}:${safeClient}`;
    return "global";
  };

  const purgeIdleBuckets = (now: number) => {
    if (bucketTtlMs) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.lastRefill > bucketTtlMs) {
          buckets.delete(key);
        }
      }
    }
  };

  const getBucket = (key: string) => {
    const now = Date.now();
    purgeIdleBuckets(now);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (maxBuckets) {
        while (buckets.size >= maxBuckets) {
          const oldestKey = buckets.keys().next().value!;
          buckets.delete(oldestKey);
        }
      }
      bucket = { tokens: capacity, lastRefill: Date.now() };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const takeFromBucket = (bucket: { tokens: number; lastRefill: number }) => {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * rate;
      bucket.tokens = Math.min(capacity, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true as const, retryAfterMs: 0 };
    }

    const missingTokens = 1 - Math.max(0, bucket.tokens);
    const retryAfterMs = Math.max(0, Math.ceil((missingTokens / rate) * 1000));
    return { allowed: false as const, retryAfterMs };
  };

  return {
    take: (action: string, clientId?: string) => {
      purgeIdleBuckets(Date.now());
      const key = resolveKey(action, clientId);
      const bucket = getBucket(key);
      return takeFromBucket(bucket);
    },
  };
};

const createCache = (
  maxSize: number,
  ttlMs: number,
  options?: { logger?: SafeLogger; now?: () => number }
): Cache => {
  const capacity = Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : 0;
  const safeTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  const map = new Map<string, CacheEntry<unknown>>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  const logger = options?.logger;
  const now = options?.now ?? (() => Date.now());

  const logDebug = (message: string, meta?: Record<string, unknown>) => {
    logger?.debug?.(message, normalizeMeta(meta));
  };

  if (capacity === 0 || safeTtlMs <= 0) {
    logDebug("Cache disabled", { action: "cache-init", maxSize, ttlMs: safeTtlMs });
  }

  const purgeExpired = () => {
    if (safeTtlMs <= 0) return;
    const nowMs = now();
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt < nowMs) {
        map.delete(key);
        evictions += 1;
        logDebug("Cache eviction", {
          action: "cache-evict",
          reason: "expired",
          key,
          ttlMs: safeTtlMs,
        });
      }
    }
  };

  const get = <T>(key: string): T | undefined => {
    purgeExpired();
    const entry = map.get(key);
    if (!entry) {
      misses += 1;
      return undefined;
    }
    const nowMs = now();
    if (entry.expiresAt < nowMs) {
      map.delete(key);
      evictions += 1;
      logDebug("Cache eviction", {
        action: "cache-evict",
        reason: "expired",
        key,
        ttlMs: safeTtlMs,
      });
      misses += 1;
      return undefined;
    }
    hits += 1;
    // Refresh recency by moving to the back.
    map.delete(key);
    map.set(key, entry);
    return entry.value as T;
  };

  const set = <T>(key: string, value: T) => {
    if (capacity === 0 || safeTtlMs <= 0) return;
    purgeExpired();
    // Replace existing to move it to the back.
    if (map.has(key)) {
      map.delete(key);
    }
    while (map.size >= capacity) {
      const oldestKey = map.keys().next().value!;
      map.delete(oldestKey);
      evictions += 1;
      logDebug("Cache eviction", {
        action: "cache-evict",
        reason: "capacity",
        key: oldestKey,
        ttlMs: safeTtlMs,
      });
    }
    map.set(key, { value, expiresAt: now() + safeTtlMs });
  };

  /* c8 ignore start */
  const del = (key: string) => {
    if (map.delete(key)) {
      evictions += 1;
      logDebug("Cache eviction", { action: "cache-evict", reason: "manual", key });
    }
  };
  /* c8 ignore stop */

  const deleteByPrefix = (prefix: string) => {
    let removed = 0;
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) {
        map.delete(key);
        removed += 1;
        evictions += 1;
        logDebug("Cache eviction", {
          action: "cache-evict",
          reason: "prefix",
          key,
          prefix,
        });
      }
    }
    return removed;
  };

  const stats = () => ({
    ...(purgeExpired(), {}),
    size: map.size,
    hits,
    misses,
    evictions,
    ttlMs: safeTtlMs,
  });

  return { get, set, delete: del, deleteByPrefix, stats };
};

const unwrapRunFailure = (error: unknown) => {
  const underlying = unwrapError(error);
  if (underlying !== error) {
    throw underlying;
  }

  const candidate =
    (error as any)?.cause ??
    (error as any)?.failure ??
    (error as any)?.error ??
    (error as any)?.defect;

  if (candidate) {
    throw unwrapError(candidate);
  }

  throw error;
};

const logFailure = (params: {
  log: LogFn;
  action: string;
  error: unknown;
  logMeta?: Record<string, unknown>;
  bodySnippetLength: number;
  attempt?: number;
}) => {
  const { log, action, error, logMeta, bodySnippetLength, attempt } = params;
  const meta = {
    action,
    ...logMeta,
    error: sanitizeErrorForLog(error, bodySnippetLength),
  };
  if (typeof attempt === "number") {
    (meta as any).attempt = attempt;
  }

  log("error", `${action} failed`, meta);
};

const mapPluginErrorWithRetryAfter = (
  error: unknown,
  params: {
    errors?: PluginErrorConstructors;
    nonceManager: NonceManager;
    fallbackRetryAfterMs: number;
  }
) =>
  mapPluginError(error, {
    errors: params.errors,
    nonceManager: params.nonceManager,
    fallbackRetryAfterMs: params.fallbackRetryAfterMs,
  });

export const createWithErrorLogging = (deps: WithErrorLoggingDeps) => {
  const {
    log,
    run,
    nonceManager,
    config,
    bodySnippetLength = DEFAULT_BODY_SNIPPET_LENGTH,
    metrics,
  } = deps;

  return <T>(
    action: string,
    fn: () => Promise<T>,
    errors?: PluginErrorConstructors,
    logMeta?: Record<string, unknown>
  ) => {
    let attempt = 0;

    const executeOnce = (): Effect.Effect<T, unknown> =>
      Effect.gen(function* () {
        attempt += 1;
        if (metrics && attempt > 1) {
          metrics.retryAttempts += 1;
        }
        const attemptResult = yield* Effect.tryPromise({
          try: fn,
          catch: (error) => error,
        }).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catchAll((error) => Effect.succeed({ ok: false as const, error }))
        );

        if (attemptResult.ok) {
          return attemptResult.value;
        }

        const underlyingError = unwrapError(attemptResult.error);

        yield* Effect.sync(() =>
          logFailure({
            log,
            action,
            error: underlyingError,
            logMeta,
            bodySnippetLength,
            attempt,
          })
        );

        return yield* Effect.fail(
          mapPluginErrorWithRetryAfter(underlyingError, {
            errors,
            nonceManager,
            fallbackRetryAfterMs: config.variables.nonceTtlMs,
          })
        );
      });

    return run(executeOnce()).catch(unwrapRunFailure);
  };
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

export type {
  DiscoursePluginConfig,
  NormalizedUserApiScopes,
  Secrets,
  Variables,
} from "./plugin-config";

export type { PluginErrorConstructors } from "./plugin-errors";

type RouterHelpers = {
  log: LogFn;
  run: RunEffect;
  withErrorLogging: ReturnType<typeof createWithErrorLogging>;
  makeHandler: MakeHandler;
  enforceRateLimit: (
    action: string,
    errors: PluginErrorConstructors,
    clientId?: string
  ) => void;
  resolveRateLimitKey: (input: unknown) => string | undefined;
  withCache: <T>(params: {
    action: string;
    key: string;
    fetch: () => Promise<T>;
  }) => Promise<T>;
  invalidateCache: (keys: string[]) => void;
  invalidateCacheByPrefix: (prefixes: string[]) => void;
  cacheStats: () => { size: number; hits: number; misses: number; evictions: number; ttlMs: number };
};

const createRouterHelpers = (context: PluginContext): RouterHelpers => {
  const {
    logger,
    bodySnippetLength,
    nonceManager,
    config,
    metrics,
    rateLimiter: providedRateLimiter,
    cache: providedCache,
  } = context;

  const rateLimiter = providedRateLimiter ?? {
    take: () => ({ allowed: true, retryAfterMs: 0 }),
  };

  const cache =
    providedCache ??
    ({
      get: () => undefined,
      set: () => {},
      delete: () => {},
      deleteByPrefix: () => 0,
      stats: () => ({ size: 0, hits: 0, misses: 0, evictions: 0, ttlMs: 0 }),
    } satisfies Cache);

  const log: LogFn = (level, message, meta) => {
    logger[level](message, normalizeMeta(meta));
  };

  const run: RunEffect = (eff) => Effect.runPromise(eff);

  const withErrorLogging = createWithErrorLogging({
    log,
    run,
    nonceManager,
    config,
    bodySnippetLength,
    metrics,
  });

  const enforceRateLimit = (
    action: string,
    errors: PluginErrorConstructors,
    clientId?: string
  ) => {
    const result = rateLimiter.take(action, clientId);
    if (result.allowed) {
      return;
    }

    const tooManyRequests = errors.TOO_MANY_REQUESTS ?? errors.RATE_LIMITED;
    if (!tooManyRequests) {
      throw new RouterConfigError("TOO_MANY_REQUESTS constructor missing for rate limiting");
    }

    log("warn", "Rate limit exceeded", {
      action,
      rateLimitKey: clientId,
      retryAfterMs: result.retryAfterMs,
    });

    throw tooManyRequests({
      message: "Rate limit exceeded",
      data: {
        retryAfter: Math.ceil(result.retryAfterMs / 1000),
        retryAfterMs: result.retryAfterMs,
        remainingRequests: 0,
        limitType: "requests" as const,
      },
    });
  };

  const makeHandler: MakeHandler =
    <I, O>(
      action: string,
      effect: (ctx: { input: I; errors: PluginErrorConstructors }) =>
        | Effect.Effect<O, any, never>
        | Promise<O>,
      logMeta?: (input: I) => Record<string, unknown>
    ) =>
    async ({ input, errors }: { input: I; errors: PluginErrorConstructors }) => {
      const rateLimitKey = resolveRateLimitKey(input);
      enforceRateLimit(action, errors, rateLimitKey);
      return withErrorLogging(
        action,
        () => {
          const result = effect({ input, errors });
          if (result && typeof (result as any).then === "function") {
            return result as Promise<O>;
          }
          return run(result as Effect.Effect<O, any, never>);
        },
        errors,
        logMeta ? logMeta(input) : undefined
      );
    };

  const withCache = async <T>(params: {
    action: string;
    key: string;
    fetch: () => Promise<T>;
  }) => {
    const cached = cache.get<T>(params.key);
    if (cached !== undefined) {
      log("debug", "Cache hit", { action: params.action, cacheKey: params.key });
      return cached;
    }

    const result = await params.fetch();
    cache.set(params.key, result);
    log("debug", "Cache filled", { action: params.action, cacheKey: params.key });
    return result;
  };

  const cacheStats = () => cache.stats();

  const invalidateCache = (keys: string[]) => {
    keys.forEach((key) => cache.delete(key));
  };

  const invalidateCacheByPrefix = (prefixes: string[]) => {
    const deleteByPrefix = cache.deleteByPrefix;
    if (!deleteByPrefix) return;
    prefixes.forEach((prefix) => deleteByPrefix(prefix));
  };

  const resolveRateLimitKey = (input: unknown): string | undefined => {
    if (!input || typeof input !== "object") return undefined;
    const maybeString = (value: unknown) =>
      typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    const candidate =
      maybeString((input as any).username) ?? maybeString((input as any).clientId);
    return candidate;
  };

  return {
    log,
    run,
    withErrorLogging,
    makeHandler,
    enforceRateLimit,
    withCache,
    invalidateCache,
    invalidateCacheByPrefix,
    resolveRateLimitKey,
    cacheStats,
  };
};

// Expose for testing without expanding the public surface area.
export const __internalCreateRouterHelpers = createRouterHelpers;
export const __internalCreateCache = createCache;
export const __internalCreateRateLimiter = createRateLimiter;

const assembleRouters = (
  builder: Implementer<typeof contract, PluginContext, PluginContext>,
  context: PluginContext,
  helpers: RouterHelpers
) => {
  const routers = buildAllRouters({ builder, context, helpers });
  return registerHandlers(...routers);
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
    withErrorLogging,
    enforceRateLimit,
    withCache,
    cacheStats,
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
