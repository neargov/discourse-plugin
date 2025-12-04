import type { RetryPolicy } from "./constants";
import { DEFAULT_BODY_SNIPPET_LENGTH } from "./constants";
import type { Logger, RequestLogEvent, RequestLogger } from "./logging";
import { formatError, serializeError } from "./utils";

export const normalizeBaseUrl = (baseUrl: string): string => {
  try {
    const parsed = new URL(baseUrl);
    const trimmedPath = parsed.pathname.replace(/\/+$/, "");
    const normalizedPath = trimmedPath.length ? trimmedPath : "";
    return `${parsed.origin}${normalizedPath}/`;
  } catch {
    throw new Error(`Invalid Discourse base URL: ${baseUrl}`);
  }
};

const hasHeader = (headers: Record<string, string>, name: string): boolean => {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
};

const sanitizeSnippet = (text: string, maxLength: number = 512): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
};

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

const getHeaderGetter = (response: Response) =>
  typeof (response as any)?.headers?.get === "function"
    ? (response as any).headers.get.bind((response as any).headers)
    : null;

const readErrorBody = async (response: Response, maxLength: number): Promise<string> => {
  const limit = Math.max(1, maxLength);
  const reader = (response as any)?.body?.getReader?.();

  if (reader && typeof reader.read === "function") {
    const decoder = new TextDecoder();
    let result = "";
    try {
      while (result.length < limit) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          result += decoder.decode(value, { stream: true });
          if (result.length >= limit) {
            result = result.slice(0, limit);
            break;
          }
        }
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancellation errors
      }
      throw error;
    }

    try {
      result += decoder.decode();
      await reader.cancel();
    } catch {
      // ignore cleanup errors
    }
    return result.slice(0, limit);
  }

  if (typeof (response as any)?.text === "function") {
    const text = await (response as any).text();
    return text.slice(0, limit);
  }

  return "";
};

export const readBodyWithTimeout = async (
  response: Response,
  readTimeoutMs: number | undefined,
  url: string
): Promise<string | undefined> => {
  if (typeof (response as any).text !== "function") {
    return undefined;
  }

  try {
    return await withReadTimeout((response as any).text(), readTimeoutMs, url);
  } catch (error) {
    throw new Error(`Failed to read response body: ${formatError(error)}`);
  }
};

export const parseJsonBody = <T>(
  text: string,
  url: string,
  bodySnippetLength: number
): T => {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const snippet = sanitizeSnippet(text, Math.max(0, bodySnippetLength));
    throw new Error(
      `Failed to parse JSON from ${url}: ${formatError(error)} | body snippet: ${snippet}`
    );
  }
};

