import { Effect } from "every-plugin/effect";
import type { RetryPolicy } from "./constants";
import {
  DEFAULT_BODY_SNIPPET_LENGTH,
  DEFAULT_RETRY_POLICY,
  TRANSIENT_STATUSES,
} from "./constants";
import {
  Transport,
  buildRetryPolicies,
  normalizeRetryPolicy,
  resolveRetryPolicy as resolveRetryPolicyFn,
  type FetchOptions,
  type RetryFns,
} from "./transport";
import { formatError } from "./utils";
import {
  createSafeLogger,
  noopLogger,
  type Logger,
  type RequestLogger,
  type SafeLogger,
} from "./logging";
import { normalizeHeaderValues } from "./resources/shared";

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
]);

const safeErrorMessage = (error: Error): string => {
  try {
    /* c8 ignore next */
    return String((error as any).message ?? "");
  } catch {
    return "";
  }
};

const isTransportError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;

  const message = safeErrorMessage(error);
  if (!message) return false;

  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes("failed to parse json") || lowerMessage.includes("validation failed")) {
    return false;
  }

  const code = (error as any).code;
  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error.name === "FetchError") return true;
  if (error.name === "TypeError" && /fetch failed|networkerror/i.test(message)) {
    return true;
  }
  if (/(network|connection|connect|timeout|timed out|temporar|transient)/i.test(message)) {
    return true;
  }
  return false;
};

export const isRetryableValidationError = (error: unknown): boolean => {
  if (error instanceof DiscourseApiError) {
    return TRANSIENT_STATUSES.has(error.status) || error.status >= 500;
  }
  return isTransportError(error);
};

export const normalizeSuccessFlag = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    return normalized === "ok" || normalized === "success" || normalized === "true";
  }
  return undefined;
};

export class DiscourseApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly method: string;
  readonly bodySnippet?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly context?: string;
  readonly bodySnippetMaxLength: number;

  constructor(params: {
    status: number;
    path: string;
    method: string;
    bodySnippet?: string;
    retryAfterMs?: number;
    requestId?: string;
    context?: string;
    bodySnippetMaxLength?: number;
  }) {
    const base = `Discourse API error (${params.method} ${params.status}): ${params.path}`;
    const maxLength = Math.max(
      0,
      params.bodySnippetMaxLength ?? DEFAULT_BODY_SNIPPET_LENGTH
    );
    const trimmedBodySnippet =
      typeof params.bodySnippet === "string"
        ? params.bodySnippet.slice(0, maxLength)
        : undefined;
    const detailed = trimmedBodySnippet ? `${base} - ${trimmedBodySnippet}` : base;
    const message = params.context ? `${params.context}: ${detailed}` : detailed;
    super(message);
    this.name = "DiscourseApiError";
    this.status = params.status;
    this.path = params.path;
    this.method = params.method;
    this.bodySnippet = trimmedBodySnippet;
    this.bodySnippetMaxLength = maxLength;
    this.retryAfterMs = params.retryAfterMs;
    this.requestId = params.requestId;
    this.context = params.context;
  }
}

const wrapServiceError = (action: string, error: unknown): Error => {
  if (error instanceof DiscourseApiError) {
    return new DiscourseApiError({
      status: error.status,
      path: error.path,
      method: error.method,
      bodySnippet: error.bodySnippet,
      bodySnippetMaxLength: error.bodySnippetMaxLength,
      retryAfterMs: error.retryAfterMs,
      requestId: error.requestId,
      context: `${action} failed`,
    });
  }
  return new Error(`${action} failed: ${formatError(error)}`);
};

export const runWithContext = <A>(action: string, fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error: unknown) => wrapServiceError(action, error),
  });

export type OperationRetryPolicy = {
  default?: Partial<RetryPolicy>;
  reads?: Partial<RetryPolicy>;
  writes?: Partial<RetryPolicy>;
};

export type ResourceClient = {
  buildUrl: (path: string) => string;
  getNormalizedBaseUrl: () => string;
  resolvePath: (path: string) => string;
  buildQuery: (params: Record<string, string | number | undefined>) => string;
  buildRequest: (
    path: string,
    options: FetchOptions
  ) => {
    url: string;
    methodUpper: string;
    headers: Record<string, string>;
    resolvedBody?: BodyInit;
    effectiveTimeout: number;
  };
  fetchApi: <T>(path: string, options?: FetchOptions) => Promise<T | undefined>;
  normalizeHeaderValues: (headers?: Record<string, unknown>) => Record<string, string>;
};

export class DiscourseClient implements ResourceClient {
  protected readonly baseUrl: string;
  protected readonly defaultTimeoutMs: number;
  protected readonly userAgent?: string;
  protected readonly userApiClientId?: string;
  protected readonly retryPolicy: RetryPolicy;
  protected readonly retryPolicies: { default: RetryPolicy; reads: RetryPolicy; writes: RetryPolicy };
  protected readonly baseRequestLogger?: RequestLogger;
  protected requestLogger?: RequestLogger;
  protected readonly fetchImpl?: typeof fetch;
  protected readonly bodySnippetLength: number;
  protected readonly transport: Transport;
  protected readonly logger: Logger;

