import { Effect } from "every-plugin/effect";
import { randomBytes, generateKeyPairSync, privateDecrypt, constants } from "crypto";
import { verify } from "near-sign-verify";
import { formatError, serializeError } from "./utils";
import { z } from "every-plugin/zod";

// Import types from contract
import type {
  Category,
  DiscourseUser,
  Linkage,
  PaginatedTopics,
  Post,
  SearchPost,
  SearchResult,
  Topic,
  UserProfile,
} from "./contract";

// Internal storage types
type StoredLinkage = Linkage & {
  discourseUserId: number;
  userApiKey: string;
};
type UserSummary = DiscourseUser;
type TopicListResponse = { topic_list?: { topics?: any[]; more_topics_url?: string | null } };
type CategoryShowResponse = {
  category: any;
  subcategory_list?: any[] | { categories?: any[] };
};
type CurrentUserResponse = { current_user?: any };
type SearchResponse = {
  posts?: any[];
  topics?: any[];
  users?: any[];
  categories?: any[];
  grouped_search_result?: {
    post_ids?: number[];
    more_full_page_results?: string;
  };
};

type RetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 0,
  baseDelayMs: 250,
  maxDelayMs: 5000,
  jitterRatio: 0.2,
};

export type Logger = {
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
};

export type SafeLogger = Required<Logger>;

export const noopLogger: SafeLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

export const createSafeLogger = (logger: Logger = noopLogger): SafeLogger => {
  const resolve = <K extends keyof Logger>(level: K): NonNullable<Logger[K]> => {
    const candidate = logger[level];
    if (typeof candidate === "function") {
      return candidate as NonNullable<Logger[K]>;
    }
    return noopLogger[level] as NonNullable<Logger[K]>;
  };

  const wrap =
    <K extends keyof Logger>(fn: NonNullable<Logger[K]>) =>
    (message: string, meta?: Record<string, unknown>) => {
      try {
        fn(message, meta);
      } catch {
        // ignore logger failures to keep control flow intact
      }
    };

  return {
    error: wrap(resolve("error")),
    warn: wrap(resolve("warn")),
    info: wrap(resolve("info")),
    debug: wrap(resolve("debug")),
  };
};

const sanitizeSnippet = (text: string, maxLength: number = 512): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
};

const formatParseIssues = (label: string, error: z.ZodError): string =>
  `${label} validation failed: ${error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `${path} ${issue.message}`;
    })
    .join("; ")}`;

const parseWithSchema = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(formatParseIssues(label, result.error));
  }
  return result.data;
};

const parseWithSchemaOrThrow = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
  friendlyMessage: string
): T => {
  try {
    return parseWithSchema(schema, value, label);
  } catch (error) {
    const wrapped = new Error(friendlyMessage);
    (wrapped as any).cause = error;
    throw wrapped;
  }
};

const RawCategorySchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().default(null),
  color: z.string().default(""),
  topic_count: z.number().default(0),
  post_count: z.number().default(0),
  parent_category_id: z.number().nullable().default(null),
  read_restricted: z.boolean().default(false),
});

const RawTopicSchema = z.object({
  id: z.number(),
  slug: z.string(),
  title: z.string(),
  category_id: z.number().nullable().default(null),
  created_at: z.string().nullable().default(null),
  last_posted_at: z.string().nullable().default(null),
  posts_count: z.number().default(0),
  reply_count: z.number().default(0),
  like_count: z.number().default(0),
  views: z.number().default(0),
  pinned: z.boolean().default(false),
  closed: z.boolean().default(false),
  archived: z.boolean().default(false),
  visible: z.boolean().default(true),
});

const RawUserSummarySchema = z.object({
  id: z.number(),
  username: z.string(),
  name: z.string().nullable().default(null),
  avatar_template: z.string().default(""),
  title: z.string().nullable().default(null),
  trust_level: z.number().default(0),
  moderator: z.boolean().default(false),
  admin: z.boolean().default(false),
});

const RawUserProfileSchema = RawUserSummarySchema.extend({
  created_at: z.string().optional(),
  last_posted_at: z.string().nullable().default(null),
  last_seen_at: z.string().nullable().default(null),
  post_count: z.number().default(0),
  badge_count: z.number().default(0),
  profile_view_count: z.number().default(0),
});

const RawPostSchema = z.object({
  id: z.number(),
  topic_id: z.number(),
  post_number: z.number(),
  username: z.string(),
  name: z.string().nullable().default(null),
  avatar_template: z.string().default(""),
  raw: z.string().optional(),
  cooked: z.string(),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
  reply_count: z.number().default(0),
  like_count: z.number().default(0),
  reply_to_post_number: z.number().nullable().default(null),
  can_edit: z.boolean().optional(),
  version: z.number().default(1),
});

const RawSearchPostSchema = z.preprocess(
  (value) => (value && typeof value === "object" ? value : {}),
  z.object({
    id: z.number().int().nonnegative().default(0).catch(0),
    topic_id: z.number().int().nonnegative().default(0).catch(0),
    post_number: z.number().int().nonnegative().default(0).catch(0),
    username: z.string().default("").catch(""),
    name: z.string().nullable().default(null).catch(null),
    avatar_template: z.string().default("").catch(""),
    raw: z.string().optional(),
    cooked: z.string().default("").catch(""),
    created_at: z.string().nullable().default(null).catch(null),
    updated_at: z.string().nullable().default(null).catch(null),
    reply_count: z.number().int().nonnegative().default(0).catch(0),
    like_count: z.number().int().nonnegative().default(0).catch(0),
    reply_to_post_number: z.number().int().nullable().default(null).catch(null),
    can_edit: z.boolean().optional(),
    version: z.number().int().default(1).catch(1),
    blurb: z.string().default("").catch(""),
  })
);

const parseRetryAfterHeader = (value?: string | null): number | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return asNumber * 1000;
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
};

const hasHeader = (headers: Record<string, string>, name: string): boolean => {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
};

