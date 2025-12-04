import { Effect } from "every-plugin/effect";
import { createHash } from "crypto";
import { DEFAULT_BODY_SNIPPET_LENGTH } from "./constants";
import type { DiscoursePluginConfig } from "./plugin-config";
import { mapPluginError, sanitizeErrorForLog, type PluginErrorConstructors } from "./plugin-errors";
import type { NonceManager, SafeLogger } from "./service";
import { normalizeMeta, unwrapError } from "./utils";
import type { Cache } from "./cache";
import type { RateLimiter } from "./rate-limit";

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

export type WrapRoute = <I, O>(params: {
  action: string;
  handler: (
    ctx: { input: I; errors: PluginErrorConstructors }
  ) => Promise<O> | Effect.Effect<O, any, never>;
  cacheKey?: string | ((input: I) => string | undefined);
  rateLimitKey?: (input: I) => string | undefined;
  logMeta?: (input: I) => Record<string, unknown>;
}) => (args: { input: I; errors: PluginErrorConstructors }) => Promise<O>;

export type WithErrorLoggingDeps = {
  log: LogFn;
  run: RunEffect;
  nonceManager: NonceManager;
  config: DiscoursePluginConfig;
  bodySnippetLength?: number;
  metrics?: { retryAttempts: number };
};

type RouterHelperContext = {
  logger: SafeLogger;
  bodySnippetLength: number;
  nonceManager: NonceManager;
  config: DiscoursePluginConfig;
  metrics: { retryAttempts: number; nonceEvictions: number };
  rateLimiter?: RateLimiter;
  cache?: Cache;
};

type RouterHelpers = {
  log: LogFn;
  run: RunEffect;
  withErrorLogging: ReturnType<typeof createWithErrorLogging>;
  makeHandler: MakeHandler;
  wrapRoute: WrapRoute;
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

export const createRouterHelpers = (context: RouterHelperContext): RouterHelpers => {
  const { logger, bodySnippetLength, nonceManager, config, metrics, rateLimiter, cache } = context;

  const resolvedRateLimiter = rateLimiter ?? {
    take: () => ({ allowed: true, retryAfterMs: 0 }),
  };

  const resolvedCache =
    cache ??
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

  const resolveAsync = <T>(
    value: Promise<T> | Effect.Effect<T, any, never> | T
  ): Promise<T> => {
    if (value && typeof (value as any).then === "function") {
      return value as Promise<T>;
    }
    if (value && typeof value === "object") {
      return run(value as Effect.Effect<T, any, never>);
    }
    return Promise.resolve(value as T);
  };

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
    const result = resolvedRateLimiter.take(action, clientId);
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

  const withCache = async <T>(params: {
    action: string;
    key: string;
    fetch: () => Promise<T>;
  }) => {
    const cached = resolvedCache.get<T>(params.key);
    if (cached !== undefined) {
      log("debug", "Cache hit", { action: params.action, cacheKey: params.key });
      return cached;
    }

    const result = await params.fetch();
    resolvedCache.set(params.key, result);
    log("debug", "Cache filled", { action: params.action, cacheKey: params.key });
    return result;
  };

  const cacheStats = () => resolvedCache.stats();

  const invalidateCache = (keys: string[]) => {
    keys.forEach((key) => resolvedCache.delete(key));
  };

  const invalidateCacheByPrefix = (prefixes: string[]) => {
    const deleteByPrefix = resolvedCache.deleteByPrefix;
    if (!deleteByPrefix) return;
    prefixes.forEach((prefix) => deleteByPrefix(prefix));
  };

  const hashKey = (value: string) =>
    createHash("sha256").update(value).digest("hex");

  const resolveRateLimitKey = (input: unknown): string | undefined => {
    if (!input || typeof input !== "object") return undefined;
    const maybeString = (value: unknown) =>
      typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

    const clientId = maybeString((input as any).clientId);
    if (clientId) return clientId;

    const userApiKey = maybeString((input as any).userApiKey);
    if (userApiKey) {
      return `userApiKey:${hashKey(userApiKey)}`;
    }

    const username = maybeString((input as any).username);
    if (username) return username;

    return undefined;
  };

  const wrapRoute: WrapRoute =
    <I, O>({
      action,
      handler,
      cacheKey,
      rateLimitKey,
      logMeta,
    }: {
      action: string;
      handler: (
        ctx: { input: I; errors: PluginErrorConstructors }
      ) => Promise<O> | Effect.Effect<O, any, never>;
      cacheKey?: string | ((input: I) => string | undefined);
      rateLimitKey?: (input: I) => string | undefined;
      logMeta?: (input: I) => Record<string, unknown>;
    }) =>
    async ({ input, errors }: { input: I; errors: PluginErrorConstructors }) => {
      const resolvedRateLimitKey = rateLimitKey?.(input) ?? resolveRateLimitKey(input);
      enforceRateLimit(action, errors, resolvedRateLimitKey);

      const execute = async () => {
        const runHandler = () => resolveAsync(handler({ input, errors }));
        const resolvedCacheKey = typeof cacheKey === "function" ? cacheKey(input) : cacheKey;
        if (!resolvedCacheKey) {
          return runHandler();
        }
        return withCache({
          action,
          key: resolvedCacheKey,
          fetch: runHandler,
        });
      };

      return withErrorLogging(action, execute, errors, logMeta ? logMeta(input) : undefined);
    };

  const makeHandler: MakeHandler =
    <I, O>(
      action: string,
      effect: (ctx: { input: I; errors: PluginErrorConstructors }) =>
        | Effect.Effect<O, any, never>
        | Promise<O>,
      logMeta?: (input: I) => Record<string, unknown>
    ) =>
    wrapRoute({
      action,
      handler: effect,
      logMeta,
    });

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
    wrapRoute,
    cacheStats,
  };
};

// Expose for tests without expanding the public surface area.
export type { RouterHelpers };
