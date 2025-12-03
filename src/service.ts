import { Effect } from "every-plugin/effect";
import { randomBytes, generateKeyPairSync, privateDecrypt, constants } from "crypto";
import { formatError, serializeError } from "./utils";
import { DEFAULT_BODY_SNIPPET_LENGTH, TRANSIENT_STATUSES } from "./constants";
import { z } from "every-plugin/zod";

// Import types from contract
import type {
  AdminUser,
  Category,
  DirectoryItem,
  DiscourseUser,
  PaginatedTopics,
  Post,
  PostActionResult,
  SearchPost,
  SearchResult,
  Tag,
  TagGroup,
  Topic,
  UserProfile,
  Revision,
  TopicNotificationLevel,
  UserStatus,
} from "./contract";
import { normalizeTopicNotificationLevel } from "./contract";

// Internal storage types
type UserSummary = DiscourseUser;
type TopicListResponse = { topic_list?: { topics?: any[]; more_topics_url?: string | null } };
type CategoryShowResponse = {
  category: any;
  subcategory_list?: any[] | { categories?: any[] };
};
type PostsListResponse = { latest_posts?: any[]; more_posts_url?: string | null };
type SiteBasicInfoResponse = { site?: any; categories?: any[] } & Record<string, unknown>;
type SiteInfoResponse = { site?: any; categories?: any[] } & Record<string, unknown>;
type CurrentUserResponse = { current_user?: any };
type SearchResponse = {
  posts?: any[];
  topics?: any[];
  users?: any[];
  categories?: any[];
  grouped_search_result?: {
    post_ids?: number[];
    more_full_page_results?: string | null;
  };
};
type AdminUsersResponse = any[];
type DirectoryResponse = {
  directory_items?: any[];
  meta?: { total_rows_directory_items?: number };
};

type RetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

export type OperationRetryPolicy = {
  default?: Partial<RetryPolicy>;
  reads?: Partial<RetryPolicy>;
  writes?: Partial<RetryPolicy>;
};

export type Upload = {
  id: number;
  url: string;
  shortUrl?: string;
  originalFilename?: string;
  filesize?: number;
  humanFileSize?: string;
  extension?: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
};

export type UploadRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  fields: Record<string, string>;
};

export type PresignedUpload = {
  method: "PUT";
  uploadUrl: string;
  headers: Record<string, string>;
  key: string;
  uniqueIdentifier: string;
};