export const logAndThrowHttpError = async (params: {
  response: Response;
  url: string;
  method: string;
  headersGet: ((name: string) => string | null) | null;
  bodySnippetLength: number;
  logger: Logger;
  onHttpError: TransportConfig["onHttpError"];
}) => {
  const { response, url, method, headersGet, bodySnippetLength, logger, onHttpError } = params;

  let errorText: string;
  try {
    const maxReadLength = Math.max(bodySnippetLength * 4, 4096);
    errorText = await readErrorBody(response, maxReadLength);
  } catch (readError) {
    errorText = `[body unavailable: ${formatError(readError)}]`;
  }

  const requestId = headersGet ? headersGet("x-request-id") : undefined;
  const retryAfterMs = parseRetryAfterHeader(headersGet ? headersGet("retry-after") : undefined);
  const bodySnippet = sanitizeSnippet(errorText, bodySnippetLength);

  try {
    logger.error("Discourse API error", {
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

  throw onHttpError({
    status: response.status,
    path: url,
    method,
    bodySnippet,
    bodySnippetMaxLength: bodySnippetLength,
    retryAfterMs,
    requestId: requestId || undefined,
  });
};

export type TransportConfig = {
  baseUrl: string;
  defaultTimeoutMs: number;
  userAgent?: string;
  userApiClientId?: string;
  systemApiKey: string;
  systemUsername: string;
  bodySnippetLength?: number;
  logger: Logger;
  requestLogger?: RequestLogger;
  fetchImpl?: typeof fetch;
  retryPolicy: RetryPolicy;
  retryPolicies: { default: RetryPolicy; reads: RetryPolicy; writes: RetryPolicy };
  onHttpError: (params: {
    status: number;
    path: string;
    method: string;
    bodySnippet?: string;
    retryAfterMs?: number;
    requestId?: string;
    bodySnippetMaxLength?: number;
  }) => Error;
};

export type FetchOptions = {
  method?: string;
  body?: unknown;
  bodyFactory?: () => unknown;
  bodyMode?: "json" | "raw";
  bodySerializer?: (body: unknown) => BodyInit;
  accept?: string | null;
  asUser?: string;
  userApiKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  retryPolicy?: Partial<RetryPolicy>;
  readTimeoutMs?: number;
};

export type RetryFns = {
  shouldRetry: (error: unknown) => boolean;
  computeDelayMs: (error: unknown, attempt: number, retryPolicy: RetryPolicy) => number;
};

type BuiltRequest = {
  url: string;
  methodUpper: string;
  headers: Record<string, string>;
  resolvedBody?: BodyInit;
  effectiveTimeout: number;
};

const normalizeHeaders = (extraHeaders: Record<string, string | number | undefined | null>) => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value === undefined || value === null) continue;
    headers[key] = String(value);
  }
  return headers;
};

const applyAcceptHeader = (
  headers: Record<string, string>,
  accept: FetchOptions["accept"],
  headerExists: (name: string) => boolean
) => {
  if (headerExists("Accept")) return;
  if (accept === null) return;
  headers.Accept = accept ?? "application/json";
};

const applyUserAgent = (
  headers: Record<string, string>,
  userAgent: string | undefined,
  headerExists: (name: string) => boolean
) => {
  if (!userAgent || headerExists("User-Agent")) {
    return;
  }
  headers["User-Agent"] = userAgent;
};

const applyAuthHeaders = (
  headers: Record<string, string>,
  params: {
    systemApiKey: string;
    systemUsername: string;
    userApiClientId?: string;
    asUser?: string;
    userApiKey?: string;
  },
  headerExists: (name: string) => boolean
) => {
  const { systemApiKey, systemUsername, userApiClientId, asUser, userApiKey } = params;
  const hasUserApiKeyHeader = headerExists("User-Api-Key");
  const usingUserApiKey = !!userApiKey || hasUserApiKeyHeader;

  if (usingUserApiKey) {
    if (userApiKey && !hasUserApiKeyHeader) {
      headers["User-Api-Key"] = userApiKey;
    }
    if (userApiClientId && !headerExists("User-Api-Client-Id")) {
      headers["User-Api-Client-Id"] = userApiClientId;
    }
    return;
  }

  if (!headerExists("Api-Key")) {
    headers["Api-Key"] = systemApiKey;
  }
  if (!headerExists("Api-Username")) {
    headers["Api-Username"] = asUser || systemUsername;
  }
};

const resolveBody = (
  body: unknown,
  options: { mode: FetchOptions["bodyMode"]; serializer?: FetchOptions["bodySerializer"] }
) => {
  const { mode, serializer } = options;
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const isBlob = typeof Blob !== "undefined" && body instanceof Blob;
  const isArrayBufferView = ArrayBuffer.isView(body as any);
  const isArrayBuffer = body instanceof ArrayBuffer;
  const shouldSerializeJson =
    body !== undefined &&
    serializer === undefined &&
    mode === "json" &&
    !isFormData &&
    !isBlob &&
    !isArrayBuffer &&
    !isArrayBufferView &&
    typeof body !== "string";

  const resolvedBody =
    body === undefined
      ? undefined
      : serializer
      ? serializer(body)
      : shouldSerializeJson
      ? JSON.stringify(body)
      : (body as BodyInit);

  return {
    resolvedBody,
    contentType: shouldSerializeJson ? "application/json" : undefined,
  };
};