  constructor(
    baseUrl: string,
    protected readonly systemApiKey: string,
    protected readonly systemUsername: string,
    logger: Logger = noopLogger,
    options: {
      defaultTimeoutMs?: number;
      userAgent?: string;
      userApiClientId?: string;
      retryPolicy?: Partial<RetryPolicy>;
      operationRetryPolicy?: OperationRetryPolicy;
      requestLogger?: RequestLogger;
      fetchImpl?: typeof fetch;
      bodySnippetLength?: number;
    } = {}
  ) {
    try {
      const parsed = new URL(baseUrl);
      const trimmedPath = parsed.pathname.replace(/\/+$/, "");
      const normalizedPath = trimmedPath.length ? trimmedPath : "";
      this.baseUrl = `${parsed.origin}${normalizedPath}/`;
    } catch {
      throw new Error(`Invalid Discourse base URL: ${baseUrl}`);
    }

    this.logger = logger;
    this.defaultTimeoutMs =
      typeof options.defaultTimeoutMs === "number" &&
      Number.isFinite(options.defaultTimeoutMs) &&
      options.defaultTimeoutMs > 0
        ? options.defaultTimeoutMs
        : 30000;
    this.userAgent = options.userAgent?.trim() || undefined;
    this.userApiClientId = options.userApiClientId?.trim() || undefined;
    this.retryPolicy = normalizeRetryPolicy(options.retryPolicy, DEFAULT_RETRY_POLICY);
    this.retryPolicies = buildRetryPolicies(this.retryPolicy, options.operationRetryPolicy);
    this.baseRequestLogger = options.requestLogger;
    this.requestLogger = options.requestLogger;
    this.fetchImpl = options.fetchImpl;
    this.bodySnippetLength =
      typeof options.bodySnippetLength === "number" && options.bodySnippetLength >= 0
        ? options.bodySnippetLength
        : DEFAULT_BODY_SNIPPET_LENGTH;
    this.transport = new Transport({
      baseUrl: this.baseUrl,
      defaultTimeoutMs: this.defaultTimeoutMs,
      userAgent: this.userAgent,
      userApiClientId: this.userApiClientId,
      systemApiKey: this.systemApiKey,
      systemUsername: this.systemUsername,
      logger: this.logger,
      requestLogger: (payload) => {
        this.baseRequestLogger?.(payload);
        if (this.requestLogger && this.requestLogger !== this.baseRequestLogger) {
          this.requestLogger(payload);
        }
      },
      fetchImpl: this.fetchImpl,
      bodySnippetLength: this.bodySnippetLength,
      retryPolicy: this.retryPolicy,
      retryPolicies: this.retryPolicies,
      onHttpError: (params) => new DiscourseApiError(params),
    });
  }

  buildUrl(path: string): string {
    return this.transport.buildUrl(path);
  }

  getNormalizedBaseUrl(): string {
    return this.transport.getNormalizedBaseUrl();
  }

  resolvePath(path: string): string {
    return this.transport.resolvePath(path);
  }

  buildQuery(params: Record<string, string | number | undefined>): string {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined) return;
      queryParams.set(key, String(value));
    });
    return queryParams.toString();
  }

  buildRequest(path: string, options: FetchOptions) {
    return this.transport.buildRequest(path, options);
  }

  async fetchApi<T>(
    path: string,
    options: FetchOptions = {}
  ): Promise<T | undefined> {
    const retryFns: RetryFns = {
      shouldRetry: (error) => this.shouldRetry(error),
      computeDelayMs: (error, attempt, retryPolicy) =>
        this.computeDelayMs(error, attempt, retryPolicy),
    };
    return this.transport.fetchApi(
      path,
      options,
      retryFns,
      (method, overrides) => resolveRetryPolicyFn(method, this.retryPolicies, overrides)
    );
  }

  protected shouldRetry(error: unknown): boolean {
    if (error instanceof DiscourseApiError) {
      /* c8 ignore next */
      return TRANSIENT_STATUSES.has(error.status) || error.status >= 500;
    }
    return isTransportError(error);
  }

  protected computeDelayMs(
    error: unknown,
    attempt: number,
    retryPolicy: RetryPolicy = this.retryPolicy
  ): number {
    if (error instanceof DiscourseApiError && typeof error.retryAfterMs === "number") {
      return Math.min(Math.max(0, error.retryAfterMs), retryPolicy.maxDelayMs);
    }
    const base = retryPolicy.baseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(base, retryPolicy.maxDelayMs);
    const jitter = capped * retryPolicy.jitterRatio;
    const randomOffset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(capped + randomOffset));
  }

  protected resolveRetryPolicy(method: string, overrides?: Partial<RetryPolicy>) {
    return resolveRetryPolicyFn(method, this.retryPolicies, overrides);
  }

  normalizeHeaderValues(headers?: Record<string, unknown>) {
    return normalizeHeaderValues(
      (headers ?? {}) as Record<string, string | number | undefined>
    );
  }

  getSafeLogger(): SafeLogger {
    return createSafeLogger(this.logger);
  }
}