const isRetryableValidationError = (error: unknown): boolean => {
  if (error instanceof DiscourseApiError) {
    return error.status === 429 || error.status >= 500;
  }
  // Default to retryable for non-Discourse errors (network/timeout/unknown)
  return true;
};

export class DiscourseApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly method: string;
  readonly bodySnippet?: string;
  readonly retryAfterMs?: number;
  readonly requestId?: string;
  readonly context?: string;

  constructor(params: {
    status: number;
    path: string;
    method: string;
    bodySnippet?: string;
    retryAfterMs?: number;
    requestId?: string;
    context?: string;
  }) {
    const base = `Discourse API error (${params.method} ${params.status}): ${params.path}`;
    const detailed = params.bodySnippet ? `${base} - ${params.bodySnippet}` : base;
    const message = params.context ? `${params.context}: ${detailed}` : detailed;
    super(message);
    this.name = "DiscourseApiError";
    this.status = params.status;
    this.path = params.path;
    this.method = params.method;
    this.bodySnippet = params.bodySnippet;
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
      retryAfterMs: error.retryAfterMs,
      requestId: error.requestId,
      context: `${action} failed`,
    });
  }
  return new Error(`${action} failed: ${formatError(error)}`);
};

const runWithContext = <A>(action: string, fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error: unknown) => wrapServiceError(action, error),
  });

const normalizePage = (page: number | undefined, minimum: number): number => {
  if (typeof page !== "number" || !Number.isFinite(page)) {
    return minimum;
  }
  const normalized = Math.max(minimum, Math.floor(page));
  return normalized;
};

/**
 * DiscourseService - Handles Discourse User API operations
 */
export class DiscourseService {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly userAgent?: string;
  private readonly userApiClientId?: string;

  constructor(
    baseUrl: string,
    private readonly systemApiKey: string,
    private readonly systemUsername: string,
    private readonly logger: Logger = noopLogger,
    options: {
      defaultTimeoutMs?: number;
      userAgent?: string;
      userApiClientId?: string;
      retryPolicy?: Partial<RetryPolicy>;
    } = {}
  ) {
    try {
      const parsed = new URL(baseUrl);
      const trimmedPath = parsed.pathname.replace(/\/+$/, "");
      const normalizedPath = trimmedPath.length ? trimmedPath : "";
      // Keep a single trailing slash to simplify URL construction
      this.baseUrl = `${parsed.origin}${normalizedPath}/`;
    } catch {
      throw new Error(`Invalid Discourse base URL: ${baseUrl}`);
    }
    this.defaultTimeoutMs =
      typeof options.defaultTimeoutMs === "number" &&
      Number.isFinite(options.defaultTimeoutMs) &&
      options.defaultTimeoutMs > 0
        ? options.defaultTimeoutMs
        : 30000;
    this.userAgent = options.userAgent?.trim() || undefined;
    this.userApiClientId = options.userApiClientId?.trim() || undefined;
    this.retryPolicy = this.normalizeRetryPolicy(options.retryPolicy);
  }

  private readonly retryPolicy: RetryPolicy;