const buildUrl = (baseUrl: string, path: string): string => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const normalizedPath = path.replace(/^\/+/, "");
  return new URL(normalizedPath, baseUrl).toString();
};

const buildRequest = (
  config: {
    baseUrl: string;
    defaultTimeoutMs: number;
    userAgent?: string;
    userApiClientId?: string;
    systemApiKey: string;
    systemUsername: string;
  },
  path: string,
  options: FetchOptions
): BuiltRequest => {
  const {
    method = "GET",
    body,
    bodyFactory,
    bodyMode = "json",
    bodySerializer,
    accept,
    asUser,
    userApiKey,
    timeoutMs,
    headers: extraHeaders = {},
  } = options;
  const url = buildUrl(config.baseUrl, path);
  const methodUpper = method.toUpperCase();
  const effectiveTimeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : config.defaultTimeoutMs;

  const headers = normalizeHeaders(extraHeaders);
  const headerExists = (name: string) => hasHeader(headers, name);

  applyAcceptHeader(headers, accept, headerExists);
  applyUserAgent(headers, config.userAgent, headerExists);
  applyAuthHeaders(
    headers,
    {
      systemApiKey: config.systemApiKey,
      systemUsername: config.systemUsername,
      userApiClientId: config.userApiClientId,
      asUser,
      userApiKey,
    },
    headerExists
  );

  const bodyValue = typeof bodyFactory === "function" ? bodyFactory() : body;
  const { resolvedBody, contentType } = resolveBody(bodyValue, {
    mode: bodyMode,
    serializer: bodySerializer,
  });

  if (contentType && !headerExists("Content-Type")) {
    headers["Content-Type"] = contentType;
  }

  return { url, methodUpper, headers, resolvedBody, effectiveTimeout };
};

const readParsedBody = async <T>(
  response: Response,
  meta: {
    url: string;
    headersGet: ((name: string) => string | null) | null;
    readTimeoutMs?: number;
  },
  bodySnippetLength: number
): Promise<T | undefined> => {
  const contentLength = meta.headersGet ? meta.headersGet("content-length") : undefined;
  const normalizedContentLength =
    typeof contentLength === "string" ? contentLength.trim().toLowerCase() : undefined;
  if (normalizedContentLength === "0") return undefined;

  const contentType = meta.headersGet ? meta.headersGet("content-type") : undefined;
  const isJson = typeof contentType === "string" && /json/i.test(contentType);

  const text = await readBodyWithTimeout(response, meta.readTimeoutMs, meta.url);
  if (text === undefined) {
    if (typeof (response as any).json === "function") {
      const result = await withReadTimeout(
        (response as any).json(),
        meta.readTimeoutMs,
        meta.url
      );
      return (result as T) ?? undefined;
    }
    return undefined;
  }

  if (!text || String(text).trim().length === 0) return undefined;
  return isJson ? parseJsonBody<T>(text, meta.url, bodySnippetLength) : (text as unknown as T);
};

const parseResponse = async <T>(
  params: {
    response: Response;
    url: string;
    method: string;
    readTimeoutMs?: number;
    bodySnippetLength: number;
    logger: Logger;
    onHttpError: TransportConfig["onHttpError"];
  }
): Promise<T | undefined> => {
  const { response, url, method, readTimeoutMs, bodySnippetLength, logger, onHttpError } = params;
  const headersGet = getHeaderGetter(response);

  if (!response.ok) {
    await logAndThrowHttpError({
      response,
      url,
      method,
      headersGet,
      bodySnippetLength,
      logger,
      onHttpError,
    });
  }

  return readParsedBody<T>(
    response,
    {
      url,
      headersGet,
      readTimeoutMs,
    },
    bodySnippetLength
  );
};

