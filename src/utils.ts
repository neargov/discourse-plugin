import { Effect, Fiber, Runtime } from "every-plugin/effect";

const safeStringify = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return "[unserializable error]";
  }
};

export const formatError = (error: unknown): string => {
  const extractMessage = (candidate: unknown): string | undefined => {
    if (!candidate) return undefined;

    if (candidate instanceof Error) {
      try {
        if (typeof candidate.message === "string") {
          return candidate.message;
        }
      } catch (messageError) {
        return formatError(messageError);
      }
    }

    if (typeof candidate === "object" || typeof candidate === "function") {
      try {
        const message = (candidate as any).message;
        if (typeof message === "string") {
          return message;
        }
      } catch (messageError) {
        return formatError(messageError);
      }
    }

    return undefined;
  };

  const message = extractMessage(error);
  if (message !== undefined) {
    return message;
  }

  return safeStringify(error);
};

export const serializeError = (value: unknown): { message: string; stack?: string } | string => {
  if (value instanceof Error) {
    return {
      message: formatError(value),
      stack: value.stack,
    };
  }

  return formatError(value);
};

const isSerializedError = (value: unknown): value is { message: string; stack?: string } =>
  !!value &&
  typeof value === "object" &&
  !(value instanceof Error) &&
  typeof (value as any).message === "string" &&
  (((value as any).stack === undefined && !("stack" in (value as any))) ||
    typeof (value as any).stack === "string" ||
    (value as any).stack === undefined);

export const normalizeMeta = (meta?: Record<string, unknown>) => {
  if (!meta) return undefined;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    const lowerKey = key.toLowerCase();
    if (
      value instanceof Error ||
      lowerKey === "error" ||
      lowerKey.endsWith("error") ||
      lowerKey === "reason"
    ) {
      normalized[key] = isSerializedError(value) ? value : serializeError(value);
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
};

export const effectHelpers = {
  sleep: Effect.sleep,
  interrupt: Fiber.interrupt,
};

export const unwrapError = (error: unknown): unknown => {
  if (!Runtime.isFiberFailure(error)) {
    return error;
  }

  const cause = (error as any)?.[Runtime.FiberFailureCauseId];

  if (cause?._tag === "Fail") {
    if ((cause as any).failure != null) {
      return (cause as any).failure;
    }
    if ((cause as any).error != null) {
      return (cause as any).error;
    }
    return error;
  }

  if (cause?._tag === "Die") {
    return (cause as any).defect ?? error;
  }

  return error;
};