  private buildUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    const normalizedPath = path.replace(/^\/+/, "");
    return new URL(normalizedPath, this.baseUrl).toString();
  }

  getNormalizedBaseUrl(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }

  resolvePath(path: string): string {
    return this.buildUrl(path);
  }

  private buildQuery(params: Record<string, string | number | undefined>): string {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined) return;
      queryParams.set(key, String(value));
    });
    return queryParams.toString();
  }

  private buildRequest(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      bodyMode?: "json" | "raw";
      bodySerializer?: (body: unknown) => BodyInit;
      accept?: string | null;
      asUser?: string;
      userApiKey?: string;
      timeoutMs?: number;
      headers?: Record<string, string>;
    }
  ): {
    url: string;
    methodUpper: string;
    headers: Record<string, string>;
    resolvedBody?: BodyInit;
    effectiveTimeout: number;
  } {
    const {
      method = "GET",
      body,
      bodyMode = "json",
      bodySerializer,
      accept,
      asUser,
      userApiKey,
      timeoutMs,
      headers: extraHeaders = {},
    } = options;
    const url = this.buildUrl(path);
    const methodUpper = method.toUpperCase();
    const effectiveTimeout =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : this.defaultTimeoutMs;

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (value === undefined || value === null) continue;
      headers[key] = String(value);
    }
    const headerExists = (name: string) => hasHeader(headers, name);

    if (!headerExists("Accept")) {
      if (accept === null) {
        // omit Accept entirely
      } else {
        headers.Accept = accept ?? "application/json";
      }
    }

    if (this.userAgent && !headerExists("User-Agent")) {
      headers["User-Agent"] = this.userAgent;
    }

    const hasUserApiKeyHeader = headerExists("User-Api-Key");
    const usingUserApiKey = !!userApiKey || hasUserApiKeyHeader;

    if (usingUserApiKey) {
      if (userApiKey && !hasUserApiKeyHeader) {
        headers["User-Api-Key"] = userApiKey;
      }
      if (this.userApiClientId && !headerExists("User-Api-Client-Id")) {
        headers["User-Api-Client-Id"] = this.userApiClientId;
      }
    } else {
      if (!headerExists("Api-Key")) {
        headers["Api-Key"] = this.systemApiKey;
      }
      if (!headerExists("Api-Username")) {
        headers["Api-Username"] = asUser || this.systemUsername;
      }
    }

    const isFormData =
      typeof FormData !== "undefined" && body instanceof FormData;
    const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
    const isArrayBufferView = ArrayBuffer.isView(body as any);
    const isArrayBuffer = body instanceof ArrayBuffer;
    const shouldSerializeJson =
      body !== undefined &&
      bodySerializer === undefined &&
      bodyMode === "json" &&
      !isFormData &&
      !isBlob &&
      !isArrayBuffer &&
      !isArrayBufferView &&
      typeof body !== "string";

    const resolvedBody =
      body === undefined
        ? undefined
        : bodySerializer
        ? bodySerializer(body)
        : shouldSerializeJson
        ? JSON.stringify(body)
        : (body as BodyInit);

    if (shouldSerializeJson && !headerExists("Content-Type")) {
      headers["Content-Type"] = "application/json";
    }

    return { url, methodUpper, headers, resolvedBody, effectiveTimeout };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<{ response: Response; cleanup: () => void }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const cleanup = () => clearTimeout(timeoutId);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { response, cleanup };
    } catch (error) {
      cleanup();
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  private async parseResponse<T>(params: {
    response: Response;
    cleanup: () => void;
    url: string;
    method: string;
  }): Promise<T | undefined> {
    const { response, cleanup, url, method } = params;
    const headersGet =
      typeof (response as any)?.headers?.get === "function"
        ? (response as any).headers.get.bind((response as any).headers)
        : null;

    try {
      if (!response.ok) {
        let errorText: string;
        try {
          errorText = await response.text();
        } catch (readError) {
          errorText = `[body unavailable: ${formatError(readError)}]`;
        }

        const requestId = headersGet ? headersGet("x-request-id") : undefined;
        const retryAfterMs = parseRetryAfterHeader(headersGet ? headersGet("retry-after") : undefined);
        const bodySnippet = sanitizeSnippet(errorText);

        try {
          this.logger.error("Discourse API error", {
            path: url,
            status: response.status,
            method,
            body: bodySnippet,
            requestId,
            retryAfterMs,
          });
        } catch {
          // ignore logger errors to preserve the original API failure
        }

        throw new DiscourseApiError({
          status: response.status,
          path: url,
          method,
          bodySnippet,
          retryAfterMs,
          requestId: requestId || undefined,
        });
      }

      const rawContentLength = headersGet ? headersGet("content-length") : undefined;
      const normalizedContentLength =
        typeof rawContentLength === "string"
          ? rawContentLength.trim().toLowerCase()
          : undefined;
      if (normalizedContentLength === "0") {
        return undefined;
      }

      const contentType = headersGet ? headersGet("content-type") : undefined;
      const isJson =
        typeof contentType === "string" &&
        /json/i.test(contentType);

      const hasText = typeof (response as any).text === "function";
      if (hasText) {
        let text: string;
        try {
          text = await (response as any).text();
        } catch (error) {
          throw new Error(
            `Failed to read response body: ${
              formatError(error)
            }`
          );
        }

        if (!text || String(text).trim().length === 0) {
          return undefined;
        }
        if (!isJson) {
          return text as unknown as T;
        }

        try {
          return JSON.parse(text) as T;
        } catch (error) {
          const snippet = sanitizeSnippet(text, 200);
          throw new Error(
            `Failed to parse JSON from ${url}: ${formatError(error)} | body snippet: ${snippet}`
          );
        }
      }

      if (typeof (response as any).json === "function") {
        return ((await (response as any).json()) as T) ?? undefined;
      }

      return undefined;
    } finally {
      cleanup();
    }
  }

  private async fetchApi<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      bodyMode?: "json" | "raw";
      bodySerializer?: (body: unknown) => BodyInit;
      accept?: string | null;
      asUser?: string;
      userApiKey?: string;
      timeoutMs?: number;
      headers?: Record<string, string>;
    } = {}
  ): Promise<T | undefined> {
    const { methodUpper, url, headers, resolvedBody, effectiveTimeout } = this.buildRequest(
      path,
      options
    );
    return this.runWithRetry<T>(
      async (attempt) => {
        const start = Date.now();
        try {
          const { response, cleanup } = await this.fetchWithTimeout(
            url,
            {
              method: methodUpper,
              headers,
              body: resolvedBody,
            },
            effectiveTimeout
          );

          const parsed = await this.parseResponse<T>({
            response,
            cleanup,
            url,
            method: methodUpper,
          });

          this.logRequest({
            url,
            method: methodUpper,
            attempt,
            durationMs: Date.now() - start,
            outcome: "success",
            status: response.status,
          });

          return parsed;
        } catch (error) {
          this.logRequest({
            url,
            method: methodUpper,
            attempt,
            durationMs: Date.now() - start,
            outcome: "fail",
            error,
            status: error instanceof DiscourseApiError ? error.status : undefined,
          });
          throw error;
        }
      },
      { url, method: methodUpper }
    );
  }

  private async requestCurrentUser(userApiKey: string) {
    return this.fetchApi<CurrentUserResponse>("/session/current.json", { userApiKey });
  }

  private async requestCategory(idOrSlug: number | string) {
    return this.fetchApi<CategoryShowResponse>(`/c/${idOrSlug}/show.json`);
  }

  private buildTopicListPath(basePath: string, query: Record<string, string | number | undefined>) {
    const queryString = this.buildQuery(query);
    return queryString ? `${basePath}?${queryString}` : basePath;
  }

  private async requestTopicList(path: string) {
    return this.fetchApi<TopicListResponse>(path);
  }

  private async requestTopic(topicId: number) {
    return this.fetchApi<any>(`/t/${topicId}.json`);
  }

  private async requestPost(postId: number) {
    return this.fetchApi<any>(`/posts/${postId}.json`);
  }

  private async requestPostReplies(postId: number) {
    return this.fetchApi<any[]>(`/posts/${postId}/replies.json`);
  }

  private buildSearchPath(params: {
    query: string;
    category?: string;
    username?: string;
    tags?: string[];
    before?: string;
    after?: string;
    order?: string;
    status?: string;
    in?: string;
    page?: number;
  }) {
    let searchQuery = params.query.trim();

    if (params.category) searchQuery += ` #${params.category}`;
    if (params.username) searchQuery += ` @${params.username}`;
    if (params.tags?.length) searchQuery += ` tags:${params.tags.join(",")}`;
    if (params.before) searchQuery += ` before:${params.before}`;
    if (params.after) searchQuery += ` after:${params.after}`;
    if (params.order) searchQuery += ` order:${params.order}`;
    if (params.status) searchQuery += ` status:${params.status}`;
    if (params.in) searchQuery += ` in:${params.in}`;

    searchQuery = searchQuery.replace(/\s+/g, " ").trim();
    const page = normalizePage(params.page, 1);

    const queryParams = new URLSearchParams({
      q: searchQuery,
      page: page.toString(),
    });

    return { path: `/search.json?${queryParams}`, page };
  }

  private async requestSearch(params: {
    query: string;
    category?: string;
    username?: string;
    tags?: string[];
    before?: string;
    after?: string;
    order?: string;
    status?: string;
    in?: string;
    page?: number;
  }) {
    const { path, page } = this.buildSearchPath(params);
    const data = await this.fetchApi<SearchResponse>(path);
    return { data, page };
  }

  private normalizeRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
    const policy = { ...DEFAULT_RETRY_POLICY, ...overrides };
    const ensure = (value: number, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    return {
      maxRetries: ensure(policy.maxRetries, DEFAULT_RETRY_POLICY.maxRetries),
      baseDelayMs: ensure(policy.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs),
      maxDelayMs: ensure(policy.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs),
      jitterRatio: ensure(policy.jitterRatio, DEFAULT_RETRY_POLICY.jitterRatio),
    };
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof DiscourseApiError) {
      return error.status === 429 || error.status >= 500 || error.status === 503;
    }
    // Retry generic transport failures (network/timeout/unknown) to improve resilience
    return true;
  }

  private computeDelayMs(error: unknown, attempt: number): number {
    if (error instanceof DiscourseApiError && typeof error.retryAfterMs === "number") {
      return Math.min(Math.max(0, error.retryAfterMs), this.retryPolicy.maxDelayMs);
    }
    const base = this.retryPolicy.baseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(base, this.retryPolicy.maxDelayMs);
    const jitter = capped * this.retryPolicy.jitterRatio;
    const randomOffset = (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(capped + randomOffset));
  }

  private async runWithRetry<T>(
    fn: (attempt: number) => Promise<T | undefined>,
    meta: { url: string; method: string }
  ): Promise<T | undefined> {
    let attempt = 0;
    // attempt includes initial call; retries decrement from maxRetries
    while (true) {
      try {
        return await fn(attempt);
      } catch (error) {
        const canRetry = attempt < this.retryPolicy.maxRetries && this.shouldRetry(error);
        if (!canRetry) {
          throw error;
        }

        const delayMs = this.computeDelayMs(error, attempt);
        this.logRequest({
          url: meta.url,
          method: meta.method,
          attempt: attempt + 1,
          durationMs: undefined,
          outcome: "retry",
          status: (error as DiscourseApiError).status,
          retryDelayMs: delayMs,
        });

        await this.sleep(delayMs);
        attempt += 1;
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logRequest(params: {
    url: string;
    method: string;
    attempt: number;
    durationMs?: number;
    outcome: "success" | "retry" | "fail";
    status?: number;
    error?: unknown;
    retryDelayMs?: number;
  }) {
    const payload = {
      path: params.url,
      method: params.method,
      attempt: params.attempt,
      durationMs: params.durationMs,
      status: params.status,
      retryDelayMs: params.retryDelayMs,
      error: params.error ? serializeError(params.error) : undefined,
      outcome: params.outcome,
    };

    try {
      if (params.outcome === "success") {
        this.logger.debug?.("Discourse request completed", payload);
      } else if (params.outcome === "retry") {
        this.logger.warn?.("Discourse request retrying", payload);
      } else {
        this.logger.error?.("Discourse request failed", payload);
      }
    } catch {
      // swallow logger errors
    }
  }

  generateAuthUrl(params: {
    clientId: string;
    applicationName: string;
    nonce: string;
    publicKey: string;
  }) {
    return Effect.try(() => {
      const publicKeyEncoded = encodeURIComponent(params.publicKey);
      const queryParams = [
        `client_id=${encodeURIComponent(params.clientId)}`,
        `application_name=${encodeURIComponent(params.applicationName)}`,
        `nonce=${encodeURIComponent(params.nonce)}`,
        `scopes=${encodeURIComponent("read,write")}`,
        `public_key=${publicKeyEncoded}`,
      ].join("&");

      const authPath = this.buildUrl("/user-api-key/new");
      return `${authPath}?${queryParams}`;
    });
  }

  getCurrentUser(userApiKey: string) {
    return runWithContext("Get user", async () => {
      const data = await this.requestCurrentUser(userApiKey);

      if (!data || !data.current_user) {
        throw new Error("Empty or invalid user response");
      }

      const user = data.current_user;

      const mapped = this.mapUserSummary(user);

      return {
        id: mapped.id,
        username: mapped.username,
        name: mapped.name,
      };
    });
  }

  createPost(params: {
    title?: string;
    raw: string;
    category?: number;
    username: string;
    topicId?: number;
    replyToPostNumber?: number;
  }) {
    return runWithContext("Create post", async () => {
      const data = await this.fetchApi<{
        id: number;
        topic_id: number;
        topic_slug: string;
      }>("/posts.json", {
        method: "POST",
        asUser: params.username,
        body: {
          title: params.title,
          raw: params.raw,
          category: params.category,
          topic_id: params.topicId,
          reply_to_post_number: params.replyToPostNumber,
        },
      });

      if (!data) {
        throw new Error("Empty response from create post");
      }

      return {
        id: data.id as number,
        topic_id: data.topic_id as number,
        topic_slug: data.topic_slug as string,
      };
    });
  }

  getCategories() {
    return runWithContext("Get categories", async () => {
      const data = await this.fetchApi<{ category_list: { categories: any[] } }>(
        "/categories.json"
      );
      if (!data) {
        return [];
      }
      const categories = data.category_list?.categories;
      if (!Array.isArray(categories)) {
        throw new Error("Malformed category response");
      }
      return categories.map((cat: unknown) => this.mapCategory(cat));
    });
  }

  getCategory(idOrSlug: number | string) {
    return runWithContext("Get category", async () => {
      const data = await this.requestCategory(idOrSlug);
      if (!data) {
        throw new Error("Empty category response");
      }
      const subcategoriesSource = Array.isArray(data.subcategory_list)
        ? data.subcategory_list
        : Array.isArray((data.subcategory_list as any)?.categories)
        ? (data.subcategory_list as any).categories
        : [];
      return {
        category: this.mapCategory(data.category),
        subcategories: subcategoriesSource.map((cat: unknown) =>
          this.mapCategory(cat)
        ),
      };
    });
  }

  getTopic(topicId: number) {
    return runWithContext("Get topic", async () => {
      const data = await this.requestTopic(topicId);
      if (!data) {
        throw new Error("Empty topic response");
      }
      return this.mapTopic(data);
    });
  }

  getLatestTopics(
    params: { categoryId?: number; page?: number; order?: string }
  ): Effect.Effect<PaginatedTopics, Error> {
    return runWithContext("Get latest topics", async () => {
      const page = normalizePage(params.page, 0);

      const pageParam = page > 0 ? page : undefined;
      const orderParam =
        params.order && params.order !== "default" ? params.order : undefined;
      /* c8 ignore start */
      const basePath =
        params.categoryId != null
          ? `/c/${params.categoryId}/l/latest.json`
          : "/latest.json";
      /* c8 ignore stop */

      const path = this.buildTopicListPath(basePath, {
        page: pageParam,
        order: orderParam,
      });

      const data = await this.requestTopicList(path);
      const hasMore = !!data?.topic_list?.more_topics_url;

      return {
        topics: data?.topic_list?.topics?.map((t: any) => this.mapTopic(t)) ?? [],
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      };
    });
  }

  getTopTopics(
    params: { period: string; categoryId?: number; page?: number }
  ): Effect.Effect<PaginatedTopics, Error> {
    return runWithContext("Get top topics", async () => {
      const page = normalizePage(params.page, 0);
      const pageParam = page > 0 ? page : undefined;
      /* c8 ignore start */
      const basePath = params.categoryId
        ? `/c/${params.categoryId}/l/top/${params.period}.json`
        : `/top/${params.period}.json`;
      /* c8 ignore stop */

      const path = this.buildTopicListPath(basePath, {
        page: pageParam,
      });

      const data = await this.requestTopicList(path);
      const hasMore = !!data?.topic_list?.more_topics_url;

      return {
        topics: data?.topic_list?.topics?.map((t: any) => this.mapTopic(t)) ?? [],
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      };
    });
  }

  private mapCategory(cat: any): Category {
    const parsed = parseWithSchemaOrThrow(
      RawCategorySchema,
      cat,
      "Category",
      "Malformed category response"
    );
    return {
      id: parsed.id,
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description,
      color: parsed.color,
      topicCount: parsed.topic_count,
      postCount: parsed.post_count,
      parentCategoryId: parsed.parent_category_id,
      readRestricted: parsed.read_restricted,
    };
  }

  private mapTopic(topic: any): Topic {
    const parsed = parseWithSchemaOrThrow(
      RawTopicSchema,
      topic,
      "Topic",
      "Malformed topic response"
    );
    return {
      id: parsed.id,
      title: parsed.title,
      slug: parsed.slug,
      categoryId: parsed.category_id,
      createdAt: parsed.created_at,
      lastPostedAt: parsed.last_posted_at,
      postsCount: parsed.posts_count,
      replyCount: parsed.reply_count,
      likeCount: parsed.like_count,
      views: parsed.views,
      pinned: parsed.pinned,
      closed: parsed.closed,
      archived: parsed.archived,
      visible: parsed.visible,
    };
  }

  private mapUserSummary(user: any): UserSummary {
    const parsed = parseWithSchemaOrThrow(
      RawUserSummarySchema,
      user,
      "User",
      "Malformed user response"
    );
    return {
      id: parsed.id,
      username: parsed.username,
      name: parsed.name,
      avatarTemplate: parsed.avatar_template,
      title: parsed.title,
      trustLevel: parsed.trust_level,
      moderator: parsed.moderator,
      admin: parsed.admin,
    };
  }

  private mapUserProfile(user: any): UserProfile {
    const parsed = parseWithSchemaOrThrow(
      RawUserProfileSchema,
      user,
      "User profile",
      "Malformed user response"
    );
    const summary = this.mapUserSummary(parsed);

    return {
      ...summary,
      createdAt: parsed.created_at,
      lastPostedAt: parsed.last_posted_at,
      lastSeenAt: parsed.last_seen_at,
      postCount: parsed.post_count,
      badgeCount: parsed.badge_count,
      profileViewCount: parsed.profile_view_count,
    };
  }

  getPost(postId: number, includeRaw: boolean = false) {
    return runWithContext("Get post", async () => {
      const postData = await this.requestPost(postId);
      if (!postData) {
        throw new Error("Empty post response");
      }
      const post = this.mapPost(postData, includeRaw);

      const topicData = await this.requestTopic(postData.topic_id);
      if (!topicData) {
        throw new Error("Empty topic response");
      }
      const topic = this.mapTopic(topicData);

      return { post, topic };
    });
  }

  getPostReplies(postId: number) {
    return runWithContext("Get post replies", async () => {
      const data = await this.requestPostReplies(postId);
      return (data ?? []).map((p: any) => this.mapPost(p, false));
    });
  }

  getUser(username: string) {
    return runWithContext("Get user", async () => {
      const data = await this.fetchApi<{ user: any }>(`/u/${username}.json`);
      if (!data) {
        throw new Error("Empty user response");
      }
      const u = data.user;
      const mapped = this.mapUserProfile(u);
      return mapped;
    });
  }

  private mapPost(post: any, includeRaw: boolean): Post {
    const parsed = parseWithSchemaOrThrow(
      RawPostSchema,
      post,
      "Post",
      "Malformed post response"
    );
    if (includeRaw && typeof parsed.raw !== "string") {
      throw new Error("Post validation failed: raw is required when includeRaw is true");
    }

    return {
      id: parsed.id,
      topicId: parsed.topic_id,
      postNumber: parsed.post_number,
      username: parsed.username,
      name: parsed.name,
      avatarTemplate: parsed.avatar_template,
      raw: includeRaw ? parsed.raw : undefined,
      cooked: parsed.cooked,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
      replyCount: parsed.reply_count,
      likeCount: parsed.like_count,
      replyToPostNumber: parsed.reply_to_post_number,
      canEdit: parsed.can_edit,
      version: parsed.version,
    };
  }

  private mapSearchPost(post: any): SearchPost {
    const parsed = RawSearchPostSchema.parse(post);

    const topicTitle =
      typeof post?.topic?.title === "string"
        ? post.topic.title
        : typeof post?.topic_title_headline === "string"
          ? post.topic_title_headline
          : "";

    return {
      id: parsed.id,
      topicId: parsed.topic_id,
      postNumber: parsed.post_number,
      username: parsed.username,
      name: parsed.name,
      avatarTemplate: parsed.avatar_template,
      raw: typeof parsed.raw === "string" ? parsed.raw : undefined,
      cooked: parsed.cooked,
      createdAt: parsed.created_at,
      updatedAt: parsed.updated_at,
      replyCount: parsed.reply_count,
      likeCount: parsed.like_count,
      replyToPostNumber: parsed.reply_to_post_number,
      canEdit: parsed.can_edit,
      version: parsed.version,
      topicTitle,
      blurb: parsed.blurb,
    };
  }

  validateUserApiKey(userApiKey: string) {
    return Effect.tryPromise(async () => {
      try {
        if (typeof userApiKey !== "string" || !userApiKey.trim()) {
          return {
            valid: false as const,
            error: "API key invalid: User API key is required",
            retryable: false as const,
          };
        }

        try {
          const data = await this.fetchApi<{ current_user: any }>(
            "/session/current.json",
            { userApiKey }
          );

          if (!data || !data.current_user) {
            return {
              valid: false as const,
              error: "Invalid response: no current_user",
              retryable: false as const,
            };
          }

          const user = data.current_user;

          let mapped: UserSummary;
          try {
            mapped = this.mapUserSummary(user);
          } catch {
            return {
              valid: false as const,
              error: "Invalid response: malformed current_user",
              retryable: false as const,
            };
          }

          return {
            valid: true as const,
            user: mapped,
          };
        } catch (error) {
          return {
            valid: false as const,
            error: `API key invalid: ${formatError(error)}`,
            retryable: isRetryableValidationError(error),
          };
        }
      } catch (error) {
        return {
          valid: false as const,
          error: `Validation failed: ${formatError(error)}`,
          retryable: true as const,
        };
      }
    });
  }

  editPost(params: {
    postId: number;
    raw: string;
    username: string;
    editReason?: string;
  }) {
    return runWithContext("Edit post", async () => {
      const data = await this.fetchApi<{ post: any }>(
        `/posts/${params.postId}.json`,
        {
          method: "PUT",
          asUser: params.username,
          body: {
            post: {
              raw: params.raw,
              edit_reason: params.editReason,
            },
          },
        }
      );

      if (!data) {
        throw new Error("Empty edit response");
      }

      return {
        id: data.post.id as number,
        topicId: data.post.topic_id as number,
        topicSlug: data.post.topic_slug as string,
        postUrl: data.post.post_url as string | undefined,
      };
    });
  }

  search(params: {
    query: string;
    category?: string;
    username?: string;
    tags?: string[];
    before?: string;
    after?: string;
    order?: string;
    status?: string;
    in?: string;
    page?: number;
  }) {
    return runWithContext("Search", async () => {
      const { data, page } = await this.requestSearch(params);
      const safeData = data ?? {};
      const posts = (safeData.posts ?? []).map((p: any) => this.mapSearchPost(p));

      const users = (safeData.users ?? [])
        .filter(
          (u: any) => u && typeof u.id === "number" && typeof u.username === "string"
        )
        .map((u: any) => this.mapUserSummary(u));

      return {
        posts,
        topics: (safeData.topics ?? []).map((t: any) => this.mapTopic(t)),
        users,
        categories: (safeData.categories ?? []).map((c: any) => this.mapCategory(c)),
        totalResults: safeData.grouped_search_result?.post_ids?.length ?? 0,
        hasMore: !!safeData.grouped_search_result?.more_full_page_results,
      } satisfies SearchResult;
    });
  }

  async checkHealth(options: { timeoutMs?: number } = {}): Promise<boolean> {
    const timeoutMs =
      typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : Math.min(this.defaultTimeoutMs, 2000);

    const probes: Array<{ path: string; method: string; accept: string | null }> = [
      { path: "/site/status", method: "HEAD", accept: null },
      { path: "/site/status", method: "GET", accept: null },
      { path: "/site.json", method: "GET", accept: "application/json" },
    ];

    for (const probe of probes) {
      try {
        await this.fetchApi<void>(probe.path, {
          method: probe.method,
          accept: probe.accept,
          timeoutMs,
        });
        return true;
      } catch {
        // try next probe
      }
    }

    return false;
  }
}

/**
 * CryptoService - Handles RSA key generation and decryption
 */
export class CryptoService {
  private readonly minCiphertextBytes: number;
  private readonly maxCiphertextBytes: number;

  constructor(
    private readonly decryptFn = privateDecrypt,
    options: { minCiphertextBytes?: number; maxCiphertextBytes?: number } = {}
  ) {
    const min = options.minCiphertextBytes;
    const max = options.maxCiphertextBytes;
    this.minCiphertextBytes =
      typeof min === "number" && Number.isFinite(min) && min > 0 ? min : 64;
    this.maxCiphertextBytes =
      typeof max === "number" && Number.isFinite(max) && max > this.minCiphertextBytes
        ? max
        : 1024;
  }

  generateKeyPair() {
    return Effect.try(() => {
      const { publicKey, privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      return { publicKey, privateKey };
    });
  }

  /**
   * Decrypts a payload that was encrypted with the matching public key using
   * RSA_PKCS1_PADDING. Callers must encrypt with the same padding and a 2048-bit
   * key; ciphertext must be base64-encoded PKCS#1 v1.5 block containing JSON
   * with a `key` field.
   */
  decryptPayload(encryptedPayload: string, privateKey: string) {
    return Effect.tryPromise({
      try: async () => {
        const normalizedPayload = encryptedPayload.trim();
        const maxBase64Length = Math.ceil(this.maxCiphertextBytes / 3) * 4;

        if (normalizedPayload.length > maxBase64Length) {
          throw new Error("invalid base64: unexpected length");
        }

        let decoded: Buffer;
        try {
          decoded = Buffer.from(normalizedPayload, "base64");
        } catch (error) {
          throw new Error(
            `invalid base64: ${formatError(error)}`
          );
        }

        if (decoded.length === 0) {
          throw new Error("invalid base64: empty payload");
        }

        if (
          decoded.length < this.minCiphertextBytes ||
          decoded.length > this.maxCiphertextBytes
        ) {
          throw new Error("invalid ciphertext: unexpected length");
        }

        let decrypted: Buffer;
        try {
          decrypted = this.decryptFn(
            {
              key: privateKey,
              padding: constants.RSA_PKCS1_PADDING,
            },
            decoded
          );
        } catch (error) {
          throw new Error(
            `invalid ciphertext: ${formatError(error)}`
          );
        }

        let data: any;
        try {
          data = JSON.parse(decrypted.toString("utf-8"));
        } catch (error) {
          throw new Error(
            `invalid JSON: ${formatError(error)}`
          );
        }

        if (typeof data.key !== "string" || !data.key.trim()) {
          throw new Error("Decryption produced empty result");
        }

        const key = data.key.trim();
        return key;
      },
      catch: (error: unknown) =>
        new Error(
          `Decrypt failed: ${
            formatError(error)
          }`
        ),
    });
  }
}

/**
 * NEARService - Handles NEAR signature verification
 */
export class NEARService {
  constructor(private readonly recipient: string) {}

  verifySignature(authToken: string, nonceMaxAge: number = 600000) {
    return Effect.tryPromise({
      try: async () => {
        const result = await verify(authToken, {
          expectedRecipient: this.recipient,
          nonceMaxAge,
        });

        if (!result || typeof (result as any).accountId !== "string" || !result.accountId) {
          throw new Error("Missing accountId in verification result");
        }

        return result.accountId;
      },
      catch: (error: unknown) =>
        new Error(
          `NEAR verification failed: ${
            formatError(error)
          }`
        ),
    });
  }
}

export class NonceCapacityError extends Error {
  readonly limitType: "client" | "global";
  readonly limit: number;
  readonly clientId?: string;

  constructor(params: { limitType: "client" | "global"; limit: number; clientId?: string }) {
    const scope = params.limitType === "client" ? `client ${params.clientId ?? "unknown"}` : "global";
    super(`Nonce capacity exceeded (${scope} limit: ${params.limit})`);
    this.name = "NonceCapacityError";
    this.limitType = params.limitType;
    this.limit = params.limit;
    this.clientId = params.clientId;
  }
}

export type NonceManagerOptions = {
  ttlMs?: number;
  maxPerClient?: number;
  maxTotal?: number;
  limitStrategy?: {
    perClient?: "rejectNew" | "evictOldest";
    global?: "rejectNew" | "evictOldest";
  };
};

const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT_STRATEGY = {
  perClient: "rejectNew" as const,
  global: "rejectNew" as const,
};

/**
 * NonceManager - Manages temporary nonces with private keys
 */
export class NonceManager {
  private nonces = new Map<
    string,
    { clientId: string; privateKey: string; timestamp: number }
  >();
  private readonly ttl: number;
  private readonly maxPerClient?: number;
  private readonly maxTotal?: number;
  private readonly perClientStrategy: "rejectNew" | "evictOldest";
  private readonly globalStrategy: "rejectNew" | "evictOldest";
  private isExpired = (timestamp: number) => Date.now() - timestamp > this.ttl;
  private normalizeClientIdOrNull(value?: string): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized.length ? normalized : null;
  }

  private normalizeClientId(value: string): string {
    const normalized = this.normalizeClientIdOrNull(value);
    if (!normalized) {
      throw new Error("clientId is required");
    }
    return normalized;
  }

  private normalizePrivateKey(value: string): string {
    if (typeof value !== "string") {
      throw new Error("privateKey is required");
    }
    const normalized = value.trim();
    if (!normalized) {
      throw new Error("privateKey is required");
    }
    return normalized;
  }

  constructor(ttlMs?: number);
  constructor(options: NonceManagerOptions);
  constructor(ttlMsOrOptions: number | NonceManagerOptions = DEFAULT_NONCE_TTL_MS) {
    const {
      ttlMs = DEFAULT_NONCE_TTL_MS,
      maxPerClient,
      maxTotal,
      limitStrategy,
    } = typeof ttlMsOrOptions === "object" ? ttlMsOrOptions : { ttlMs: ttlMsOrOptions };

    this.ttl = this.normalizeTtl(ttlMs);
    this.maxPerClient = this.normalizeLimit(maxPerClient);
    this.maxTotal = this.normalizeLimit(maxTotal);
    this.perClientStrategy = limitStrategy?.perClient ?? DEFAULT_LIMIT_STRATEGY.perClient;
    this.globalStrategy = limitStrategy?.global ?? DEFAULT_LIMIT_STRATEGY.global;
  }

  create(clientId: string, privateKey: string): string {
    this.cleanup();
    const normalizedClientId = this.normalizeClientId(clientId);
    const normalizedPrivateKey = this.normalizePrivateKey(privateKey);
    this.ensureCapacity(normalizedClientId);
    const nonce = randomBytes(32).toString("hex");
    this.nonces.set(nonce, {
      clientId: normalizedClientId,
      privateKey: normalizedPrivateKey,
      timestamp: Date.now(),
    });
    return nonce;
  }

  get(
    nonce: string
  ): { clientId: string; privateKey: string; timestamp: number } | null {
    const data = this.nonces.get(nonce);
    if (!data) return null;
    if (this.isExpired(data.timestamp)) {
      this.nonces.delete(nonce);
      return null;
    }
    return data;
  }

  verify(nonce: string, clientId: string): boolean {
    const data = this.nonces.get(nonce);
    if (!data) return false;
    if (this.isExpired(data.timestamp)) {
      this.nonces.delete(nonce);
      return false;
    }
    const normalizedClientId = this.normalizeClientIdOrNull(clientId);
    if (!normalizedClientId) {
      return false;
    }
    return data.clientId === normalizedClientId;
  }

  getPrivateKey(nonce: string): string | null {
    return this.get(nonce)?.privateKey || null;
  }

  getExpiration(nonce: string): number | null {
    const data = this.get(nonce);
    if (!data) return null;
    return data.timestamp + this.ttl;
  }

  getNextExpiration(clientId?: string): number | null {
    this.cleanup();
    const normalizedClientId = this.normalizeClientIdOrNull(clientId);
    let next: number | null = null;
    for (const [nonce, data] of this.nonces.entries()) {
      if (this.isExpired(data.timestamp)) {
        this.nonces.delete(nonce);
        continue;
      }
      if (normalizedClientId && data.clientId !== normalizedClientId) {
        continue;
      }
      const expiration = data.timestamp + this.ttl;
      if (next === null || expiration < next) {
        next = expiration;
      }
    }
    return next;
  }

  getRetryAfterMs(clientId?: string): number | null {
    const nextExpiration = this.getNextExpiration(
      clientId ? this.normalizeClientIdOrNull(clientId) ?? undefined : undefined
    );
    if (nextExpiration === null) {
      return null;
    }
    return Math.max(0, nextExpiration - Date.now());
  }

  consume(nonce: string): void {
    this.nonces.delete(nonce);
  }

  cleanup(): void {
    for (const [nonce, data] of this.nonces.entries()) {
      if (this.isExpired(data.timestamp)) {
        this.nonces.delete(nonce);
      }
    }
  }

  private normalizeTtl(ttlMs: number): number {
    return typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
      ? ttlMs
      : DEFAULT_NONCE_TTL_MS;
  }

  private normalizeLimit(limit?: number): number | undefined {
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
  }

  private countByClient(clientId: string): number {
    let count = 0;
    for (const entry of this.nonces.values()) {
      if (entry.clientId === clientId) {
        count += 1;
      }
    }
    return count;
  }

  private evictOldest(predicate: (entry: { clientId: string; timestamp: number }) => boolean): boolean {
    let oldestNonce: string | null = null;
    let oldestTimestamp: number | null = null;

    for (const [nonce, data] of this.nonces.entries()) {
      if (!predicate(data)) {
        continue;
      }
      if (oldestTimestamp === null || data.timestamp < oldestTimestamp) {
        oldestNonce = nonce;
        oldestTimestamp = data.timestamp;
      }
    }

    if (oldestNonce) {
      this.nonces.delete(oldestNonce);
      return true;
    }

    return false;
  }

  private evictForClient(clientId: string, maxCount: number): boolean {
    if (maxCount < 0) return false;

    let evicted = false;
    while (this.countByClient(clientId) > maxCount) {
      if (!this.evictOldest((entry) => entry.clientId === clientId)) {
        break;
      }
      evicted = true;
    }
    return evicted;
  }

  private evictGlobally(maxCount: number): boolean {
    if (maxCount < 0) return false;

    let evicted = false;
    while (this.nonces.size > maxCount) {
      if (!this.evictOldest(() => true)) {
        break;
      }
      evicted = true;
    }

    return evicted;
  }

  private ensureCapacity(clientId: string): void {
    if (this.maxPerClient !== undefined) {
      if (this.countByClient(clientId) >= this.maxPerClient) {
        const evicted = this.evictForClient(clientId, this.maxPerClient - 1);
        if (this.perClientStrategy === "evictOldest" && evicted) {
          // allow replacement after eviction
        } else {
          throw new NonceCapacityError({
            limitType: "client",
            limit: this.maxPerClient,
            clientId,
          });
        }
      }
    }

    if (this.maxTotal !== undefined) {
      if (this.nonces.size >= this.maxTotal) {
        const evicted = this.evictGlobally(this.maxTotal - 1);
        if (this.globalStrategy === "evictOldest" && evicted) {
          // allow replacement after eviction
        } else {
          throw new NonceCapacityError({
            limitType: "global",
            limit: this.maxTotal,
          });
        }
      }
    }
  }
}

/**
 * LinkageStore - Stores NEAR account to Discourse user mappings
 */
export class LinkageStore {
  private linkages = new Map<string, StoredLinkage>();
  private normalizeAccount(nearAccount: string): string {
    return nearAccount.trim().toLowerCase();
  }

  set(nearAccount: string, linkage: StoredLinkage): void {
    const key = this.normalizeAccount(nearAccount);
    this.linkages.set(key, { ...linkage, nearAccount: key });
  }

  get(nearAccount: string): StoredLinkage | null {
    const stored = this.linkages.get(this.normalizeAccount(nearAccount));
    return stored ? { ...stored } : null;
  }

  getAll(): StoredLinkage[] {
    return Array.from(this.linkages.values()).map((linkage) => ({ ...linkage }));
  }

  remove(nearAccount: string): boolean {
    return this.linkages.delete(this.normalizeAccount(nearAccount));
  }
}