const logRequest = (
  logger: Logger,
  requestLogger: RequestLogger | undefined,
  params: {
    url: string;
    method: string;
    attempt: number;
    durationMs?: number;
    outcome: "success" | "retry" | "fail";
    status?: number;
    error?: unknown;
    retryDelayMs?: number;
  }
) => {
  const attemptNumber = Math.max(1, params.attempt + 1);
  const payload: RequestLogEvent = {
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
    requestLogger?.(payload);
  } catch {
    // ignore observer failures
  }

  try {
    if (params.outcome === "success") {
      logger.debug?.("Discourse request completed", payload);
    } else if (params.outcome === "retry") {
      logger.warn?.("Discourse request retrying", payload);
    } else {
      logger.error?.("Discourse request failed", payload);
    }
  } catch {
    // swallow logger errors
  }
};

export class Transport {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;
  private readonly userAgent?: string;
  private readonly userApiClientId?: string;
  private readonly systemApiKey: string;
  private readonly systemUsername: string;
  private readonly bodySnippetLength: number;
  private readonly logger: Logger;
  private readonly requestLogger?: RequestLogger;
  private readonly fetchImpl?: typeof fetch;
  private readonly retryPolicy: RetryPolicy;
  private readonly retryPolicies: {
    default: RetryPolicy;
    reads: RetryPolicy;
    writes: RetryPolicy;
  };
  private readonly onHttpError: TransportConfig["onHttpError"];
  private readonly requestLoggerAdapter: RequestLoggerAdapter;
  private readonly retryExecutor: RetryExecutor;

  constructor(config: TransportConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.defaultTimeoutMs = config.defaultTimeoutMs;
    this.userAgent = config.userAgent?.trim() || undefined;
    this.userApiClientId = config.userApiClientId?.trim() || undefined;
    this.systemApiKey = config.systemApiKey;
    this.systemUsername = config.systemUsername;
    this.bodySnippetLength =
      typeof config.bodySnippetLength === "number" && config.bodySnippetLength >= 0
        ? config.bodySnippetLength
        : DEFAULT_BODY_SNIPPET_LENGTH;
    this.logger = config.logger;
    this.requestLogger = config.requestLogger;
    this.fetchImpl = config.fetchImpl;
    this.retryPolicy = config.retryPolicy;
    this.retryPolicies = config.retryPolicies;
    this.onHttpError = config.onHttpError;
    this.requestLoggerAdapter = new RequestLoggerAdapter(this.logger, this.requestLogger);
    this.retryExecutor = new RetryExecutor(this.requestLoggerAdapter);
  }

  buildUrl(path: string): string {
    return buildUrl(this.baseUrl, path);
  }

  getNormalizedBaseUrl(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }

  resolvePath(path: string): string {
    return this.buildUrl(path);
  }

