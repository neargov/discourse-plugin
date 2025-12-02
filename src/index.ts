import { createPlugin } from "every-plugin";
import type { Implementer } from "@orpc/server";
import { Effect } from "every-plugin/effect";
import { z } from "every-plugin/zod";
import * as Fiber from "effect/Fiber";
import { contract } from "./contract";
import {
  DiscourseService,
  CryptoService,
  NEARService,
  NonceManager,
  LinkageStore,
  DiscourseApiError,
  NonceCapacityError,
  type Logger,
  type SafeLogger,
  noopLogger,
  createSafeLogger,
} from "./service";
import { effectHelpers, formatError, normalizeMeta, serializeError, unwrapError } from "./utils";
import type { RuntimeFiber } from "effect/Fiber";

const VariablesSchema = z.object({
  discourseBaseUrl: z.string().url(),
  discourseApiUsername: z.string().default("system"),
  clientId: z.string().default("discourse-near-plugin"),
  recipient: z.string().default("social.near"),
  requestTimeoutMs: z.number().int().positive().default(30000),
  nonceTtlMs: z.number().int().positive().default(10 * 60 * 1000),
  nonceCleanupIntervalMs: z.number().int().positive().default(5 * 60 * 1000),
  signatureTtlMs: z.number().int().positive().default(300000),
  userAgent: z.string().min(1).optional(),
});

const SecretsSchema = z.object({
  discourseApiKey: z.string().min(1, "Discourse System API key is required"),
});

type Variables = z.infer<typeof VariablesSchema>;
type Secrets = z.infer<typeof SecretsSchema>;

export type DiscoursePluginConfig = {
  variables: Variables;
  secrets: Secrets;
  logger?: Logger;
};

type PluginContext = {
  discourseService: DiscourseService;
  cryptoService: CryptoService;
  nearService: NEARService;
  nonceManager: NonceManager;
  linkageStore: LinkageStore;
  config: DiscoursePluginConfig;
  logger: SafeLogger;
  cleanupFiber: RuntimeFiber<never, never>;
};

const interruptCleanupFiber = (fiber: RuntimeFiber<never, never>) =>
  effectHelpers.interrupt(fiber).pipe(Effect.asVoid, Effect.catchAll(() => Effect.void));

export const mapDiscourseApiError = (error: unknown, errors?: any) => {
  if (!(error instanceof DiscourseApiError) || !errors) {
    return error;
  }

  const payload = (message: string = error.message) => ({
    message,
    data: {
      status: error.status,
      path: error.path,
      method: error.method,
      retryAfterMs: error.retryAfterMs,
      requestId: error.requestId,
    },
  });

  const make = (
    fn: ((payload: { message: string; data: Record<string, unknown> }) => unknown) | undefined,
    message?: string
  ) => {
    if (typeof fn !== "function") return error;
    const mapped = fn(payload(message));
    return mapped ?? error;
  };

  if (error.status === 401) {
    return make(errors.UNAUTHORIZED);
  }

  if (error.status === 403) {
    return make(errors.FORBIDDEN);
  }

  if (error.status === 404) {
    return make(errors.NOT_FOUND);
  }

  if (error.status === 400 || error.status === 422) {
    return make(errors.BAD_REQUEST);
  }

  if (error.status === 429) {
    return make(errors.TOO_MANY_REQUESTS);
  }

  if (error.status >= 500 || error.status === 503) {
    return make(errors.SERVICE_UNAVAILABLE);
  }

  return error;
};

export const mapPluginError = (
  error: unknown,
  params: {
    errors?: any;
    nonceManager?: NonceManager;
    fallbackRetryAfterMs?: number;
  }
) => {
  const { errors, nonceManager, fallbackRetryAfterMs } = params;

  if (error instanceof NonceCapacityError && errors?.TOO_MANY_REQUESTS) {
    const retryAfterMs =
      nonceManager?.getRetryAfterMs(error.clientId) ??
      nonceManager?.getRetryAfterMs() ??
      fallbackRetryAfterMs;

    const mapped = errors.TOO_MANY_REQUESTS({
      message: error.message,
      data: {
        limitType: error.limitType,
        limit: error.limit,
        clientId: error.clientId,
        retryAfterMs,
      },
    });

    return mapped ?? error;
  }

  return mapDiscourseApiError(error, errors);
};

