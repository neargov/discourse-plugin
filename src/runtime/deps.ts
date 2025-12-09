import { Effect, Fiber } from "every-plugin/effect";
import {
  CryptoService,
  DiscourseService,
  NonceManager,
  type SafeLogger,
} from "../service";
import type { DiscoursePluginConfig } from "../plugin-config";
import { effectHelpers } from "../utils";

export const interruptCleanupFiber = (
  fiber: Fiber.RuntimeFiber<never, never>
) =>
  effectHelpers.interrupt(fiber).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void)
  );

export const createDiscourseDeps = (
  config: DiscoursePluginConfig,
  logger: SafeLogger,
  metrics: { retryAttempts: number; nonceEvictions: number }
) => {
  const bodySnippetLength = config.variables.logBodySnippetLength;

  const discourseService = new DiscourseService(
    config.variables.discourseBaseUrl,
    config.secrets.discourseApiKey,
    config.variables.discourseApiUsername,
    logger,
    {
      defaultTimeoutMs: config.variables.requestTimeoutMs,
      userAgent: config.variables.userAgent ?? "every-plugin-discourse",
      userApiClientId: config.variables.clientId,
      retryPolicy: {
        maxRetries: 1,
        maxDelayMs: config.variables.requestTimeoutMs,
      },
      operationRetryPolicy:
        config.operationRetryPolicy ?? config.variables.operationRetryPolicy,
      bodySnippetLength,
      requestLogger: (payload) => {
        /* c8 ignore start */
        if (payload.outcome === "retry") {
          metrics.retryAttempts += 1;
        }
        config.requestLogger?.(payload);
        /* c8 ignore end */
      },
      fetchImpl: config.fetch,
    }
  );

  const cryptoService = new CryptoService();
  const nonceManager = new NonceManager({
    ttlMs: config.variables.nonceTtlMs,
    maxPerClient: config.variables.nonceMaxPerClient,
    maxTotal: config.variables.nonceMaxTotal,
    limitStrategy: config.variables.nonceLimitStrategy,
    onEvict: (event) => {
      metrics.nonceEvictions += event.count;
      logger.warn("Nonce eviction occurred", {
        action: "nonce-eviction",
        type: event.type,
        clientId: event.clientId,
        count: event.count,
        nonceEvictions: metrics.nonceEvictions,
      });
    },
  });

  return { discourseService, cryptoService, nonceManager, bodySnippetLength };
};

export const startNonceCleanup = (
  nonceManager: NonceManager,
  cleanupIntervalMs: number,
  logger: SafeLogger
) =>
  Effect.gen(function* () {
    nonceManager.cleanup();
    const cleanupFiber = yield* Effect.forkScoped(
      Effect.forever(
        Effect.zipRight(
          Effect.sleep(cleanupIntervalMs),
          Effect.sync(() => nonceManager.cleanup())
        )
      )
    );
    yield* Effect.addFinalizer(() => interruptCleanupFiber(cleanupFiber));
    logger.debug("Nonce cleanup loop started", {
      action: "nonce-cleanup-start",
      intervalMs: cleanupIntervalMs,
    });
    return cleanupFiber;
  });