  buildRequest(path: string, options: FetchOptions): BuiltRequest {
    return buildRequest(
      {
        baseUrl: this.baseUrl,
        defaultTimeoutMs: this.defaultTimeoutMs,
        userAgent: this.userAgent,
        userApiClientId: this.userApiClientId,
        systemApiKey: this.systemApiKey,
        systemUsername: this.systemUsername,
      },
      path,
      options
    );
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

  private resolveReadTimeout(options: FetchOptions, defaultTimeout: number): number {
    if (typeof options.readTimeoutMs === "number" && Number.isFinite(options.readTimeoutMs)) {
      return Math.max(0, options.readTimeoutMs);
    }
    return defaultTimeout;
  }

  async fetchApi<T>(
    path: string,
    options: FetchOptions,
    fns: RetryFns,
    resolvePolicy: (method: string, overrides?: Partial<RetryPolicy>) => RetryPolicy
  ): Promise<T | undefined> {
    const methodUpper = (options.method ?? "GET").toUpperCase();
    const retryPolicy = resolvePolicy(methodUpper, options.retryPolicy);
    const meta = { url: buildUrl(this.baseUrl, path), method: methodUpper };

    return this.retryExecutor.runWithRetry<T>(
      async (attempt) => {
        const request = this.buildRequest(path, options);
        const effectiveReadTimeout = this.resolveReadTimeout(options, request.effectiveTimeout);
        const { response, cleanup } = await this.fetchWithTimeout(
          request.url,
          {
            method: request.methodUpper,
            headers: request.headers,
            body: request.resolvedBody,
          },
          request.effectiveTimeout
        );

        try {
          const parsed = await parseResponse<T>({
            response,
            url: request.url,
            method: request.methodUpper,
            readTimeoutMs: effectiveReadTimeout,
            bodySnippetLength: this.bodySnippetLength,
            logger: this.logger,
            onHttpError: this.onHttpError,
          });
          return { value: parsed, status: response.status };
        } finally {
          cleanup();
        }
      },
      meta,
      retryPolicy,
      fns
    );
  }
}

export class RequestBuilder {
  private readonly config: {
    baseUrl: string;
    defaultTimeoutMs: number;
    userAgent?: string;
    userApiClientId?: string;
    systemApiKey: string;
    systemUsername: string;
  };

  constructor(config: {
    baseUrl: string;
    defaultTimeoutMs: number;
    userAgent?: string;
    userApiClientId?: string;
    systemApiKey: string;
    systemUsername: string;
  }) {
    this.config = {
      ...config,
      baseUrl: normalizeBaseUrl(config.baseUrl),
    };
  }

  build(path: string, options: FetchOptions) {
    return buildRequest(this.config, path, options);
  }

  buildUrl(path: string) {
    return buildUrl(this.config.baseUrl, path);
  }

  getNormalizedBaseUrl() {
    return this.buildUrl("").replace(/\/+$/, "");
  }

  resolvePath(path: string) {
    return this.buildUrl(path);
  }
}

export class ResponseParser {
  private readonly bodySnippetLength: number;
  private readonly logger: Logger;
  private readonly onHttpError: TransportConfig["onHttpError"];

  constructor(params: {
    bodySnippetLength?: number;
    logger: Logger;
    onHttpError: TransportConfig["onHttpError"];
  }) {
    this.bodySnippetLength = Math.max(
      0,
      params.bodySnippetLength ?? DEFAULT_BODY_SNIPPET_LENGTH
    );
    this.logger = params.logger;
    this.onHttpError = params.onHttpError;
  }

  async parse<T>(params: {
    response: Response;
    cleanup: () => void;
    url: string;
    method: string;
    readTimeoutMs?: number;
  }): Promise<T | undefined> {
    try {
      return await parseResponse<T>({
        response: params.response,
        url: params.url,
        method: params.method,
        readTimeoutMs: params.readTimeoutMs,
        bodySnippetLength: this.bodySnippetLength,
        logger: this.logger,
        onHttpError: this.onHttpError,
      });
    } finally {
      params.cleanup();
    }
  }

  /* c8 ignore start */
  async handleHttpError(
    response: Response,
    meta: {
      url: string;
      method: string;
      headersGet: ((name: string) => string | null) | null;
    }
  ) {
    await logAndThrowHttpError({
      response,
      url: meta.url,
      method: meta.method,
      headersGet: meta.headersGet,
      bodySnippetLength: this.bodySnippetLength,
      logger: this.logger,
      onHttpError: this.onHttpError,
    });
  }
  /* c8 ignore end */
}

export class RequestLoggerAdapter {
  private readonly logger: Logger;
  private readonly requestLogger?: RequestLogger;

  constructor(logger: Logger, requestLogger?: RequestLogger) {
    this.logger = logger;
    this.requestLogger = requestLogger;
  }