export type MultipartPresign = {
  uploadId: string;
  key: string;
  uniqueIdentifier: string;
  parts: Array<{
    partNumber: number;
    url: string;
    headers: Record<string, string>;
  }>;
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

export type RequestLogEvent = {
  path: string;
  method: string;
  attempt: number;
  durationMs?: number;
  status?: number;
  retryDelayMs?: number;
  outcome: "success" | "retry" | "fail";
  error?: ReturnType<typeof serializeError>;
};

export type RequestLogger = (event: RequestLogEvent) => void;

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

const withReadTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs?: number,
  url: string = "response"
): Promise<T> => {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Reading response from ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
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

const RawTagSchema = z.object({
  id: z.number(),
  name: z.string(),
  topic_count: z.number().default(0),
  pm_topic_count: z.number().default(0),
  synonyms: z.array(z.string()).default([]),
  target_tag: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
});

const RawTagGroupSchema = z.object({
  id: z.number(),
  name: z.string(),
  tag_names: z.array(z.string()).default([]),
  parent_tag_names: z.array(z.string()).default([]),
  one_per_topic: z.boolean().default(false),
  permissions: z.record(z.string(), z.coerce.number()).default({}),
  tags: z.array(RawTagSchema).default([]),
});

const RawUploadSchema = z.object({
  id: z.number(),
  url: z.string(),
  short_url: z.string().optional(),
  short_path: z.string().optional(),
  original_filename: z.string().optional(),
  filesize: z.number().optional(),
  human_filesize: z.string().optional(),
  extension: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbnail_url: z.string().optional(),
});

const RawPresignedUploadSchema = z.object({
  key: z.string(),
  url: z.string().optional(),
  upload_url: z.string().optional(),
  headers: z.record(z.string(), z.any()).default({}),
  unique_identifier: z.string(),
});

const RawMultipartPresignSchema = z.object({
  upload_id: z.string(),
  key: z.string(),
  unique_identifier: z.string(),
  presigned_urls: z
    .array(
      z.object({
        part_number: z.number().int().positive(),
        url: z.string(),
        headers: z.record(z.string(), z.any()).default({}),
      })
    )
    .default([]),
});

const RawAbortUploadSchema = z.object({
  success: z.boolean().optional(),
  aborted: z.boolean().optional(),
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

const RawAdminUserSchema = RawUserSummarySchema.extend({
  email: z.string().email().optional(),
  active: z.boolean().default(false),
  last_seen_at: z.string().nullable().default(null),
  staged: z.boolean().default(false),
});

const RawDirectoryItemSchema = z.object({
  user: RawUserSummarySchema,
  likes_received: z.number().default(0),
  likes_given: z.number().default(0),
  topics_entered: z.number().default(0),
  posts_read: z.number().default(0),
  days_visited: z.number().default(0),
  topic_count: z.number().default(0),
  post_count: z.number().default(0),
});

const RawUserStatusSchema = z.object({
  emoji: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  ends_at: z.string().nullable().default(null),
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

const RawRevisionSchema = z
  .object({
    number: z.number().int().nonnegative(),
    post_id: z.number().int().positive(),
    user_id: z.number().int().positive().optional(),
    username: z.string().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
    raw: z.string().optional(),
    cooked: z.string().optional(),
    changes: z.record(z.string(), z.any()).optional(),
  })
  .passthrough();

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

const RawSiteDetailsSchema = z
  .preprocess((value) => (value && typeof value === "object" ? value : {}), z.object({
    title: z.string().default(""),
    description: z.string().nullable().default(null),
    logo_url: z.string().nullable().default(null),
    mobile_logo_url: z.string().nullable().default(null),
    favicon_url: z.string().nullable().default(null),
    contact_email: z.string().nullable().default(null),
    canonical_hostname: z.string().nullable().default(null),
    default_locale: z.string().nullable().default(null),
  }));

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
  if (!(error instanceof Error)) return true;

  const message = safeErrorMessage(error);
  if (!message) {
    return true;
  }
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes("failed to parse json") || lowerMessage.includes("validation failed")) {
    return false;
  }

  const code = (error as any).code;
  if (typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error.name === "FetchError") return true;
  if (error.name === "TypeError" && /fetch failed/i.test(message)) {
    return true;
  }
  if (/(network|timeout|temporar|transient|retry)/i.test(message)) {
    return true;
  }
  return false;
};

const isRetryableValidationError = (error: unknown): boolean => {
  if (error instanceof DiscourseApiError) {
    return TRANSIENT_STATUSES.has(error.status) || error.status >= 500;
  }
  return isTransportError(error);
};

const POST_ACTION_TYPE_MAP: Record<string, number> = {
  bookmark: 1,
  like: 2,
  unlike: 2,
  flag: 3,
  flag_off_topic: 3,
  flag_inappropriate: 4,
  flag_spam: 5,
  notify_user: 6,
  notify_moderators: 7,
  informative: 8,
  vote: 9,
};

const normalizeSuccessFlag = (value: unknown): boolean | undefined => {
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
    this.retryPolicies = this.buildRetryPolicies(
      this.retryPolicy,
      options.operationRetryPolicy
    );
    this.requestLogger = options.requestLogger;
    this.fetchImpl = options.fetchImpl;
    this.bodySnippetLength =
      typeof options.bodySnippetLength === "number" && options.bodySnippetLength >= 0
        ? options.bodySnippetLength
        : 500;
  }

  private readonly retryPolicy: RetryPolicy;
  private readonly retryPolicies: { default: RetryPolicy; reads: RetryPolicy; writes: RetryPolicy };
  private readonly requestLogger?: RequestLogger;
  private readonly fetchImpl?: typeof fetch;
  private readonly bodySnippetLength: number;

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

  private resolvePostActionType(
    action?: PostActionResult["action"],
    explicitTypeId?: number
  ): number {
    if (typeof explicitTypeId === "number" && Number.isFinite(explicitTypeId) && explicitTypeId > 0) {
      return Math.floor(explicitTypeId);
    }

    /* c8 ignore start */
    const normalizedAction =
      typeof action === "string" && action.trim()
        ? action.trim().toLowerCase()
        : undefined;

    if (normalizedAction) {
      const mapped = POST_ACTION_TYPE_MAP[normalizedAction];
      if (mapped) {
        return mapped;
      }
    }
    /* c8 ignore stop */

    throw new Error("Unsupported or missing post action type");
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
    const fetchFn = this.fetchImpl ?? fetch;
    try {
      const response = await fetchFn(url, { ...init, signal: controller.signal });
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
    readTimeoutMs?: number;
  }): Promise<T | undefined> {
    const { response, cleanup, url, method, readTimeoutMs } = params;
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
        const bodySnippet = sanitizeSnippet(errorText, this.bodySnippetLength);

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
          bodySnippetMaxLength: this.bodySnippetLength,
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
          text = await withReadTimeout(
            (response as any).text(),
            readTimeoutMs,
            url
          );
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
        const result = await withReadTimeout(
          (response as any).json(),
          readTimeoutMs,
          url
        );
        return (result as T) ?? undefined;
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
      retryPolicy?: Partial<RetryPolicy>;
      readTimeoutMs?: number;
    } = {}
  ): Promise<T | undefined> {
    const { methodUpper, url, headers, resolvedBody, effectiveTimeout } = this.buildRequest(path, options);
    const effectiveReadTimeout =
      typeof options.readTimeoutMs === "number" && Number.isFinite(options.readTimeoutMs)
        ? Math.max(0, options.readTimeoutMs)
        : effectiveTimeout;
    const retryPolicy = this.resolveRetryPolicy(methodUpper, options.retryPolicy);
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
            readTimeoutMs: effectiveReadTimeout,
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
      { url, method: methodUpper },
      retryPolicy
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
    userApiKey?: string;
  }) {
    const { path, page } = this.buildSearchPath(params);
    const data = await this.fetchApi<SearchResponse>(path, {
      userApiKey: params.userApiKey,
    });
    return { data, page };
  }

  private normalizeRetryPolicy(
    overrides?: Partial<RetryPolicy>,
    base: RetryPolicy = DEFAULT_RETRY_POLICY
  ): RetryPolicy {
    const policy = { ...base, ...overrides };
    const ensure = (value: number, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
    return {
      maxRetries: ensure(policy.maxRetries, base.maxRetries),
      baseDelayMs: ensure(policy.baseDelayMs, base.baseDelayMs),
      maxDelayMs: ensure(policy.maxDelayMs, base.maxDelayMs),
      jitterRatio: ensure(policy.jitterRatio, base.jitterRatio),
    };
  }

  private buildRetryPolicies(
    defaultPolicy: RetryPolicy,
    overrides?: OperationRetryPolicy
  ): { default: RetryPolicy; reads: RetryPolicy; writes: RetryPolicy } {
    const mergedDefault = this.normalizeRetryPolicy(overrides?.default, defaultPolicy);
    const mergedReads = this.normalizeRetryPolicy(overrides?.reads, mergedDefault);
    const mergedWrites = this.normalizeRetryPolicy(overrides?.writes, mergedDefault);
    return {
      default: mergedDefault,
      reads: mergedReads,
      writes: mergedWrites,
    };
  }

  private resolveRetryPolicy(method: string, overrides?: Partial<RetryPolicy>): RetryPolicy {
    const basePolicy =
      method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD"
        ? this.retryPolicies.reads
        : this.retryPolicies.writes;
    return overrides ? this.normalizeRetryPolicy(overrides, basePolicy) : basePolicy;
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof DiscourseApiError) {
      /* c8 ignore next */
      return TRANSIENT_STATUSES.has(error.status) || error.status >= 500;
    }
    return isTransportError(error);
  }

  private computeDelayMs(
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

  private async runWithRetry<T>(
    fn: (attempt: number) => Promise<T | undefined>,
    meta: { url: string; method: string },
    retryPolicy: RetryPolicy = this.retryPolicy
  ): Promise<T | undefined> {
    let attempt = 0;
    // attempt includes initial call; retries decrement from maxRetries
    while (true) {
      try {
        return await fn(attempt);
      } catch (error) {
        const canRetry = attempt < retryPolicy.maxRetries && this.shouldRetry(error);
        if (!canRetry) {
          throw error;
        }

        const delayMs = this.computeDelayMs(error, attempt, retryPolicy);
          this.logRequest({
            url: meta.url,
            method: meta.method,
            attempt,
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
    const attemptNumber = Math.max(1, params.attempt + 1);
    const payload = {
      path: params.url,
      method: params.method,
      attempt: attemptNumber,
      durationMs: params.durationMs,
      status: params.status,
      retryDelayMs: params.retryDelayMs,
      error: params.error ? serializeError(params.error) : undefined,
      outcome: params.outcome,
    };

    try {
      this.requestLogger?.(payload);
    } catch {
      // ignore observer failures
    }

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
    scopes: string;
  }) {
    return Effect.try(() => {
      const publicKeyEncoded = encodeURIComponent(params.publicKey);
      const scopes = params.scopes?.trim() || "read,write";
      const queryParams = [
        `client_id=${encodeURIComponent(params.clientId)}`,
        `application_name=${encodeURIComponent(params.applicationName)}`,
        `nonce=${encodeURIComponent(params.nonce)}`,
        `scopes=${encodeURIComponent(scopes)}`,
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

  buildUploadRequest(params: {
    uploadType?: string;
    username?: string;
    userApiKey?: string;
  }): UploadRequest {
    const request = this.buildRequest("/uploads.json", {
      method: "POST",
      asUser: params.username,
      userApiKey: params.userApiKey,
      accept: "application/json",
    });

    return {
      url: request.url,
      method: request.methodUpper as "POST",
      headers: request.headers,
      fields: {
        type: params.uploadType ?? "composer",
      },
    };
  }

  presignUpload(params: {
    filename: string;
    byteSize: number;
    contentType?: string;
    uploadType?: string;
    userApiKey?: string;
  }): Effect.Effect<PresignedUpload, Error, never> {
    return runWithContext("Presign upload", async () => {
      const data = await this.fetchApi<any>("/uploads/generate-presigned-put", {
        method: "POST",
        body: {
          filename: params.filename,
          file_name: params.filename,
          filesize: params.byteSize,
          file_size: params.byteSize,
          content_type: params.contentType,
          upload_type: params.uploadType ?? "composer",
        },
        userApiKey: params.userApiKey,
      });

      if (!data) {
        throw new Error("Empty presign response");
      }

      let parsed: z.infer<typeof RawPresignedUploadSchema>;
      try {
        parsed = parseWithSchemaOrThrow(
          RawPresignedUploadSchema,
          data,
          "Presigned upload",
          "Malformed presign response"
        );
      } catch (error) {
        const fallback = data as any;
        if (
          fallback &&
          typeof fallback.key === "string" &&
          (typeof fallback.upload_url === "string" || typeof fallback.url === "string") &&
          typeof fallback.unique_identifier === "string"
        ) {
          parsed = {
            key: fallback.key,
            url: typeof fallback.url === "string" ? fallback.url : undefined,
            upload_url:
              typeof fallback.upload_url === "string" ? fallback.upload_url : undefined,
            /* c8 ignore start */
            headers:
              fallback.headers && typeof fallback.headers === "object"
                ? fallback.headers
                : {},
            /* c8 ignore stop */
            unique_identifier: fallback.unique_identifier,
          };
        } else {
          throw error;
        }
      }

      const uploadUrl = parsed.upload_url ?? parsed.url;
      if (!uploadUrl) {
        throw new Error("Malformed presign response: upload_url missing");
      }

      return {
        method: "PUT" as const,
        uploadUrl,
        headers: this.normalizeHeaderValues(parsed.headers),
        key: parsed.key,
        uniqueIdentifier: parsed.unique_identifier,
      };
    });
  }

  batchPresignMultipartUpload(params: {
    uniqueIdentifier: string;
    partNumbers: number[];
    uploadId?: string;
    key?: string;
    contentType?: string;
    userApiKey?: string;
  }): Effect.Effect<MultipartPresign, Error, never> {
    return runWithContext("Batch presign multipart upload", async () => {
      const data = await this.fetchApi<any>(
        "/uploads/batch-presign-multipart",
        {
          method: "POST",
          body: {
            unique_identifier: params.uniqueIdentifier,
            upload_id: params.uploadId,
            key: params.key,
            part_numbers: params.partNumbers,
            content_type: params.contentType,
          },
          userApiKey: params.userApiKey,
        }
      );

      if (!data) {
        throw new Error("Empty multipart presign response");
      }

      let parsed: z.infer<typeof RawMultipartPresignSchema>;
      try {
        parsed = parseWithSchemaOrThrow(
          RawMultipartPresignSchema,
          data,
          "Multipart presign",
          "Malformed multipart presign response"
        );
      } catch (error) {
        const fallback = data as any;
        if (
          fallback &&
          typeof fallback.upload_id === "string" &&
          typeof fallback.key === "string" &&
          typeof fallback.unique_identifier === "string" &&
          Array.isArray(fallback.presigned_urls)
        ) {
          parsed = {
            upload_id: fallback.upload_id,
            key: fallback.key,
            unique_identifier: fallback.unique_identifier,
            presigned_urls: fallback.presigned_urls,
          };
        } else {
          throw error;
        }
      }

      return {
        uploadId: parsed.upload_id,
        key: parsed.key,
        uniqueIdentifier: parsed.unique_identifier,
        parts: parsed.presigned_urls.map((part) => ({
          partNumber: part.part_number,
          url: part.url,
          headers: this.normalizeHeaderValues(part.headers ?? {}),
        })),
      };
    });
  }

  completeMultipartUpload(params: {
    uniqueIdentifier: string;
    uploadId: string;
    key: string;
    parts: Array<{ partNumber: number; etag: string }>;
    filename: string;
    uploadType?: string;
    userApiKey?: string;
  }): Effect.Effect<{ upload: Upload }, Error, never> {
    return runWithContext("Complete multipart upload", async () => {
      const data = await this.fetchApi<{ upload?: any }>(
        "/uploads/complete-external-upload",
        {
          method: "POST",
          body: {
            upload_id: params.uploadId,
            key: params.key,
            unique_identifier: params.uniqueIdentifier,
            parts: params.parts.map((part) => ({
              part_number: part.partNumber,
              etag: part.etag,
            })),
            filename: params.filename,
            upload_type: params.uploadType ?? "composer",
          },
          userApiKey: params.userApiKey,
        }
      );

      if (!data || !data.upload) {
        throw new Error("Empty upload completion response");
      }

      return { upload: this.mapUpload(data.upload) };
    });
  }

  abortMultipartUpload(params: {
    uniqueIdentifier: string;
    uploadId: string;
    key: string;
    userApiKey?: string;
  }): Effect.Effect<boolean, Error, never> {
    return runWithContext("Abort multipart upload", async () => {
      const data = await this.fetchApi<any>("/uploads/abort-multipart", {
        method: "POST",
        body: {
          unique_identifier: params.uniqueIdentifier,
          upload_id: params.uploadId,
          key: params.key,
        },
        userApiKey: params.userApiKey,
      });

      if (!data) {
        return false;
      }

      const parsed = parseWithSchema(
        RawAbortUploadSchema,
        data,
        "Abort multipart upload"
      );

      if (parsed.aborted !== undefined) {
        return parsed.aborted;
      }
      if (parsed.success !== undefined) {
        return parsed.success;
      }
      return false;
    });
  }

  createPost(params: {
    title?: string;
    raw: string;
    category?: number;
    username: string;
    topicId?: number;
    replyToPostNumber?: number;
    userApiKey?: string;
  }) {
    return runWithContext("Create post", async () => {
      const data = await this.fetchApi<{
        id: number;
        topic_id: number;
        topic_slug: string;
      }>("/posts.json", {
        method: "POST",
        asUser: params.username,
        userApiKey: params.userApiKey,
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

  getTags() {
    return runWithContext("Get tags", async () => {
      const data = await this.fetchApi<{ tags?: any[] }>("/tags.json");
      if (!data) {
        return [];
      }
      if (!Array.isArray(data.tags)) {
        throw new Error("Malformed tags response");
      }
      return data.tags.map((tag: unknown) => this.mapTag(tag));
    });
  }

  getTag(name: string) {
    return runWithContext("Get tag", async () => {
      const data = await this.fetchApi<{ tag?: any }>(
        `/tags/${encodeURIComponent(name)}.json`
      );
      if (!data || !data.tag) {
        throw new Error("Empty tag response");
      }
      return this.mapTag(data.tag);
    });
  }

  getTagGroups() {
    return runWithContext("Get tag groups", async () => {
      const data = await this.fetchApi<{ tag_groups?: any[] }>(
        "/tag_groups.json"
      );
      if (!data) {
        return [];
      }
      if (!Array.isArray(data.tag_groups)) {
        throw new Error("Malformed tag groups response");
      }
      return data.tag_groups.map((group: unknown) => this.mapTagGroup(group));
    });
  }

  getTagGroup(tagGroupId: number) {
    return runWithContext("Get tag group", async () => {
      const data = await this.fetchApi<{ tag_group?: any }>(
        `/tag_groups/${tagGroupId}.json`
      );
      if (!data || !data.tag_group) {
        throw new Error("Empty tag group response");
      }
      return this.mapTagGroup(data.tag_group);
    });
  }

  createTagGroup(params: {
    name: string;
    tagNames?: string[];
    parentTagNames?: string[];
    onePerTopic?: boolean;
    permissions?: Record<string, unknown>;
  }) {
    return runWithContext("Create tag group", async () => {
      const permissions = this.normalizePermissions(params.permissions ?? {});
      const hasPermissions = Object.keys(permissions).length > 0;

      const data = await this.fetchApi<{ tag_group: any }>("/tag_groups.json", {
        method: "POST",
        body: {
          tag_group: {
            name: params.name,
            tag_names: params.tagNames ?? [],
            parent_tag_names: params.parentTagNames ?? [],
            one_per_topic: params.onePerTopic,
            permissions: hasPermissions ? permissions : undefined,
          },
        },
      });

      if (!data || !data.tag_group) {
        throw new Error("Empty tag group response");
      }

      return this.mapTagGroup(data.tag_group);
    });
  }

  updateTagGroup(params: {
    tagGroupId: number;
    name?: string;
    tagNames?: string[];
    parentTagNames?: string[];
    onePerTopic?: boolean;
    permissions?: Record<string, unknown>;
  }) {
    return runWithContext("Update tag group", async () => {
      const permissions = this.normalizePermissions(params.permissions);
      const hasPermissions = Object.keys(permissions).length > 0;

      const data = await this.fetchApi<{ tag_group: any }>(
        `/tag_groups/${params.tagGroupId}.json`,
        {
          method: "PUT",
          body: {
            tag_group: {
              name: params.name,
              tag_names: params.tagNames,
              parent_tag_names: params.parentTagNames,
              one_per_topic: params.onePerTopic,
              permissions: hasPermissions ? permissions : undefined,
            },
          },
        }
      );

      if (!data || !data.tag_group) {
        throw new Error("Empty tag group response");
      }

      return this.mapTagGroup(data.tag_group);
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
      return this.mapTopicList(data, page);
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
      return this.mapTopicList(data, page);
    });
  }

  getTopicList(params: {
    type: "latest" | "new" | "top";
    categoryId?: number;
    page?: number;
    order?: string;
    period?: string;
  }) {
    return runWithContext("Get topic list", async () => {
      const page = normalizePage(params.page, 0);
      const pageParam = page > 0 ? page : undefined;
      const orderParam =
        params.type === "latest" && params.order && params.order !== "default"
          ? params.order
          : undefined;
      const periodParam = params.period || "monthly";

      /* c8 ignore start */
      const basePath =
        params.type === "top"
          ? params.categoryId != null
            ? `/c/${params.categoryId}/l/top/${periodParam}.json`
            : `/top/${periodParam}.json`
          : params.type === "new"
            ? params.categoryId != null
              ? `/c/${params.categoryId}/l/new.json`
              : "/new.json"
            : params.categoryId != null
              ? `/c/${params.categoryId}/l/latest.json`
              : "/latest.json";
      /* c8 ignore stop */

      const path = this.buildTopicListPath(basePath, {
        page: pageParam,
        order: orderParam,
      });

      const data = await this.requestTopicList(path);
      return this.mapTopicList(data, page);
    });
  }

  getCategoryTopics(params: { slug: string; categoryId: number; page?: number }) {
    return runWithContext("Get category topics", async () => {
      const page = normalizePage(params.page, 0);
      const pageParam = page > 0 ? page : undefined;
      const path = this.buildTopicListPath(
        `/c/${params.slug}/${params.categoryId}.json`,
        { page: pageParam }
      );

      const data = await this.requestTopicList(path);
      return this.mapTopicList(data, page);
    });
  }

  private mapTag(tag: any): Tag {
    const parsed = parseWithSchemaOrThrow(
      RawTagSchema,
      tag,
      "Tag",
      "Malformed tag response"
    );
    return {
      id: parsed.id,
      name: parsed.name,
      topicCount: parsed.topic_count,
      pmTopicCount: parsed.pm_topic_count,
      synonyms: parsed.synonyms,
      targetTag: parsed.target_tag,
      description: parsed.description,
    };
  }

  private normalizePermissions(
    permissions?: Record<string, unknown>
  ): Record<string, number> {
    if (!permissions || typeof permissions !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(permissions).flatMap(([key, value]) => {
        const numeric =
          typeof value === "number"
            ? value
            : typeof value === "boolean"
              ? value
                ? 1
                : 0
              : Number(value);
        if (!Number.isFinite(numeric)) return [];
        return [[key, numeric] as const];
      })
    );
  }

  private mapTagGroup(group: any): TagGroup {
    const parsed = parseWithSchemaOrThrow(
      RawTagGroupSchema,
      /* c8 ignore start */
      group && typeof group === "object"
        ? { ...group, permissions: this.normalizePermissions((group as any).permissions) }
        : group,
      /* c8 ignore stop */
      "Tag group",
      "Malformed tag group response"
    );
    const tags = parsed.tags.map((tag: unknown) => this.mapTag(tag));
    const permissions = this.normalizePermissions(parsed.permissions);

    return {
      id: parsed.id,
      name: parsed.name,
      tagNames: parsed.tag_names,
      parentTagNames: parsed.parent_tag_names,
      onePerTopic: parsed.one_per_topic,
      permissions,
      tags,
    };
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

  private mapUpload(upload: any): Upload {
    const parsed = parseWithSchemaOrThrow(
      RawUploadSchema,
      upload,
      "Upload",
      "Malformed upload response"
    );

    return {
      id: parsed.id,
      url: parsed.url,
      shortUrl: parsed.short_url ?? parsed.short_path ?? undefined,
      originalFilename: parsed.original_filename,
      filesize: parsed.filesize,
      humanFileSize: parsed.human_filesize,
      extension: parsed.extension,
      width: parsed.width,
      height: parsed.height,
      thumbnailUrl: parsed.thumbnail_url,
    };
  }

  private normalizeHeaderValues(headers: Record<string, string | number | undefined>) {
    return Object.entries(headers ?? {}).reduce<Record<string, string>>(
      (acc, [key, value]) => {
        if (value === undefined || value === null) {
          return acc;
        }
        acc[key] = String(value);
        return acc;
      },
      {}
    );
  }

  private mapTopicList(data: TopicListResponse | undefined, page: number): PaginatedTopics {
    const hasMore = !!data?.topic_list?.more_topics_url;

    return {
      topics: data?.topic_list?.topics?.map((t: any) => this.mapTopic(t)) ?? [],
      hasMore,
      nextPage: hasMore ? page + 1 : null,
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

  private mapAdminUser(user: any): AdminUser {
    const parsed = parseWithSchemaOrThrow(
      RawAdminUserSchema,
      user,
      "Admin user",
      "Malformed admin user response"
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
      email: parsed.email ?? undefined,
      active: parsed.active,
      lastSeenAt: parsed.last_seen_at,
      staged: parsed.staged,
    };
  }

  private mapDirectoryItem(item: any): DirectoryItem {
    const parsed = parseWithSchemaOrThrow(
      RawDirectoryItemSchema,
      item,
      "Directory item",
      "Malformed directory response"
    );

    return {
      user: this.mapUserSummary(parsed.user),
      likesReceived: parsed.likes_received,
      likesGiven: parsed.likes_given,
      topicsEntered: parsed.topics_entered,
      postsRead: parsed.posts_read,
      daysVisited: parsed.days_visited,
      topicCount: parsed.topic_count,
      postCount: parsed.post_count,
    };
  }

  private mapUserStatus(status: any): UserStatus {
    const parsed = parseWithSchemaOrThrow(
      RawUserStatusSchema,
      status,
      "User status",
      "Malformed user status response"
    );

    return {
      emoji: parsed.emoji,
      description: parsed.description,
      endsAt: parsed.ends_at,
    };
  }

  private mapSiteDetails(site: any) {
    const parsed = parseWithSchemaOrThrow(
      RawSiteDetailsSchema,
      site,
      "Site info",
      "Malformed site info response"
    );

    return {
      title: parsed.title,
      description: parsed.description,
      logoUrl: parsed.logo_url,
      mobileLogoUrl: parsed.mobile_logo_url,
      faviconUrl: parsed.favicon_url,
      contactEmail: parsed.contact_email,
      canonicalHostname: parsed.canonical_hostname,
      defaultLocale: parsed.default_locale,
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

  listPosts(params: { page?: number } = {}) {
    return runWithContext("List posts", async () => {
      const page = normalizePage(params.page, 0);
      const pageParam = page > 0 ? page : undefined;
      const path = this.buildTopicListPath("/posts.json", { page: pageParam });
      const data = await this.fetchApi<PostsListResponse>(path);
      if (!data) {
        return { posts: [], hasMore: false, nextPage: null };
      }

      const rawPosts = data.latest_posts;
      if (rawPosts != null && !Array.isArray(rawPosts)) {
        throw new Error("Malformed posts response");
      }

      const posts = (rawPosts ?? []).map((p: any) => this.mapPost(p, false));
      const hasMore = !!data.more_posts_url;

      return {
        posts,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
      };
    });
  }

  updateTopicStatus(params: {
    topicId: number;
    status: "closed" | "archived" | "pinned" | "visible";
    enabled: boolean;
    username?: string;
    userApiKey?: string;
  }) {
    return runWithContext("Update topic status", async () => {
      await this.fetchApi<void>(`/t/${params.topicId}/status`, {
        method: "PUT",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: {
          status: params.status,
          enabled: params.enabled,
        },
      });

      const data = await this.requestTopic(params.topicId);
      if (!data) {
        throw new Error("Empty topic response");
      }

      return { topic: this.mapTopic(data) };
    });
  }

  updateTopicMetadata(params: {
    topicId: number;
    title?: string;
    categoryId?: number;
    username?: string;
    userApiKey?: string;
  }) {
    return runWithContext("Update topic metadata", async () => {
      await this.fetchApi<void>(`/t/${params.topicId}.json`, {
        method: "PUT",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: {
          title: params.title,
          category_id: params.categoryId,
        },
      });

      const data = await this.requestTopic(params.topicId);
      if (!data) {
        throw new Error("Empty topic response");
      }

      return { topic: this.mapTopic(data) };
    });
  }

  bookmarkTopic(params: {
    topicId: number;
    postNumber: number;
    username: string;
    userApiKey?: string;
    reminderAt?: string;
  }) {
    return runWithContext("Bookmark topic", async () => {
      const data = await this.fetchApi<any>(`/t/${params.topicId}/bookmark`, {
        method: "PUT",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: {
          bookmarked: true,
          post_number: params.postNumber,
          reminder_at: params.reminderAt,
        },
      });

      const bookmarkId =
        data && typeof (data as any).bookmark_id === "number"
          ? (data as any).bookmark_id
          : undefined;

      return { success: true as const, bookmarkId };
    });
  }

  inviteToTopic(params: {
    topicId: number;
    usernames?: string[];
    groupNames?: string[];
    username?: string;
    userApiKey?: string;
  }) {
    return runWithContext("Invite to topic", async () => {
      await this.fetchApi<void>(`/t/${params.topicId}/invite`, {
        method: "POST",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: {
          usernames:
            params.usernames && params.usernames.length
              ? params.usernames.join(",")
              : undefined,
          group_names:
            params.groupNames && params.groupNames.length
              ? params.groupNames.join(",")
              : undefined,
        },
      });

      return { success: true as const };
    });
  }

  setTopicNotification(params: {
    topicId: number;
    level: TopicNotificationLevel;
    username: string;
    userApiKey?: string;
  }) {
    return runWithContext("Set topic notification", async () => {
      const notificationLevel = normalizeTopicNotificationLevel(params.level);

      const data = await this.fetchApi<any>(`/t/${params.topicId}/notifications`, {
        method: "POST",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: { notification_level: notificationLevel },
      });

      const resolvedLevel =
        data && typeof (data as any).notification_level === "number"
          ? (data as any).notification_level
          : notificationLevel;

      return { success: true as const, notificationLevel: resolvedLevel };
    });
  }

  changeTopicTimestamp(params: {
    topicId: number;
    timestamp: string;
    username?: string;
    userApiKey?: string;
  }) {
    return runWithContext("Change topic timestamp", async () => {
      await this.fetchApi<void>(`/t/${params.topicId}/change-timestamp`, {
        method: "PUT",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: { timestamp: params.timestamp },
      });

      const data = await this.requestTopic(params.topicId);
      if (!data) {
        throw new Error("Empty topic response");
      }

      return { topic: this.mapTopic(data) };
    });
  }

  addTopicTimer(params: {
    topicId: number;
    statusType: string;
    time: string;
    basedOnLastPost?: boolean;
    durationMinutes?: number;
    categoryId?: number;
    username?: string;
    userApiKey?: string;
  }) {
    return runWithContext("Add topic timer", async () => {
      const data = await this.fetchApi<any>(`/t/${params.topicId}/timers`, {
        method: "POST",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: {
          status_type: params.statusType,
          time: params.time,
          based_on_last_post: params.basedOnLastPost,
          duration: params.durationMinutes,
          category_id: params.categoryId,
        },
      });

      const status =
        data && typeof (data as any).status_type === "string"
          ? (data as any).status_type
          : params.statusType;

      return { success: true as const, status };
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

  createUser(params: {
    username: string;
    email: string;
    name?: string;
    password?: string;
    active?: boolean;
    approved?: boolean;
    externalId?: string;
    externalProvider?: string;
    staged?: boolean;
    emailVerified?: boolean;
    locale?: string;
  }) {
    return runWithContext("Create user", async () => {
      const data = await this.fetchApi<{ success?: boolean; user_id?: number; active?: boolean }>(
        "/users",
        {
          method: "POST",
          body: {
            username: params.username,
            email: params.email,
            name: params.name,
            password: params.password,
            active: params.active,
            approved: params.approved,
            external_id: params.externalId,
            external_provider: params.externalProvider,
            staged: params.staged,
            email_verified: params.emailVerified,
            locale: params.locale,
          },
        }
      );

      if (!data) {
        throw new Error("Empty create user response");
      }

      return {
        success: data.success !== false,
        userId: typeof (data as any).user_id === "number" ? (data as any).user_id : undefined,
        active: typeof data.active === "boolean" ? data.active : undefined,
      };
    });
  }

  updateUser(params: {
    username: string;
    email?: string;
    name?: string;
    title?: string;
    trustLevel?: number;
    active?: boolean;
    suspendedUntil?: string | null;
    suspendReason?: string;
    staged?: boolean;
    bioRaw?: string;
    locale?: string;
  }) {
    return runWithContext("Update user", async () => {
      const data = await this.fetchApi<{ success?: boolean }>(`/u/${params.username}.json`, {
        method: "PUT",
        body: {
          name: params.name,
          email: params.email,
          title: params.title,
          trust_level: params.trustLevel,
          active: params.active,
          suspend_until: params.suspendedUntil,
          suspend_reason: params.suspendReason,
          staged: params.staged,
          bio_raw: params.bioRaw,
          locale: params.locale,
        },
      });

      if (!data) {
        throw new Error("Empty update user response");
      }

      return { success: data.success !== false };
    });
  }

  deleteUser(params: {
    userId: number;
    blockEmail?: boolean;
    blockUrls?: boolean;
    blockIp?: boolean;
    deletePosts?: boolean;
    context?: string;
  }) {
    return runWithContext("Delete user", async () => {
      const query = this.buildQuery({
        context: params.context,
        delete_posts: params.deletePosts ? "true" : undefined,
        block_email: params.blockEmail ? "true" : undefined,
        block_urls: params.blockUrls ? "true" : undefined,
        block_ip: params.blockIp ? "true" : undefined,
      });
      const path = query
        ? `/admin/users/${params.userId}.json?${query}`
        : `/admin/users/${params.userId}.json`;

      const data = await this.fetchApi<{ success?: boolean }>(path, {
        method: "DELETE",
      });

      if (!data) {
        throw new Error("Empty delete user response");
      }

      return { success: data.success !== false };
    });
  }

  listUsers(params: { page?: number }) {
    return runWithContext("List users", async () => {
      const page = normalizePage(params.page, 0);
      const path = page > 0 ? `/users.json?page=${page}` : "/users.json";
      const data = await this.fetchApi<{ users?: any[] }>(path);
      const users = data?.users ?? [];
      if (!Array.isArray(users)) {
        throw new Error("Malformed users response");
      }
      return users.map((u: any) => this.mapUserSummary(u));
    });
  }

  listAdminUsers(params: { filter: string; page?: number; showEmails?: boolean }) {
    return runWithContext("List admin users", async () => {
      const query = this.buildQuery({
        page: normalizePage(params.page, 0) || undefined,
        show_emails: params.showEmails ? "true" : undefined,
      });
      const suffix = query ? `?${query}` : "";
      const data = await this.fetchApi<AdminUsersResponse>(
        `/admin/users/list/${params.filter}.json${suffix}`
      );
      if (!data || !Array.isArray(data)) {
        throw new Error("Empty admin users response");
      }
      return data.map((user) => this.mapAdminUser(user));
    });
  }

  getUserByExternal(params: { externalId: string; provider: string }) {
    return runWithContext("Get user by external id", async () => {
      const data = await this.fetchApi<{ user?: any }>(
        `/u/by-external/${encodeURIComponent(params.provider)}/${encodeURIComponent(params.externalId)}.json`
      );

      if (!data || !data.user) {
        throw new Error("Empty external user response");
      }

      return this.mapUserProfile(data.user);
    });
  }

  getDirectory(params: { period: string; order: string; page?: number }) {
    return runWithContext("Get directory", async () => {
      const page = normalizePage(params.page, 0);
      const query = this.buildQuery({
        period: params.period,
        order: params.order,
        page: page > 0 ? page : undefined,
      });
      const path = `/directory_items.json?${query}`;
      const data = await this.fetchApi<DirectoryResponse>(path);
      const items = data?.directory_items ?? [];
      if (!Array.isArray(items)) {
        throw new Error("Malformed directory response");
      }
      const mapped = items.map((item) => this.mapDirectoryItem(item));
      const total =
        typeof data?.meta?.total_rows_directory_items === "number"
          ? data.meta.total_rows_directory_items
          : mapped.length;
      return { items: mapped, totalRows: total };
    });
  }

  forgotPassword(login: string) {
    return runWithContext("Forgot password", async () => {
      const data = await this.fetchApi<{ success?: boolean }>(
        "/session/forgot_password",
        {
          method: "POST",
          body: { login },
        }
      );

      return { success: data?.success !== false };
    });
  }

  changePassword(params: { token: string; password: string }) {
    return runWithContext("Change password", async () => {
      const data = await this.fetchApi<{ success?: boolean }>(
        `/u/password-reset/${encodeURIComponent(params.token)}.json`,
        {
          method: "PUT",
          body: {
            password: params.password,
            password_confirmation: params.password,
          },
        }
      );

      if (!data) {
        throw new Error("Empty password change response");
      }

      return { success: data.success !== false };
    });
  }

  logoutUser(userId: number) {
    return runWithContext("Logout user", async () => {
      const data = await this.fetchApi<{ success?: boolean }>(
        `/admin/users/${userId}/log_out`,
        { method: "POST" }
      );

      if (!data) {
        throw new Error("Empty logout response");
      }

      return { success: data.success !== false };
    });
  }

  syncSso(params: { sso: string; sig: string }) {
    return runWithContext("Sync SSO", async () => {
      const data = await this.fetchApi<{ success?: boolean; user_id?: number }>(
        "/admin/users/sync_sso",
        {
          method: "POST",
          body: {
            sso: params.sso,
            sig: params.sig,
          },
        }
      );

      if (!data) {
        throw new Error("Empty SSO sync response");
      }

      return {
        success: data.success !== false,
        userId: typeof data.user_id === "number" ? data.user_id : undefined,
      };
    });
  }

  getUserStatus(username: string) {
    return runWithContext("Get user status", async () => {
      const data = await this.fetchApi<{ status?: any }>(`/u/${username}/status.json`);
      if (!data || !data.status) {
        return { status: null as UserStatus | null };
      }
      return { status: this.mapUserStatus(data.status) };
    });
  }

  updateUserStatus(params: {
    username: string;
    emoji?: string | null;
    description?: string | null;
    endsAt?: string | null;
  }) {
    return runWithContext("Update user status", async () => {
      const data = await this.fetchApi<{ status?: any }>(
        `/u/${params.username}/status.json`,
        {
          method: "PUT",
          body: {
            status: {
              emoji: params.emoji ?? null,
              description: params.description ?? null,
              ends_at: params.endsAt ?? null,
            },
          },
        }
      );

      if (!data || !data.status) {
        throw new Error("Empty status response");
      }

      return { status: this.mapUserStatus(data.status) };
    });
  }

  getSiteInfo() {
    return runWithContext("Get site info", async () => {
      const data = await this.fetchApi<SiteInfoResponse>("/site.json");
      if (!data) {
        throw new Error("Empty site info response");
      }

      const siteSource = data.site ?? data;
      /* c8 ignore start */
      const categoriesSource =
        Array.isArray(data.categories) || data.categories == null
          ? data.categories
          : Array.isArray((siteSource as any)?.categories)
            ? (siteSource as any).categories
            : null;

      if (categoriesSource !== null && categoriesSource !== undefined && !Array.isArray(categoriesSource)) {
        throw new Error("Malformed site categories response");
      }
      /* c8 ignore stop */

      const categories = (categoriesSource ?? []).map((cat: any) => this.mapCategory(cat));

      return {
        ...this.mapSiteDetails(siteSource),
        categories,
      };
    });
  }

  getSiteBasicInfo() {
    return runWithContext("Get site basic info", async () => {
      const data = await this.fetchApi<SiteBasicInfoResponse>("/site/basic-info.json");
      const siteSource = data?.site ?? data;
      if (!siteSource) {
        throw new Error("Empty site basic info response");
      }

      return this.mapSiteDetails(siteSource);
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

  private mapRevision(revision: any, includeRaw: boolean): Revision {
    const parsed = parseWithSchemaOrThrow(
      RawRevisionSchema,
      revision,
      "Revision",
      "Malformed revision response"
    );

    if (includeRaw && typeof parsed.raw !== "string") {
      throw new Error("Revision validation failed: raw is required when includeRaw is true");
    }

    return {
      number: parsed.number,
      postId: parsed.post_id,
      userId: parsed.user_id,
      username: parsed.username,
      createdAt: parsed.created_at ?? null,
      updatedAt: parsed.updated_at ?? null,
      raw: includeRaw ? parsed.raw : undefined,
      cooked: parsed.cooked,
      changes: parsed.changes,
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
    userApiKey?: string;
  }) {
    return runWithContext("Edit post", async () => {
      const data = await this.fetchApi<{ post: any }>(
        `/posts/${params.postId}.json`,
        {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
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

  lockPost(params: {
    postId: number;
    locked: boolean;
    username: string;
    userApiKey?: string;
  }) {
    return runWithContext("Lock post", async () => {
      const data = await this.fetchApi<{ locked?: boolean }>(
        `/posts/${params.postId}/locked.json`,
        {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: { locked: params.locked },
        }
      );

      return {
        locked: typeof data?.locked === "boolean" ? data.locked : params.locked,
      };
    });
  }

  performPostAction(params: {
    postId: number;
    action: PostActionResult["action"];
    postActionTypeId?: number;
    message?: string;
    flagTopic?: boolean;
    takeAction?: boolean;
    undo?: boolean;
    username: string;
    userApiKey?: string;
  }) {
    return runWithContext("Post action", async () => {
      const resolvedType = this.resolvePostActionType(
        params.action,
        params.postActionTypeId
      );

      const data = await this.fetchApi<{
        id?: number;
        post_action_type_id?: number;
        success?: boolean | string;
      }>("/post_actions", {
        method: "POST",
        asUser: params.username,
        userApiKey: params.userApiKey,
        body: {
          id: params.postId,
          post_action_type_id: resolvedType,
          flag_topic: params.flagTopic,
          message: params.message,
          take_action: params.takeAction,
          undo: params.undo ?? params.action === "unlike",
        },
      });

      const postActionTypeId =
        typeof data?.post_action_type_id === "number"
          ? data.post_action_type_id
          : resolvedType;
      const postActionId = typeof data?.id === "number" ? data.id : undefined;
      const success = normalizeSuccessFlag(data?.success) ?? true;

      return {
        success,
        action: params.action,
        postActionTypeId,
        postActionId,
      };
    });
  }

  deletePost(params: {
    postId: number;
    forceDestroy?: boolean;
    username: string;
    userApiKey?: string;
  }) {
    return runWithContext("Delete post", async () => {
      const path =
        params.forceDestroy === true
          ? `/posts/${params.postId}.json?force_destroy=true`
          : `/posts/${params.postId}.json`;

      const data = await this.fetchApi<{ success?: boolean | string; deleted?: boolean }>(
        path,
        {
          method: "DELETE",
          asUser: params.username,
          userApiKey: params.userApiKey,
        }
      );

      const success =
        normalizeSuccessFlag(data?.success) ??
        (typeof data?.deleted === "boolean" ? data.deleted : undefined) ??
        true;

      return { success };
    });
  }

  getRevision(params: {
    postId: number;
    revision: number;
    includeRaw?: boolean;
    username?: string;
    userApiKey?: string;
  }) {
    return runWithContext("Get revision", async () => {
      const data = await this.fetchApi<{ revision?: any }>(
        `/posts/${params.postId}/revisions/${params.revision}.json`,
        {
          method: "GET",
          asUser: params.username,
          userApiKey: params.userApiKey,
        }
      );

      if (!data || !data.revision) {
        throw new Error("Empty revision response");
      }

      return {
        revision: this.mapRevision(data.revision, params.includeRaw ?? false),
      };
    });
  }

  updateRevision(params: {
    postId: number;
    revision: number;
    raw: string;
    editReason?: string;
    username: string;
    userApiKey?: string;
  }) {
    return runWithContext("Update revision", async () => {
      const data = await this.fetchApi<{ revision?: any }>(
        `/posts/${params.postId}/revisions/${params.revision}.json`,
        {
          method: "PUT",
          asUser: params.username,
          userApiKey: params.userApiKey,
          body: {
            revision: {
              raw: params.raw,
              edit_reason: params.editReason,
            },
          },
        }
      );

      if (!data || !data.revision) {
        throw new Error("Empty revision response");
      }

      return { revision: this.mapRevision(data.revision, true) };
    });
  }

  deleteRevision(params: {
    postId: number;
    revision: number;
    username: string;
    userApiKey?: string;
  }) {
    return runWithContext("Delete revision", async () => {
      const data = await this.fetchApi<{ success?: boolean | string }>(
        `/posts/${params.postId}/revisions/${params.revision}.json`,
        {
          method: "DELETE",
          asUser: params.username,
          userApiKey: params.userApiKey,
        }
      );

      return {
        success: normalizeSuccessFlag(data?.success) ?? true,
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
    userApiKey?: string;
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
  onEvict?: (event: { type: "client" | "global"; clientId?: string; count: number }) => void;
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
  private readonly onEvict?: (event: {
    type: "client" | "global";
    clientId?: string;
    count: number;
  }) => void;
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
      onEvict,
    } = typeof ttlMsOrOptions === "object" ? ttlMsOrOptions : { ttlMs: ttlMsOrOptions };

    this.ttl = this.normalizeTtl(ttlMs);
    this.maxPerClient = this.normalizeLimit(maxPerClient);
    this.maxTotal = this.normalizeLimit(maxTotal);
    this.perClientStrategy = limitStrategy?.perClient ?? DEFAULT_LIMIT_STRATEGY.perClient;
    this.globalStrategy = limitStrategy?.global ?? DEFAULT_LIMIT_STRATEGY.global;
    this.onEvict = typeof onEvict === "function" ? onEvict : undefined;
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

  private notifyEvict(event: { type: "client" | "global"; clientId?: string; count: number }) {
    if (event.count > 0) {
      this.onEvict?.(event);
    }
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

    let evicted = 0;
    while (this.countByClient(clientId) > maxCount) {
      if (!this.evictOldest((entry) => entry.clientId === clientId)) {
        break;
      }
      evicted += 1;
    }
    this.notifyEvict({ type: "client", clientId, count: evicted });
    return evicted > 0;
  }

  private evictGlobally(maxCount: number): boolean {
    if (maxCount < 0) return false;

    let evicted = 0;
    while (this.nonces.size > maxCount) {
      if (!this.evictOldest(() => true)) {
        break;
      }
      evicted += 1;
    }

    this.notifyEvict({ type: "global", count: evicted });

    return evicted > 0;
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
