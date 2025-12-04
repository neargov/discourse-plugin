import { DEFAULT_BODY_SNIPPET_LENGTH, TRANSIENT_STATUSES } from "./constants";
import type { NonceManager } from "./nonce-manager";
import { NonceCapacityError } from "./nonce-manager";
import { DiscourseApiError } from "./client";
import { serializeError } from "./utils";

export type PluginErrorConstructor = (payload: {
  message: string;
  data: Record<string, unknown>;
}) => unknown;

export type PluginErrorConstructors = Partial<
  Record<
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "BAD_REQUEST"
    | "RATE_LIMITED"
    | "TOO_MANY_REQUESTS"
    | "SERVICE_UNAVAILABLE",
    PluginErrorConstructor
  >
>;

const isDiscourseApiError = (value: unknown): value is DiscourseApiError =>
  value instanceof DiscourseApiError;

export const mapDiscourseApiError = (
  error: unknown,
  errors?: PluginErrorConstructors
) => {
  if (!isDiscourseApiError(error) || !errors) {
    return error;
  }

  const buildPayload = (message: string = error.message) => ({
    message,
    data: {
      status: error.status,
      path: error.path,
      method: error.method,
      retryAfterMs: error.retryAfterMs,
      requestId: error.requestId,
    },
  });

  const handlers: Record<number | "badRequest" | "transient" | "serverError", typeof errors[keyof typeof errors]> = {
    401: errors.UNAUTHORIZED,
    403: errors.FORBIDDEN,
    404: errors.NOT_FOUND,
    badRequest: errors.BAD_REQUEST,
    transient: errors.TOO_MANY_REQUESTS,
    serverError: errors.SERVICE_UNAVAILABLE,
  };

  const applyHandler = (handler?: (payload: { message: string; data: Record<string, unknown> }) => unknown, message?: string) => {
    if (typeof handler !== "function") return error;
    return handler(buildPayload(message)) ?? error;
  };

  if (handlers[error.status]) {
    return applyHandler(handlers[error.status]);
  }

  if (error.status === 400 || error.status === 422) {
    return applyHandler(handlers.badRequest);
  }

  if (TRANSIENT_STATUSES.has(error.status)) {
    return applyHandler(handlers.transient);
  }

  if (error.status >= 500) {
    return applyHandler(handlers.serverError);
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

export const resolveCause = (cause: unknown): string | undefined => {
  if (!cause) return undefined;
  const serialized = serializeError(cause);
  return typeof serialized === "string" ? serialized : serialized.message;
};

export const resolveBodySnippet = (
  error: unknown,
  maxBodySnippetLength: number
): string | undefined => {
  if (!isDiscourseApiError(error) || typeof error.bodySnippet !== "string") {
    return undefined;
  }

  return error.bodySnippet.slice(
    0,
    Math.min(maxBodySnippetLength, error.bodySnippetMaxLength)
  );
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
    const cause = resolveCause((error as any)?.cause);
    return cause ? { ...payload, cause } : payload;
  }

  const resolvedSnippet = resolveBodySnippet(error, maxBodySnippetLength);

  return {
    ...payload,
      status: error.status,
      path: error.path,
      method: error.method,
      retryAfterMs: error.retryAfterMs,
      requestId: error.requestId,
      bodySnippet: resolvedSnippet,
      cause: resolveCause((error as any)?.cause),
      context: error.context,
  };
};