export const sanitizeErrorForLog = (
  error: unknown
): {
  message: string;
  name?: string;
  status?: number;
  path?: string;
  method?: string;
  retryAfterMs?: number;
  requestId?: string;
  bodySnippet?: string;
} => {
  const serialized = serializeError(error);
  const name =
    error && typeof (error as any).name === "string" ? (error as any).name : undefined;

  const payload = typeof serialized === "string"
    ? { message: serialized, name }
    : { message: serialized.message, name };

  if (!(error instanceof DiscourseApiError)) {
    return payload;
  }

  return {
    ...payload,
    status: error.status,
    path: error.path,
    method: error.method,
    retryAfterMs: error.retryAfterMs,
    requestId: error.requestId,
    bodySnippet: error.bodySnippet,
  };
};

type WithErrorLoggingDeps = {
  log: (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void;
  run: <A, E>(eff: Effect.Effect<A, E, never>) => Promise<A>;
  nonceManager: NonceManager;
  config: DiscoursePluginConfig;
};

export const createWithErrorLogging = (deps: WithErrorLoggingDeps) => {
  const { log, run, nonceManager, config } = deps;

  return <T>(
    action: string,
    fn: () => Promise<T>,
    errors?: any,
    attempt: number = 0
  ) => {
    const runWithRetry = (currentAttempt: number): Effect.Effect<T, unknown> =>
      Effect.tryPromise({
        try: fn,
        catch: (error) => error,
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            const underlyingError = unwrapError(error);
            const isDiscourseError = underlyingError instanceof DiscourseApiError;
            const retryDelayMs =
              isDiscourseError &&
              typeof underlyingError.retryAfterMs === "number" &&
              underlyingError.retryAfterMs > 0 &&
              (underlyingError.status === 429 || underlyingError.status >= 500)
                ? Math.max(
                    0,
                    Math.min(underlyingError.retryAfterMs, config.variables.requestTimeoutMs)
                  )
                : null;

            if (retryDelayMs && currentAttempt === 0 && isDiscourseError) {
              yield* Effect.sync(() =>
                log("warn", "Discourse request retrying after retry-after", {
                  action,
                  retryAfterMs: retryDelayMs,
                  status: underlyingError.status,
                  path: underlyingError.path,
                })
              );
              yield* effectHelpers.sleep(retryDelayMs);
              return yield* runWithRetry(currentAttempt + 1);
            }

            yield* Effect.sync(() =>
              log("error", `${action} failed`, {
                action,
                error: sanitizeErrorForLog(underlyingError),
              })
            );

            return yield* Effect.fail(
              mapPluginError(underlyingError, {
                errors,
                nonceManager,
                fallbackRetryAfterMs: config.variables.nonceTtlMs,
              })
            );
          })
        )
      );

    return run(runWithRetry(attempt)).catch((error) => {
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
    });
  };
};

/**
 * Discourse Plugin
 *
 * Enables NEAR account holders to connect and interact with forums
 *
 * Shows how to:
 * - Link NEAR accounts to Discourse usernames
 * - Verify on-chain message signatures (NEP-413)
 * - Create posts on behalf of users via API calls
 * - Manage RSA encryption for secure key exchange
 */

