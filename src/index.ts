import { createPlugin } from "every-plugin";
import type { Implementer } from "@orpc/server";
import { Effect } from "every-plugin/effect";
import { z } from "every-plugin/zod";
import * as Fiber from "effect/Fiber";
import { contract } from "./contract";
import {
  DiscourseService,
  CryptoService,
  NonceManager,
  DiscourseApiError,
  NonceCapacityError,
  type Logger,
  type SafeLogger,
  type OperationRetryPolicy,
  type RequestLogger,
  noopLogger,
  createSafeLogger,
} from "./service";
import {
  effectHelpers,
  normalizeMeta,
  serializeError,
  unwrapError,
} from "./utils";
import type { RuntimeFiber } from "effect/Fiber";
import { DEFAULT_BODY_SNIPPET_LENGTH, TRANSIENT_STATUSES } from "./constants";

const RetryPolicySchema = z.object({
  maxRetries: z.number().int().nonnegative().optional(),
  baseDelayMs: z.number().int().nonnegative().optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
  jitterRatio: z.number().nonnegative().optional(),
});

export type NormalizedUserApiScopes = {
  joined: string;
  scopes: string[];
};

export const RawUserApiScopesSchema = z
  .preprocess((value) => {
    const toStrings = (list: unknown[]) =>
      list.filter((entry): entry is string => typeof entry === "string");

    if (Array.isArray(value)) return toStrings(value);
    if (typeof value === "string") return toStrings(value.split(","));
    if (value && typeof value === "object" && Array.isArray((value as any).scopes)) {
      return toStrings((value as any).scopes);
    }
    return value;
  }, z.array(z.string()))
  .superRefine((scopeList, ctx) => {
    const trimmed = scopeList.map((scope) => scope.trim());

    if (trimmed.some((scope) => scope.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "User API scopes cannot be blank",
      });
    }

    const invalid = trimmed.find(
      (scope) => scope && !/^[a-z0-9_-]+$/.test(scope.toLowerCase())
    );
    if (invalid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid user API scope "${invalid}". Use lowercase letters, numbers, hyphens, or underscores.`,
      });
    }

    if (!trimmed.some(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one user API scope is required",
      });
    }
  });

const UserApiScopesSchema = RawUserApiScopesSchema.transform((scopeList) => {
  const normalized = Array.from(
    new Set(scopeList.map((scope) => scope.trim().toLowerCase()).filter(Boolean))
  ).sort();
  return { joined: normalized.join(","), scopes: normalized };
}).default({ joined: "read,write", scopes: ["read", "write"] });

const VariablesSchema = z.object({
  discourseBaseUrl: z.string().url(),
  discourseApiUsername: z.string().default("system"),
  clientId: z.string().default("discourse-plugin"),
  requestTimeoutMs: z.number().int().positive().default(30000),
  nonceTtlMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
  nonceCleanupIntervalMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  nonceMaxPerClient: z.number().int().nonnegative().optional(),
  nonceMaxTotal: z.number().int().nonnegative().optional(),
  nonceLimitStrategy: z
    .object({
      perClient: z.enum(["rejectNew", "evictOldest"]).optional(),
      global: z.enum(["rejectNew", "evictOldest"]).optional(),
    })
    .optional(),
  userApiScopes: UserApiScopesSchema,
  userAgent: z.string().min(1).optional(),
  logBodySnippetLength: z.number().int().nonnegative().default(500),
  operationRetryPolicy: z
    .object({
      default: RetryPolicySchema.optional(),
      reads: RetryPolicySchema.optional(),
      writes: RetryPolicySchema.optional(),
    })
    .optional(),
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
  requestLogger?: RequestLogger;
  fetch?: typeof fetch;
  operationRetryPolicy?: OperationRetryPolicy;
};

type PluginContext = {
  discourseService: DiscourseService;
  cryptoService: CryptoService;
  nonceManager: NonceManager;
  config: DiscoursePluginConfig;
  logger: SafeLogger;
  normalizedUserApiScopes: NormalizedUserApiScopes;
  cleanupFiber: RuntimeFiber<never, never>;
  bodySnippetLength: number;
  metrics: {
    retryAttempts: number;
    nonceEvictions: number;
  };
};

type PluginErrorConstructor = (payload: {
  message: string;
  data: Record<string, unknown>;
}) => unknown;

type PluginErrorConstructors = Partial<
  Record<
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "BAD_REQUEST"
    | "TOO_MANY_REQUESTS"
    | "SERVICE_UNAVAILABLE",
    PluginErrorConstructor
  >
>;

export class RouterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterConfigError";
  }
}

const interruptCleanupFiber = (fiber: RuntimeFiber<never, never>) =>
  effectHelpers.interrupt(fiber).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void)
  );

const isDiscourseApiError = (value: unknown): value is DiscourseApiError =>
  value instanceof DiscourseApiError;

export const mapDiscourseApiError = (
  error: unknown,
  errors?: PluginErrorConstructors
) => {
  if (!isDiscourseApiError(error) || !errors) {
    return error;
  }

  const status = error.status;

  const payload = (message: string = error.message) => ({
    message,
    data: {
      status,
      path: error.path,
      method: error.method,
      retryAfterMs: error.retryAfterMs,
      requestId: error.requestId,
    },
  });

  const make = (
    fn:
      | ((payload: {
          message: string;
          data: Record<string, unknown>;
        }) => unknown)
      | undefined,
    message?: string
  ) => {
    if (typeof fn !== "function") return error;
    const mapped = fn(payload(message));
    return mapped ?? error;
  };

  if (status === 401) {
    return make(errors.UNAUTHORIZED);
  }

  if (status === 403) {
    return make(errors.FORBIDDEN);
  }

  if (status === 404) {
    return make(errors.NOT_FOUND);
  }

  if (status === 400 || status === 422) {
    return make(errors.BAD_REQUEST);
  }

  if (TRANSIENT_STATUSES.has(status)) {
    return make(errors.TOO_MANY_REQUESTS);
  }

  if (status >= 500) {
    return make(errors.SERVICE_UNAVAILABLE);
  }

  return error;
};

export const mapPluginError = (
  error: unknown,
  params: {
    errors?: PluginErrorConstructors;
    nonceManager?: NonceManager;
    fallbackRetryAfterMs?: number;
  }
) => {
  const { errors, nonceManager, fallbackRetryAfterMs } = params;

  const tooManyRequests = errors?.TOO_MANY_REQUESTS;
  if (error instanceof NonceCapacityError && tooManyRequests) {
    const retryAfterMs =
      nonceManager?.getRetryAfterMs(error.clientId) ??
      nonceManager?.getRetryAfterMs() ??
      fallbackRetryAfterMs;

    const mapped = tooManyRequests({
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

const formatCause = (cause: unknown): string | undefined => {
  if (!cause) return undefined;
  const serialized = serializeError(cause);
  return typeof serialized === "string" ? serialized : serialized.message;
};

export const sanitizeErrorForLog = (
  error: unknown,
  maxBodySnippetLength: number = DEFAULT_BODY_SNIPPET_LENGTH
): {
  message: string;
  name?: string;
  status?: number;
  path?: string;
  method?: string;
  retryAfterMs?: number;
  requestId?: string;
  bodySnippet?: string;
  cause?: string;
  context?: string;
} => {
  const serialized = serializeError(error);
  const name =
    error && typeof (error as any).name === "string"
      ? (error as any).name
      : undefined;

  const payload =
    typeof serialized === "string"
      ? { message: serialized, name }
      : { message: serialized.message, name };

  if (!isDiscourseApiError(error)) {
    const cause = formatCause((error as any)?.cause);
    return cause ? { ...payload, cause } : payload;
  }

  const resolvedSnippet =
    typeof error.bodySnippet === "string"
      ? error.bodySnippet.slice(
          0,
          Math.min(maxBodySnippetLength, error.bodySnippetMaxLength)
        )
      : undefined;

  return {
    ...payload,
      status: error.status,
      path: error.path,
      method: error.method,
      retryAfterMs: error.retryAfterMs,
      requestId: error.requestId,
      bodySnippet: resolvedSnippet,
      cause: formatCause((error as any)?.cause),
      context: error.context,
  };
};

const normalizeUserApiScopes = (
  scopes: string[] | string | NormalizedUserApiScopes
): NormalizedUserApiScopes => UserApiScopesSchema.parse(scopes);

type WithErrorLoggingDeps = {
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    meta?: Record<string, unknown>
  ) => void;
  run: <A, E>(eff: Effect.Effect<A, E, never>) => Promise<A>;
  nonceManager: NonceManager;
  config: DiscoursePluginConfig;
  retryPolicy?: {
    maxAttempts?: number;
    retryOnTransportError?: boolean;
    minDelayMs?: number;
  };
  bodySnippetLength?: number;
  metrics?: {
    recordRetryAttempt?: (meta: {
      action: string;
      attempt: number;
      delayMs: number;
      status?: number;
    }) => void;
  };
};

export const createWithErrorLogging = (deps: WithErrorLoggingDeps) => {
  const {
    log,
    run,
    nonceManager,
    config,
    retryPolicy,
    bodySnippetLength = DEFAULT_BODY_SNIPPET_LENGTH,
    metrics,
  } = deps;
  const resolvedPolicy = {
    maxAttempts: Math.max(1, retryPolicy?.maxAttempts ?? 2),
    retryOnTransportError: retryPolicy?.retryOnTransportError ?? false,
    minDelayMs: Math.max(0, retryPolicy?.minDelayMs ?? 0),
  };

  return <T>(
    action: string,
    fn: () => Promise<T>,
    errors?: PluginErrorConstructors,
    attempt: number = 0,
    logMeta?: Record<string, unknown>
  ) => {
    const runWithRetry = (): Effect.Effect<T, unknown> =>
      Effect.gen(function* () {
        let currentAttempt = attempt;

        while (true) {
          const attemptResult = yield* Effect.tryPromise({
            try: fn,
            catch: (error) => error,
          }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catchAll((error) =>
              Effect.succeed({ ok: false as const, error })
            )
          );

          if (attemptResult.ok) {
            return attemptResult.value;
          }

          const underlyingError = unwrapError(attemptResult.error);
          const discourseError = isDiscourseApiError(underlyingError)
            ? underlyingError
            : null;
          const nextAttempt = currentAttempt + 1;
          const hasRetryAfter =
            discourseError &&
            typeof discourseError.retryAfterMs === "number" &&
            discourseError.retryAfterMs > 0;
          const isRetryableStatus =
            discourseError &&
            (TRANSIENT_STATUSES.has(discourseError.status) ||
              discourseError.status >= 500);
          const retryDelayMs =
            hasRetryAfter && isRetryableStatus
              ? Math.max(
                  0,
                  Math.min(
                    discourseError.retryAfterMs,
                    config.variables.requestTimeoutMs
                  )
                )
              : null;
          const canRetryTransport =
            !discourseError && resolvedPolicy.retryOnTransportError;
          const canRetryStatus = discourseError && isRetryableStatus && retryDelayMs === null;
          const canRetry =
            nextAttempt < resolvedPolicy.maxAttempts &&
            (retryDelayMs !== null || canRetryStatus || canRetryTransport);
          const delayMs =
            retryDelayMs ??
            (canRetryStatus || canRetryTransport ? resolvedPolicy.minDelayMs : null);

          if (canRetry && delayMs !== null) {
            metrics?.recordRetryAttempt?.({
              action,
              attempt: nextAttempt,
              delayMs,
              status: discourseError?.status,
            });
            yield* Effect.sync(() =>
              log(
                "warn",
                discourseError
                  ? "Discourse request retrying after retry-after"
                  : "Discourse request retrying after transport error",
                {
                  action,
                  ...logMeta,
                  retryAfterMs: delayMs,
                  status: discourseError?.status,
                  path: discourseError?.path,
                  attempt: nextAttempt,
                  transportRetry: !discourseError,
                }
              )
            );
            yield* effectHelpers.sleep(delayMs);
            currentAttempt = nextAttempt;
            continue;
          }

          yield* Effect.sync(() =>
            log("error", `${action} failed`, {
              action,
              ...logMeta,
              error: sanitizeErrorForLog(underlyingError, bodySnippetLength),
              attempt: currentAttempt + 1,
            })
          );

          return yield* Effect.fail(
            mapPluginError(underlyingError, {
              errors,
              nonceManager,
              fallbackRetryAfterMs: config.variables.nonceTtlMs,
            })
          );
        }
      });

    return run(runWithRetry()).catch((error) => {
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

export const mapValidateUserApiKeyResult = (
  result: { valid: boolean; retryable?: boolean; error?: string },
  errors: PluginErrorConstructors
) => {
  const unauthorized = errors.UNAUTHORIZED;
  const tooManyRequests = errors.TOO_MANY_REQUESTS;

  if (!unauthorized || !tooManyRequests) {
    throw new Error("Required error constructors missing");
  }

  if (result.valid) {
    return result;
  }

  if (result.retryable) {
    throw tooManyRequests({
      message: result.error ?? "Validation retry suggested",
      data: { retryable: true },
    });
  }

  throw unauthorized({
    message: result.error ?? "User API key invalid",
    data: { retryable: false },
  });
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
  normalizeUserApiScopes,
  VariablesSchema,
};

export const createRouter = (
  context: PluginContext,
  builder: Implementer<typeof contract, PluginContext, PluginContext>
) => {
    const {
      discourseService,
      cryptoService,
      nonceManager,
      config,
      logger,
      normalizedUserApiScopes,
      bodySnippetLength,
      metrics,
    } = context;

    const log = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      meta?: Record<string, unknown>
    ) => {
      logger[level](message, normalizeMeta(meta));
    };

    const recordRetryAttempt = (meta: {
      action: string;
      attempt: number;
      delayMs: number;
      status?: number;
    }) => {
      metrics.retryAttempts += 1;
      log("info", "Discourse retry attempt recorded", {
        action: meta.action,
        attempt: meta.attempt,
        delayMs: meta.delayMs,
        status: meta.status,
        retryAttempts: metrics.retryAttempts,
      });
    };

    const run = <A, E>(eff: Effect.Effect<A, E, never>) =>
      Effect.runPromise(eff);

    const operationRetryPolicy =
      config.operationRetryPolicy ?? config.variables.operationRetryPolicy;

    const deriveLoggingRetryPolicy = (
      policy?: { maxRetries?: number; baseDelayMs?: number } | null
    ) => {
      if (!policy) return undefined;
      const toNonNegative = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
      const maxRetries = toNonNegative(policy.maxRetries);
      const minDelay = toNonNegative(policy.baseDelayMs);
      return {
        maxAttempts: Math.max(1, 1 + maxRetries),
        retryOnTransportError: true,
        minDelayMs: minDelay,
      };
    };

    const readRetryPolicy = deriveLoggingRetryPolicy(
      operationRetryPolicy?.reads ?? operationRetryPolicy?.default ?? null
    );
    const writeRetryPolicy = deriveLoggingRetryPolicy(
      operationRetryPolicy?.writes ?? operationRetryPolicy?.default ?? null
    );

    log("debug", "Resolved retry policy", {
      action: "router-retry-policy",
      reads: readRetryPolicy ?? null,
      writes: writeRetryPolicy ?? null,
    });

    const withReadErrorLogging = createWithErrorLogging({
      log,
      run,
      nonceManager,
      config,
      bodySnippetLength,
      retryPolicy: readRetryPolicy,
      metrics: { recordRetryAttempt },
    });

    const withWriteErrorLogging = createWithErrorLogging({
      log,
      run,
      nonceManager,
      config,
      bodySnippetLength,
      retryPolicy: writeRetryPolicy,
      metrics: { recordRetryAttempt },
    });

    const logNonceLookup = (meta: Record<string, unknown>) =>
      log("debug", "Nonce lookup", {
        action: "nonce-lookup",
        ...meta,
      });

    const requireBadRequest = (errors: PluginErrorConstructors) => {
      if (!errors.BAD_REQUEST) {
        throw new RouterConfigError("BAD_REQUEST constructor missing");
      }
      return errors.BAD_REQUEST;
    };

    const getActiveNonceOrThrow = (
      nonce: string,
      errors: PluginErrorConstructors
    ) => {
      const badRequest = requireBadRequest(errors);
      const nonceData = nonceManager.get(nonce);
      if (!nonceData) {
        logNonceLookup({
          status: "missing",
          nonceSuffix: nonce.slice(-6),
        });
        throw badRequest({
          message: "Invalid or expired nonce",
          data: {},
        });
      }
      const verified = nonceManager.verify(nonce, nonceData.clientId);
      logNonceLookup({
        status: verified ? "verified" : "invalid",
          nonceSuffix: nonce.slice(-6),
          clientId: nonceData.clientId,
        });
      if (!verified) {
        throw badRequest({
          message: "Invalid or expired nonce",
          data: {},
        });
      }
      return nonceData;
    };

    return {
      initiateLink: builder.initiateLink.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "initiate-link",
          async () => {
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
                scopes: normalizedUserApiScopes.joined,
              })
            );

            const expiresAt = nonceManager.getExpiration(nonce);
            if (!expiresAt) {
              throw new Error("Failed to compute nonce expiration");
            }

            log("info", "Generated Discourse auth URL", {
              action: "initiate-link",
              clientId: input.clientId,
              applicationName: input.applicationName,
              expiresAt,
            });

            return {
              authUrl,
              nonce,
              expiresAt: new Date(expiresAt).toISOString(),
            };
          },
          errors
        )
      ),

      completeLink: builder.completeLink.handler(async ({ input, errors }) => {
        return withWriteErrorLogging(
          "complete-link",
          async () => {
            const nonceData = getActiveNonceOrThrow(input.nonce, errors);

            try {
              let userApiKey: string;
              try {
                userApiKey = await run(
                  cryptoService.decryptPayload(
                    input.payload,
                    nonceData.privateKey
                  )
                );
              } catch (error) {
                log("warn", "Failed to decrypt Discourse payload", {
                  action: "complete-link",
                  error: sanitizeErrorForLog(error),
                });
                throw requireBadRequest(errors)({
                  message: "Invalid or expired payload",
                  data: {},
                });
              }

              const discourseUser = await run(
                discourseService.getCurrentUser(userApiKey)
              );

              log("info", "Completed Discourse link", {
                action: "complete-link",
                discourseUser: discourseUser.username,
              });

              return {
                userApiKey,
                discourseUsername: discourseUser.username,
                discourseUserId: discourseUser.id,
              };
            } finally {
              nonceManager.consume(input.nonce);
            }
          },
          errors
        );
      }),

      createPost: builder.createPost.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "create-post",
          async () => {
            const postData = await run(
              discourseService.createPost({
                title: input.title,
                raw: input.raw,
                category: input.category,
                username: input.username,
                topicId: input.topicId,
                replyToPostNumber: input.replyToPostNumber,
                userApiKey: input.userApiKey,
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
              discourseUsername: input.username,
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
          },
          errors
        )
      ),

      editPost: builder.editPost.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "edit-post",
          async () => {
            const postData = await run(
              discourseService.editPost({
                postId: input.postId,
                raw: input.raw,
                username: input.username,
                editReason: input.editReason,
                userApiKey: input.userApiKey,
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
              discourseUsername: input.username,
              postId: postData.id,
              topicId: postData.topicId,
            });

            return {
              success: true,
              postUrl,
              postId: postData.id,
              topicId: postData.topicId,
            };
          },
          errors
        )
      ),

      prepareUpload: builder.prepareUpload.handler(async ({ input, errors }) => {
        const resolvedUploadType = input.uploadType ?? "composer";

        return withWriteErrorLogging(
          "prepare-upload",
          async () => {
            const request = discourseService.buildUploadRequest({
              uploadType: resolvedUploadType,
              username: input.username,
              userApiKey: input.userApiKey,
            });

            log("debug", "Prepared upload request", {
              action: "prepare-upload",
              uploadType: resolvedUploadType,
              username: input.username,
            });

            return { request };
          },
          errors,
          undefined,
          { uploadType: resolvedUploadType, username: input.username }
        );
      }),

      presignUpload: builder.presignUpload.handler(async ({ input, errors }) => {
        const uploadType = input.uploadType ?? "composer";

        return withWriteErrorLogging(
          "presign-upload",
          async () => {
            const result = await run(
              discourseService.presignUpload({
                filename: input.filename,
                byteSize: input.byteSize,
                contentType: input.contentType,
                uploadType,
                userApiKey: input.userApiKey,
              })
            );

            log("info", "Generated presigned upload", {
              action: "presign-upload",
              uploadType,
              filename: input.filename,
            });

            return result;
          },
          errors,
          undefined,
          { uploadType, filename: input.filename }
        );
      }),

      batchPresignMultipartUpload: builder.batchPresignMultipartUpload.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "batch-presign-multipart-upload",
            async () => {
              const result = await run(
                discourseService.batchPresignMultipartUpload({
                  uniqueIdentifier: input.uniqueIdentifier,
                  partNumbers: input.partNumbers,
                  uploadId: input.uploadId,
                  key: input.key,
                  contentType: input.contentType,
                  userApiKey: input.userApiKey,
                })
              );

              log("debug", "Presigned multipart upload parts", {
                action: "batch-presign-multipart-upload",
                parts: input.partNumbers.length,
              });

              return result;
            },
            errors,
            undefined,
            {
              uploadId: input.uploadId,
              key: input.key,
              uniqueIdentifier: input.uniqueIdentifier,
              parts: input.partNumbers.length,
            }
          )
      ),

      completeMultipartUpload: builder.completeMultipartUpload.handler(
        async ({ input, errors }) => {
          const uploadType = input.uploadType ?? "composer";

          return withWriteErrorLogging(
            "complete-multipart-upload",
            async () => {
              const result = await run(
                discourseService.completeMultipartUpload({
                  uniqueIdentifier: input.uniqueIdentifier,
                  uploadId: input.uploadId,
                  key: input.key,
                  parts: input.parts,
                  filename: input.filename,
                  uploadType,
                  userApiKey: input.userApiKey,
                })
              );

              log("info", "Completed multipart upload", {
                action: "complete-multipart-upload",
                uploadId: input.uploadId,
                partCount: input.parts.length,
                uploadType,
              });

              return result;
            },
            errors,
            undefined,
            {
              uploadId: input.uploadId,
              uploadType,
              partCount: input.parts.length,
              filename: input.filename,
            }
          );
        }
      ),

      abortMultipartUpload: builder.abortMultipartUpload.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "abort-multipart-upload",
            async () => {
              const aborted = await run(
                discourseService.abortMultipartUpload({
                  uniqueIdentifier: input.uniqueIdentifier,
                  uploadId: input.uploadId,
                  key: input.key,
                  userApiKey: input.userApiKey,
                })
              );

              log("warn", "Aborted multipart upload", {
                action: "abort-multipart-upload",
                uploadId: input.uploadId,
                aborted,
              });

              return { aborted };
            },
            errors,
            undefined,
            {
              uploadId: input.uploadId,
              key: input.key,
              uniqueIdentifier: input.uniqueIdentifier,
            }
          )
      ),

      lockPost: builder.lockPost.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "lock-post",
          async () => {
            const result = await run(
              discourseService.lockPost({
                postId: input.postId,
                locked: input.locked,
                username: input.username,
                userApiKey: input.userApiKey,
              })
            );

            log("info", "Updated Discourse post lock", {
              action: "lock-post",
              postId: input.postId,
              locked: result.locked,
              discourseUsername: input.username,
            });

            return result;
          },
          errors
        )
      ),

      performPostAction: builder.performPostAction.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "perform-post-action",
            async () => {
              const result = await run(
                discourseService.performPostAction({
                  postId: input.postId,
                  action: input.action,
                  postActionTypeId: input.postActionTypeId,
                  message: input.message,
                  flagTopic: input.flagTopic,
                  takeAction: input.takeAction,
                  undo: input.undo,
                  username: input.username,
                  userApiKey: input.userApiKey,
                })
              );

              log("info", "Performed Discourse post action", {
                action: "perform-post-action",
                postId: input.postId,
                postActionTypeId: result.postActionTypeId,
                postActionId: result.postActionId,
                actionName: result.action,
                discourseUsername: input.username,
              });

              return result;
            },
            errors
          )
      ),

      deletePost: builder.deletePost.handler(async ({ input, errors }) => {
        const forceDestroy = input.forceDestroy === true;

        return withWriteErrorLogging(
          "delete-post",
          async () => {
            const result = await run(
              discourseService.deletePost({
                postId: input.postId,
                forceDestroy,
                username: input.username,
                userApiKey: input.userApiKey,
              })
            );

            log("info", "Deleted Discourse post", {
              action: "delete-post",
              postId: input.postId,
              forceDestroy,
              discourseUsername: input.username,
            });

            return result;
          },
          errors,
          undefined,
          { postId: input.postId, forceDestroy, discourseUsername: input.username }
        );
      }),

      search: builder.search.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "search",
          async () => {
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
          },
          errors
        )
      ),

      ping: builder.ping.handler(async () => {
        const timeoutMs = Math.min(config.variables.requestTimeoutMs, 2000);
        const discourseConnected = await discourseService.checkHealth({
          timeoutMs,
        });

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

      getTags: builder.getTags.handler(async ({ errors }) =>
        withReadErrorLogging(
          "get-tags",
          async () => {
            const tags = await run(discourseService.getTags());
            log("debug", "Fetched tags", {
              action: "get-tags",
              count: tags.length,
            });
            return { tags };
          },
          errors
        )
      ),

      getTag: builder.getTag.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-tag",
          async () => {
            const tag = await run(discourseService.getTag(input.name));
            log("debug", "Fetched tag", {
              action: "get-tag",
              name: input.name,
            });
            return { tag };
          },
          errors
        )
      ),

      getTagGroups: builder.getTagGroups.handler(async ({ errors }) =>
        withReadErrorLogging(
          "get-tag-groups",
          async () => {
            const tagGroups = await run(discourseService.getTagGroups());
            log("debug", "Fetched tag groups", {
              action: "get-tag-groups",
              count: tagGroups.length,
            });
            return { tagGroups };
          },
          errors
        )
      ),

      getTagGroup: builder.getTagGroup.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-tag-group",
          async () => {
            const tagGroup = await run(
              discourseService.getTagGroup(input.tagGroupId)
            );
            log("debug", "Fetched tag group", {
              action: "get-tag-group",
              tagGroupId: input.tagGroupId,
            });
            return { tagGroup };
          },
          errors
        )
      ),

      createTagGroup: builder.createTagGroup.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
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
        )
      ),

      updateTagGroup: builder.updateTagGroup.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
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
        )
      ),

      getCategories: builder.getCategories.handler(async ({ errors }) =>
        withReadErrorLogging(
          "get-categories",
          async () => {
            const categories = await run(discourseService.getCategories());
            log("debug", "Fetched categories", { action: "get-categories" });
            return { categories };
          },
          errors
        )
      ),

      getCategory: builder.getCategory.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-category",
          async () => {
            const result = await run(
              discourseService.getCategory(input.idOrSlug)
            );
            log("debug", "Fetched category", {
              action: "get-category",
              idOrSlug: input.idOrSlug,
            });
            return result;
          },
          errors
        )
      ),

      getTopic: builder.getTopic.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-topic",
          async () => {
            const topic = await run(discourseService.getTopic(input.topicId));
            log("debug", "Fetched topic", {
              action: "get-topic",
              topicId: input.topicId,
            });
            return { topic };
          },
          errors
        )
      ),

      getLatestTopics: builder.getLatestTopics.handler(
        async ({ input, errors }) =>
          withReadErrorLogging(
            "get-latest-topics",
            async () => {
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
            },
            errors
          )
      ),

      listTopicList: builder.listTopicList.handler(
        async ({ input, errors }) =>
          withReadErrorLogging(
            "list-topic-list",
            async () => {
              const result = await run(
                discourseService.getTopicList({
                  type: input.type,
                  categoryId: input.categoryId,
                  page: input.page,
                  order: input.order,
                  period: input.period,
                })
              );
              log("debug", "Fetched topic list", {
                action: "list-topic-list",
                type: input.type,
                categoryId: input.categoryId,
                page: input.page,
                order: input.order,
                period: input.period,
              });
              return result;
            },
            errors
          )
      ),

      getTopTopics: builder.getTopTopics.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-top-topics",
          async () => {
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
          },
          errors
        )
      ),

      getCategoryTopics: builder.getCategoryTopics.handler(
        async ({ input, errors }) =>
          withReadErrorLogging(
            "get-category-topics",
            async () => {
              const result = await run(
                discourseService.getCategoryTopics({
                  slug: input.slug,
                  categoryId: input.categoryId,
                  page: input.page,
                })
              );
              log("debug", "Fetched category topics", {
                action: "get-category-topics",
                slug: input.slug,
                categoryId: input.categoryId,
                page: input.page,
              });
            return result;
          },
          errors
        )
      ),

      updateTopicStatus: builder.updateTopicStatus.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "update-topic-status",
            async () => {
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
            },
            errors
          )
      ),

      updateTopicMetadata: builder.updateTopicMetadata.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "update-topic-metadata",
            async () => {
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
            },
            errors
          )
      ),

      bookmarkTopic: builder.bookmarkTopic.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "bookmark-topic",
          async () => {
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
          },
          errors
        )
      ),

      inviteToTopic: builder.inviteToTopic.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "invite-to-topic",
          async () => {
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
          },
          errors
        )
      ),

      setTopicNotification: builder.setTopicNotification.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "set-topic-notification",
            async () => {
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
            },
            errors
          )
      ),

      changeTopicTimestamp: builder.changeTopicTimestamp.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "change-topic-timestamp",
            async () => {
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
            },
            errors
          )
      ),

      addTopicTimer: builder.addTopicTimer.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "add-topic-timer",
          async () => {
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
          },
          errors
        )
      ),

      getPost: builder.getPost.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-post",
          async () => {
            const result = await run(
              discourseService.getPost(input.postId, input.includeRaw)
            );
            log("debug", "Fetched post", {
              action: "get-post",
              postId: input.postId,
              includeRaw: input.includeRaw,
            });
            return result;
          },
          errors
        )
      ),

      listPosts: builder.listPosts.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "list-posts",
          async () => {
            const result = await run(discourseService.listPosts({ page: input.page }));
            log("debug", "Fetched posts", {
              action: "list-posts",
              page: input.page,
            });
            return result;
          },
          errors
        )
      ),

      getPostReplies: builder.getPostReplies.handler(
        async ({ input, errors }) =>
          withReadErrorLogging(
            "get-post-replies",
            async () => {
              const replies = await run(
                discourseService.getPostReplies(input.postId)
              );
              log("debug", "Fetched post replies", {
                action: "get-post-replies",
                postId: input.postId,
              });
              return { replies };
            },
            errors
          )
      ),

      getRevision: builder.getRevision.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-revision",
          async () => {
            const result = await run(
              discourseService.getRevision({
                postId: input.postId,
                revision: input.revision,
                includeRaw: input.includeRaw,
                username: input.username,
                userApiKey: input.userApiKey,
              })
            );
            log("debug", "Fetched post revision", {
              action: "get-revision",
              postId: input.postId,
              revision: input.revision,
              includeRaw: input.includeRaw,
            });
            return result;
          },
          errors
        )
      ),

      updateRevision: builder.updateRevision.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "update-revision",
            async () => {
              const result = await run(
                discourseService.updateRevision({
                  postId: input.postId,
                  revision: input.revision,
                  raw: input.raw,
                  editReason: input.editReason,
                  username: input.username,
                  userApiKey: input.userApiKey,
                })
              );
              log("info", "Updated post revision", {
                action: "update-revision",
                postId: input.postId,
                revision: input.revision,
                discourseUsername: input.username,
              });
              return result;
            },
            errors
          )
      ),

      deleteRevision: builder.deleteRevision.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "delete-revision",
            async () => {
              const result = await run(
                discourseService.deleteRevision({
                  postId: input.postId,
                  revision: input.revision,
                  username: input.username,
                  userApiKey: input.userApiKey,
                })
              );
              log("info", "Deleted post revision", {
                action: "delete-revision",
                postId: input.postId,
                revision: input.revision,
                discourseUsername: input.username,
              });
              return result;
            },
            errors
          )
      ),

      getUser: builder.getUser.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-user",
          async () => {
            const user = await run(discourseService.getUser(input.username));
            log("debug", "Fetched user", {
              action: "get-user",
              username: input.username,
            });
            return { user };
          },
          errors
        )
      ),

      createUser: builder.createUser.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "create-user",
          async () => {
            const result = await run(
              discourseService.createUser({
                username: input.username,
                email: input.email,
                name: input.name,
                password: input.password,
                active: input.active,
                approved: input.approved,
                externalId: input.externalId,
                externalProvider: input.externalProvider,
                staged: input.staged,
                emailVerified: input.emailVerified,
                locale: input.locale,
              })
            );

            log("info", "Created Discourse user", {
              action: "create-user",
              username: input.username,
              userId: result.userId,
            });

            return result;
          },
          errors
        )
      ),

      updateUser: builder.updateUser.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "update-user",
          async () => {
            const result = await run(
              discourseService.updateUser({
                username: input.username,
                email: input.email,
                name: input.name,
                title: input.title,
                trustLevel: input.trustLevel,
                active: input.active,
                suspendedUntil: input.suspendedUntil,
                suspendReason: input.suspendReason,
                staged: input.staged,
                bioRaw: input.bioRaw,
                locale: input.locale,
              })
            );

            log("info", "Updated Discourse user", {
              action: "update-user",
              username: input.username,
            });

            return result;
          },
          errors
        )
      ),

      deleteUser: builder.deleteUser.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "delete-user",
          async () => {
            const result = await run(
              discourseService.deleteUser({
                userId: input.userId,
                blockEmail: input.blockEmail,
                blockUrls: input.blockUrls,
                blockIp: input.blockIp,
                deletePosts: input.deletePosts,
                context: input.context,
              })
            );

            log("info", "Deleted Discourse user", {
              action: "delete-user",
              userId: input.userId,
              deletePosts: input.deletePosts,
            });

            return result;
          },
          errors
        )
      ),

      listUsers: builder.listUsers.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "list-users",
          async () => {
            const users = await run(
              discourseService.listUsers({ page: input.page })
            );
            log("debug", "Listed Discourse users", {
              action: "list-users",
              page: input.page,
            });
            return { users };
          },
          errors
        )
      ),

      listAdminUsers: builder.listAdminUsers.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "list-admin-users",
          async () => {
            const users = await run(
              discourseService.listAdminUsers({
                filter: input.filter,
                page: input.page,
                showEmails: input.showEmails,
              })
            );
            log("debug", "Listed admin users", {
              action: "list-admin-users",
              filter: input.filter,
              page: input.page,
              showEmails: input.showEmails,
            });
            return { users };
          },
          errors
        )
      ),

      getUserByExternal: builder.getUserByExternal.handler(
        async ({ input, errors }) =>
          withReadErrorLogging(
            "get-user-by-external",
            async () => {
              const user = await run(
                discourseService.getUserByExternal({
                  externalId: input.externalId,
                  provider: input.provider,
                })
              );

              log("debug", "Fetched user by external id", {
                action: "get-user-by-external",
                provider: input.provider,
              });

              return { user };
            },
            errors
          )
      ),

      getDirectory: builder.getDirectory.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-directory",
          async () => {
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
          },
          errors
        )
      ),

      forgotPassword: builder.forgotPassword.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "forgot-password",
          async () => {
            const result = await run(
              discourseService.forgotPassword(input.login)
            );

            log("info", "Requested password reset", {
              action: "forgot-password",
              login: input.login,
            });

            return result;
          },
          errors
        )
      ),

      changePassword: builder.changePassword.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "change-password",
          async () => {
            const result = await run(
              discourseService.changePassword({
                token: input.token,
                password: input.password,
              })
            );

            log("info", "Changed user password via token", {
              action: "change-password",
            });

            return result;
          },
          errors
        )
      ),

      logoutUser: builder.logoutUser.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "logout-user",
          async () => {
            const result = await run(discourseService.logoutUser(input.userId));

            log("info", "Logged out Discourse user", {
              action: "logout-user",
              userId: input.userId,
            });

            return result;
          },
          errors
        )
      ),

      syncSso: builder.syncSso.handler(async ({ input, errors }) =>
        withWriteErrorLogging(
          "sync-sso",
          async () => {
            const result = await run(
              discourseService.syncSso({
                sso: input.sso,
                sig: input.sig,
              })
            );

            log("info", "Synchronized SSO payload", {
              action: "sync-sso",
              userId: result.userId,
            });

            return result;
          },
          errors
        )
      ),

      getUserStatus: builder.getUserStatus.handler(async ({ input, errors }) =>
        withReadErrorLogging(
          "get-user-status",
          async () => {
            const result = await run(
              discourseService.getUserStatus(input.username)
            );

            log("debug", "Fetched user status", {
              action: "get-user-status",
              username: input.username,
            });

            return result;
          },
          errors
        )
      ),

      updateUserStatus: builder.updateUserStatus.handler(
        async ({ input, errors }) =>
          withWriteErrorLogging(
            "update-user-status",
            async () => {
              const result = await run(
                discourseService.updateUserStatus({
                  username: input.username,
                  emoji: input.emoji,
                  description: input.description,
                  endsAt: input.endsAt,
                })
              );

              log("info", "Updated user status", {
                action: "update-user-status",
                username: input.username,
              });

              return result;
            },
            errors
          )
      ),

      getSiteInfo: builder.getSiteInfo.handler(async ({ errors }) =>
        withReadErrorLogging(
          "get-site-info",
          async () => {
            const site = await run(discourseService.getSiteInfo());
            log("debug", "Fetched site info", {
              action: "get-site-info",
              categories: site.categories.length,
            });
            return site;
          },
          errors
        )
      ),

      getSiteBasicInfo: builder.getSiteBasicInfo.handler(async ({ errors }) =>
        withReadErrorLogging(
          "get-site-basic-info",
          async () => {
            const site = await run(discourseService.getSiteBasicInfo());
            log("debug", "Fetched site basic info", {
              action: "get-site-basic-info",
              title: site.title,
            });
            return site;
          },
          errors
        )
      ),

      validateUserApiKey: builder.validateUserApiKey.handler(
        async ({ input, errors }) =>
          withReadErrorLogging(
            "validate-user-api-key",
            async () => {
              const result = await run(
                discourseService.validateUserApiKey(input.userApiKey)
              );

              return mapValidateUserApiKeyResult(result, errors);
            },
            errors
          )
      ),
    };
  };

export default createPlugin({
  variables: VariablesSchema,

  secrets: SecretsSchema,

  contract,

  initialize: (config: DiscoursePluginConfig) =>
    Effect.gen(function* () {
      const logger = createSafeLogger(config.logger ?? noopLogger);
      const metrics = { retryAttempts: 0, nonceEvictions: 0 };
      const normalizedUserApiScopes = normalizeUserApiScopes(
        config.variables.userApiScopes
      );
      const bodySnippetLength = config.variables.logBodySnippetLength;

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
            maxRetries: 0,
            maxDelayMs: config.variables.requestTimeoutMs,
          },
          operationRetryPolicy: config.operationRetryPolicy ?? config.variables.operationRetryPolicy,
          bodySnippetLength,
          requestLogger: config.requestLogger,
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
        nonceManager,
        config,
        logger,
        normalizedUserApiScopes,
        cleanupFiber,
        bodySnippetLength,
        metrics,
      };
    }),

  shutdown: (context: PluginContext) =>
    Effect.zipRight(
      Effect.sync(() => context.nonceManager.cleanup()),
      interruptCleanupFiber(context.cleanupFiber)
    ),

  createRouter,
});