  log(params: {
    url: string;
    method: string;
    attempt: number;
    durationMs?: number;
    outcome: "success" | "retry" | "fail";
    status?: number;
    error?: unknown;
    retryDelayMs?: number;
  }) {
    logRequest(this.logger, this.requestLogger, params);
  }
}

export class RetryExecutor {
  private readonly logger: RequestLoggerAdapter;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(logger: RequestLoggerAdapter, sleepFn: (ms: number) => Promise<void> = sleep) {
    this.logger = logger;
    this.sleepFn = sleepFn;
  }

  async runWithRetry<T>(
    fn: (attempt: number) => Promise<T | { value: T | undefined; status?: number } | undefined>,
    meta: { url: string; method: string },
    retryPolicy: RetryPolicy,
    fns: RetryFns
  ): Promise<T | undefined> {
    let attempt = 0;
    while (true) {
      const start = Date.now();
      try {
        const result = await fn(attempt);
        const value =
          result && typeof result === "object" && "value" in (result as any)
            ? (result as any).value
            : (result as any);
        const status =
          result && typeof result === "object" && "status" in (result as any)
            ? (result as any).status
            : undefined;

        this.logger.log({
          url: meta.url,
          method: meta.method,
          attempt,
          durationMs: Date.now() - start,
          outcome: "success",
          status,
        } as any);

        return value;
      } catch (error) {
        const canRetry = attempt < retryPolicy.maxRetries && fns.shouldRetry(error);
        if (canRetry) {
          const delayMs = fns.computeDelayMs(error, attempt, retryPolicy);
          this.logger.log({
            url: meta.url,
            method: meta.method,
            attempt,
            durationMs: undefined,
            outcome: "retry",
            status: (error as any)?.status,
            retryDelayMs: delayMs,
            error,
          } as any);
          await this.sleepFn(delayMs);
          attempt += 1;
          continue;
        }
        this.logger.log({
          url: meta.url,
          method: meta.method,
          attempt,
          durationMs: undefined,
          outcome: "fail",
          status: (error as any)?.status,
          error,
        } as any);
        throw error;
      }
    }
  }
}

export const normalizeRetryPolicy = (
  overrides?: Partial<RetryPolicy>,
  base: RetryPolicy = {
    maxRetries: 0,
    baseDelayMs: 250,
    maxDelayMs: 5000,
    jitterRatio: 0.2,
  }
): RetryPolicy => {
  const policy = { ...base, ...overrides };
  const ensure = (value: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    maxRetries: ensure(policy.maxRetries, base.maxRetries),
    baseDelayMs: ensure(policy.baseDelayMs, base.baseDelayMs),
    maxDelayMs: ensure(policy.maxDelayMs, base.maxDelayMs),
    jitterRatio: ensure(policy.jitterRatio, base.jitterRatio),
  };
};

export const buildRetryPolicies = (
  defaultPolicy: RetryPolicy,
  overrides?: {
    default?: Partial<RetryPolicy>;
    reads?: Partial<RetryPolicy>;
    writes?: Partial<RetryPolicy>;
  }
): { default: RetryPolicy; reads: RetryPolicy; writes: RetryPolicy } => {
  const mergedDefault = normalizeRetryPolicy(overrides?.default, defaultPolicy);
  const mergedReads = normalizeRetryPolicy(overrides?.reads, mergedDefault);
  const mergedWrites = normalizeRetryPolicy(overrides?.writes, mergedDefault);
  return {
    default: mergedDefault,
    reads: mergedReads,
    writes: mergedWrites,
  };
};

export const resolveRetryPolicy = (
  method: string,
  retryPolicies: { default: RetryPolicy; reads: RetryPolicy; writes: RetryPolicy },
  overrides?: Partial<RetryPolicy>
): RetryPolicy => {
  const basePolicy =
    method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD"
      ? retryPolicies.reads
      : retryPolicies.writes;
  return overrides ? normalizeRetryPolicy(overrides, basePolicy) : basePolicy;
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

const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
};