export default createPlugin({
  variables: VariablesSchema,

  secrets: SecretsSchema,

  contract,

  initialize: (config: DiscoursePluginConfig) =>
    Effect.gen(function* () {
      const logger = createSafeLogger(config.logger ?? noopLogger);

      // Create service instances with config
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
        }
      );

      const cryptoService = new CryptoService();
      const nearService = new NEARService(config.variables.recipient);
      const nonceManager = new NonceManager(config.variables.nonceTtlMs);
      const linkageStore = new LinkageStore();
      const cleanupIntervalMs = config.variables.nonceCleanupIntervalMs;

      // Start background cleanup task for expired nonces (initial run + scheduled)
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

      return {
        discourseService,
        cryptoService,
        nearService,
        nonceManager,
        linkageStore,
        config,
        logger,
        cleanupFiber,
      };
    }),

  shutdown: (context: PluginContext) => interruptCleanupFiber(context.cleanupFiber),

  createRouter: (
    context: PluginContext,
    builder: Implementer<typeof contract, PluginContext, PluginContext>
  ) => {
    const {
      discourseService,
      cryptoService,
      nearService,
      nonceManager,
      linkageStore,
      config,
      logger,
    } = context;

    const log = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      meta?: Record<string, unknown>
    ) => {
      logger[level](message, normalizeMeta(meta));
    };

    const run = <A, E>(eff: Effect.Effect<A, E, never>) => Effect.runPromise(eff);

    const withErrorLogging = createWithErrorLogging({
      log,
      run,
      nonceManager,
      config,
    });

    const getActiveNonceOrThrow = (nonce: string, errors: any) => {
      const nonceData = nonceManager.get(nonce);
      if (!nonceData) {
        throw errors.BAD_REQUEST({
          message: "Invalid or expired nonce",
          data: {},
        });
      }
      if (!nonceManager.verify(nonce, nonceData.clientId)) {
        throw errors.BAD_REQUEST({
          message: "Invalid or expired nonce",
          data: {},
        });
      }
      return nonceData;
    };

    const verifyNearSignature = async (
      authToken: string,
      errors: any,
      action: string
    ) => {
      try {
        return await run(
          nearService.verifySignature(authToken, config.variables.signatureTtlMs)
        );
      } catch (error) {
        log("warn", "NEAR signature verification failed", {
          action,
          error: sanitizeErrorForLog(error),
        });
        throw errors.UNAUTHORIZED({
          message: "NEAR signature verification failed",
          data: {
            action,
            reason: formatError(error),
          },
        });
      }
    };

    const requireLinkedAccount = async (
      authToken: string,
      action: string,
      errors: any,
      onMissing?: (nearAccount: string) => never
    ) => {
      const nearAccount = await verifyNearSignature(authToken, errors, action);
      const linkage = linkageStore.get(nearAccount);

      if (!linkage) {
        if (onMissing) {
          return onMissing(nearAccount);
        }

        log("warn", "Missing linked Discourse account", {
          action,
          nearAccount,
        });
        throw errors.FORBIDDEN({
          message: "No linked Discourse account. Please link your account first.",
          data: {
            requiredPermissions: ["linked-account"],
            action,
          },
        });
      }

      return { nearAccount, linkage: linkage as NonNullable<typeof linkage> };
    };

    return {
      getUserApiAuthUrl: builder.getUserApiAuthUrl.handler(
        async ({ input, errors }) =>
          withErrorLogging("get-user-api-auth-url", async () => {
            const { publicKey, privateKey } = await run(
              cryptoService.generateKeyPair()
            );

            const nonce = nonceManager.create(input.clientId, privateKey);

            const authUrl = await run(
              discourseService.generateAuthUrl({
                clientId: input.clientId,
                applicationName: input.applicationName,
                nonce,
                publicKey,
              })
            );

            const expiresAt = nonceManager.getExpiration(nonce);
            if (!expiresAt) {
              throw new Error("Failed to compute nonce expiration");
            }

            log("info", "Generated Discourse auth URL", {
              action: "get-user-api-auth-url",
              clientId: input.clientId,
              applicationName: input.applicationName,
              expiresAt,
            });

            return { authUrl, nonce, expiresAt: new Date(expiresAt).toISOString() };
          }, errors)
      ),

      completeLink: builder.completeLink.handler(async ({ input, errors }) => {
        return withErrorLogging(
          "complete-link",
          async () => {
            const nonceData = getActiveNonceOrThrow(input.nonce, errors);

            try {
              let userApiKey: string;
              try {
                userApiKey = await run(
                  cryptoService.decryptPayload(input.payload, nonceData.privateKey)
                );
              } catch (error) {
                log("warn", "Failed to decrypt Discourse payload", {
                  action: "complete-link",
                  error: sanitizeErrorForLog(error),
                });
                throw errors.BAD_REQUEST({
                  message: "Invalid or expired payload",
                  data: {},
                });
              }

              const discourseUser = await run(discourseService.getCurrentUser(userApiKey));

              const nearAccount = await verifyNearSignature(
                input.authToken,
                errors,
                "complete-link"
              );

              linkageStore.set(nearAccount, {
                nearAccount,
                discourseUsername: discourseUser.username,
                discourseUserId: discourseUser.id,
                userApiKey,
                verifiedAt: new Date().toISOString(),
              });

              log("info", "Completed account linkage", {
                action: "complete-link",
                nearAccount,
                discourseUser: discourseUser.username,
              });

              return {
                success: true,
                nearAccount,
                discourseUsername: discourseUser.username,
                message: `Successfully linked ${nearAccount} to ${discourseUser.username}`,
              };
            } finally {
              nonceManager.consume(input.nonce);
            }
          },
          errors
        );
      }),

      createPost: builder.createPost.handler(async ({ input, errors }) =>
        withErrorLogging("create-post", async () => {
          const { linkage } = await requireLinkedAccount(
            input.authToken,
            "create-post",
            errors
          );

          const postData = await run(
            discourseService.createPost({
              title: input.title,
              raw: input.raw,
              category: input.category,
              username: linkage.discourseUsername,
              topicId: input.topicId,
              replyToPostNumber: input.replyToPostNumber,
            })
          );

          if (
            typeof postData.topic_id !== "number" ||
            typeof postData.topic_slug !== "string" ||
            typeof postData.id !== "number"
          ) {
            throw errors.SERVICE_UNAVAILABLE({
              message: "Discourse response missing topic_slug/topic_id",
              data: {
                topicId: postData.topic_id,
                topicSlug: postData.topic_slug,
              },
            });
          }

          log("info", "Created Discourse post", {
            action: "create-post",
            nearAccount: linkage.nearAccount,
            discourseUsername: linkage.discourseUsername,
            topicId: postData.topic_id,
            postId: postData.id,
          });

          return {
            success: true,
            postUrl: discourseService.resolvePath(
              `/t/${postData.topic_slug}/${postData.topic_id}`
            ),
            postId: postData.id,
            topicId: postData.topic_id,
          };
        }, errors)
      ),

      editPost: builder.editPost.handler(async ({ input, errors }) =>
        withErrorLogging("edit-post", async () => {
          const { linkage } = await requireLinkedAccount(
            input.authToken,
            "edit-post",
            errors
          );

          const postData = await run(
            discourseService.editPost({
              postId: input.postId,
              raw: input.raw,
              username: linkage.discourseUsername,
              editReason: input.editReason,
            })
          );

          if (
            typeof postData.topicId !== "number" ||
            typeof postData.topicSlug !== "string" ||
            typeof postData.id !== "number"
          ) {
            throw errors.SERVICE_UNAVAILABLE({
              message: "Discourse response missing topicSlug/topicId",
              data: {
                topicId: postData.topicId,
                topicSlug: postData.topicSlug,
              },
            });
          }

          const postUrl = discourseService.resolvePath(
            postData.postUrl || `/p/${postData.id}`
          );

          log("info", "Edited Discourse post", {
            action: "edit-post",
            nearAccount: linkage.nearAccount,
            discourseUsername: linkage.discourseUsername,
            postId: postData.id,
            topicId: postData.topicId,
          });

          return {
            success: true,
            postUrl,
            postId: postData.id,
            topicId: postData.topicId,
          };
        }, errors)
      ),

      getLinkage: builder.getLinkage.handler(async ({ input }) => {
        const linkage = linkageStore.get(input.nearAccount);

        if (!linkage) {
          return null;
        }

        log("debug", "Fetched linkage", {
          action: "get-linkage",
          nearAccount: input.nearAccount,
        });

        return {
          nearAccount: linkage.nearAccount,
          discourseUsername: linkage.discourseUsername,
          verifiedAt: linkage.verifiedAt,
        };
      }),

      unlinkAccount: builder.unlinkAccount.handler(async ({ input, errors }) =>
        withErrorLogging("unlink-account", async () => {
          const { nearAccount, linkage } = await requireLinkedAccount(
            input.authToken,
            "unlink-account",
            errors,
            (account) => {
              throw errors.NOT_FOUND({
                message: "No linked Discourse account found for this NEAR account",
                data: { nearAccount: account },
              });
            }
          );

          const removed = linkageStore.remove(nearAccount);

          if (!removed) {
            throw errors.SERVICE_UNAVAILABLE({
              message: "Failed to remove linkage",
              data: { retryAfter: 5 },
            });
          }

          log("info", "Unlinked account", {
            action: "unlink-account",
            nearAccount,
            discourseUsername: linkage.discourseUsername,
          });

          return {
            success: true,
            message: `Successfully unlinked ${nearAccount} from ${linkage.discourseUsername}`,
          };
        }, errors)
      ),

      validateLinkage: builder.validateLinkage.handler(async ({ input }) => {
        const linkage = linkageStore.get(input.nearAccount);

        if (!linkage) {
          return {
            valid: false,
            error: "No linkage found for this NEAR account",
          };
        }

        const validation = await run(discourseService.validateUserApiKey(linkage.userApiKey));

        if (!validation.valid) {
          const retryable = Boolean(validation.retryable);
          log("warn", "Linkage validation failed", {
            action: "validate-linkage",
            nearAccount: input.nearAccount,
            discourseUsername: linkage.discourseUsername,
            error: validation.error,
            retryable,
            removed: !retryable,
          });
          if (!retryable) {
            linkageStore.remove(input.nearAccount);
          }
          return {
            valid: false,
            discourseUsername: linkage.discourseUsername,
            error: validation.error,
          };
        }

        log("info", "Validated linkage", {
          action: "validate-linkage",
          nearAccount: input.nearAccount,
          discourseUsername: linkage.discourseUsername,
        });

        return {
          valid: true,
          discourseUsername: linkage.discourseUsername,
          discourseUser: validation.user,
        };
      }),

      search: builder.search.handler(async ({ input, errors }) =>
        withErrorLogging("search", async () => {
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
        }, errors)
      ),

      ping: builder.ping.handler(async () => {
        const timeoutMs = Math.min(config.variables.requestTimeoutMs, 2000);
        const discourseConnected = await discourseService.checkHealth({ timeoutMs });

        log(discourseConnected ? "debug" : "warn", "Ping Discourse", {
          action: "ping",
          discourseConnected,
          timeoutMs,
        });

        return {
          status: discourseConnected ? ("ok" as const) : ("degraded" as const),
          timestamp: new Date().toISOString(),
          discourseConnected,
        };
      }),

      getCategories: builder.getCategories.handler(async ({ errors }) =>
        withErrorLogging("get-categories", async () => {
          const categories = await run(
            discourseService.getCategories()
          );
          log("debug", "Fetched categories", { action: "get-categories" });
          return { categories };
        }, errors)
      ),

      getCategory: builder.getCategory.handler(async ({ input, errors }) =>
        withErrorLogging("get-category", async () => {
          const result = await run(
            discourseService.getCategory(input.idOrSlug)
          );
          log("debug", "Fetched category", {
            action: "get-category",
            idOrSlug: input.idOrSlug,
          });
          return result;
        }, errors)
      ),

      getTopic: builder.getTopic.handler(async ({ input, errors }) =>
        withErrorLogging("get-topic", async () => {
          const topic = await run(
            discourseService.getTopic(input.topicId)
          );
          log("debug", "Fetched topic", { action: "get-topic", topicId: input.topicId });
          return { topic };
        }, errors)
      ),

      getLatestTopics: builder.getLatestTopics.handler(async ({ input, errors }) =>
        withErrorLogging("get-latest-topics", async () => {
          const result = await run(
            discourseService.getLatestTopics({
              categoryId: input.categoryId,
              page: input.page,
              order: input.order,
            })
          );
          log("debug", "Fetched latest topics", {
            action: "get-latest-topics",
            categoryId: input.categoryId,
            page: input.page,
            order: input.order,
          });
          return result;
        }, errors)
      ),

      getTopTopics: builder.getTopTopics.handler(async ({ input, errors }) =>
        withErrorLogging("get-top-topics", async () => {
          const result = await run(
            discourseService.getTopTopics({
              period: input.period,
              categoryId: input.categoryId,
              page: input.page,
            })
          );
          log("debug", "Fetched top topics", {
            action: "get-top-topics",
            categoryId: input.categoryId,
            page: input.page,
            period: input.period,
          });
          return result;
        }, errors)
      ),

      getPost: builder.getPost.handler(async ({ input, errors }) =>
        withErrorLogging("get-post", async () => {
          const result = await run(
            discourseService.getPost(input.postId, input.includeRaw)
          );
          log("debug", "Fetched post", {
            action: "get-post",
            postId: input.postId,
            includeRaw: input.includeRaw,
          });
          return result;
        }, errors)
      ),

      getPostReplies: builder.getPostReplies.handler(async ({ input, errors }) =>
        withErrorLogging("get-post-replies", async () => {
          const replies = await run(
            discourseService.getPostReplies(input.postId)
          );
          log("debug", "Fetched post replies", { action: "get-post-replies", postId: input.postId });
          return { replies };
        }, errors)
      ),

      getUser: builder.getUser.handler(async ({ input, errors }) =>
        withErrorLogging("get-user", async () => {
          const user = await run(
            discourseService.getUser(input.username)
          );
          log("debug", "Fetched user", { action: "get-user", username: input.username });
          return { user };
        }, errors)
      ),
    };
  },
});
