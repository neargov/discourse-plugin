import { z } from "every-plugin/zod";
import type { OperationRetryPolicy } from "./client";
import type { Logger, RequestLogger } from "./logging";
import type { PluginErrorConstructors } from "./plugin-errors";

class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginConfigError";
  }
}

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

export const VariablesSchema = z.object({
  discourseBaseUrl: z
    .string()
    .url()
    .describe("Base URL of the Discourse forum (required, non-secret)"),
  discourseApiUsername: z
    .string()
    .default("system")
    .describe("System username used for API impersonation"),
  clientId: z
    .string()
    .default("discourse-plugin")
    .describe("Client identifier for user API key flows"),
  requestTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30000)
    .describe("Default request timeout in milliseconds for Discourse API calls"),
  requestsPerSecond: z
    .number()
    .int()
    .positive()
    .default(10)
    .describe("Allowed Discourse API requests per second for this plugin instance"),
  rateLimitBucketTtlMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000)
    .describe("TTL in milliseconds before idle rate-limit buckets are evicted"),
  rateLimitMaxBuckets: z
    .number()
    .int()
    .positive()
    .default(1000)
    .describe("Maximum number of rate-limit buckets to retain at once"),
  rateLimitStrategy: z
    .enum(["global", "perAction", "perClient", "perActionClient"])
    .default("global")
    .describe("Rate limit scope: single bucket, per action, per clientId, or per action+client"),
  cacheMaxSize: z
    .number()
    .int()
    .nonnegative()
    .default(1000)
    .describe("Maximum number of cache entries for Discourse reads"),
  cacheTtlMs: z
    .number()
    .int()
    .nonnegative()
    .default(60_000)
    .describe("TTL in milliseconds for cached Discourse responses"),
  nonceTtlMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000)
    .describe("Nonce lifetime in milliseconds for auth flows"),
  nonceCleanupIntervalMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000)
    .describe("Interval in milliseconds to sweep expired nonces"),
  nonceMaxPerClient: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum active nonces allowed per client"),
  nonceMaxTotal: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Global maximum active nonces allowed across clients"),
  nonceLimitStrategy: z
    .object({
      perClient: z.enum(["rejectNew", "evictOldest"]).optional(),
      global: z.enum(["rejectNew", "evictOldest"]).optional(),
    })
    .optional()
    .describe("Strategy for handling nonce limits when thresholds are reached"),
  userApiScopes: UserApiScopesSchema.describe(
    "User API scopes requested during Discourse linking"
  ),
  userAgent: z
    .string()
    .min(1)
    .optional()
    .describe("Custom User-Agent header for Discourse API requests"),
  logBodySnippetLength: z
    .number()
    .int()
    .nonnegative()
    .default(500)
    .describe("Maximum body snippet length to include in logs"),
  operationRetryPolicy: z
    .object({
      default: RetryPolicySchema.optional(),
      reads: RetryPolicySchema.optional(),
      writes: RetryPolicySchema.optional(),
    })
    .optional()
    .describe("Overrides for retry policy per operation type (default/reads/writes)"),
});

export const SecretsSchema = z.object({
  discourseApiKey: z
    .string()
    .min(1, "Discourse System API key is required")
    .describe("Discourse System API key (sensitive; keep secret)"),
});

export type Variables = z.infer<typeof VariablesSchema>;
export type Secrets = z.infer<typeof SecretsSchema>;

export type DiscoursePluginConfig = {
  variables: Variables;
  secrets: Secrets;
  logger?: Logger;
  requestLogger?: RequestLogger;
  fetch?: typeof fetch;
  operationRetryPolicy?: OperationRetryPolicy;
};

export const normalizeUserApiScopes = (
  scopes: string[] | string | NormalizedUserApiScopes
): NormalizedUserApiScopes => UserApiScopesSchema.parse(scopes);

export const mapValidateUserApiKeyResult = (
  result: { valid: boolean; retryable?: boolean; error?: string },
  errors: PluginErrorConstructors
) => {
  const unauthorized = errors.UNAUTHORIZED;
  const tooManyRequests = errors.TOO_MANY_REQUESTS;

  if (!unauthorized || !tooManyRequests) {
    throw new PluginConfigError("Required error constructors missing");
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
