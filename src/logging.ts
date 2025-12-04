import { serializeError } from "./utils";

export type Logger = {
  error: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
};

export type SafeLogger = Required<Logger>;

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
