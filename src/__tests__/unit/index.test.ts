import { describe, expect, it, vi } from "vitest";
import { Effect } from "every-plugin/effect";
import { createWithErrorLogging, sanitizeErrorForLog } from "../../index";
import { DiscourseApiError, NonceManager } from "../../service";
import { effectHelpers } from "../../utils";

describe("sanitizeErrorForLog", () => {
  it("returns a message payload when serialization yields a string", () => {
    const sanitized = sanitizeErrorForLog("plain failure");

    expect(sanitized).toEqual({ message: "plain failure", name: undefined });
  });

  it("captures the error name when available", () => {
    const error = new Error("boom");
    error.name = "CustomError";

    const sanitized = sanitizeErrorForLog(error);

    expect(sanitized).toEqual({ message: "boom", name: "CustomError" });
  });

  it("retains Discourse API metadata for richer logs", () => {
    const error = new DiscourseApiError({
      status: 429,
      path: "/rate-limit",
      method: "GET",
      retryAfterMs: 1500,
      requestId: "req-123",
      bodySnippet: "too many requests",
    });

    const sanitized = sanitizeErrorForLog(error);

    expect(sanitized).toEqual(
      expect.objectContaining({
        message: error.message,
        name: "DiscourseApiError",
        status: 429,
        path: "/rate-limit",
        method: "GET",
        retryAfterMs: 1500,
        requestId: "req-123",
        bodySnippet: "too many requests",
      })
    );
  });
});

describe("withErrorLogging", () => {
  const makeConfig = () =>
    ({
      variables: {
        discourseBaseUrl: "https://example.com",
        discourseApiUsername: "system",
        clientId: "client",
        recipient: "social.near",
        requestTimeoutMs: 1000,
        nonceTtlMs: 2000,
        nonceCleanupIntervalMs: 1000,
        signatureTtlMs: 5000,
      },
      secrets: { discourseApiKey: "secret" },
    } as const);

  const makeLogger = () => {
    const logSpy = vi.fn<
      (payload: { level: string; message: string; meta?: Record<string, unknown> }) => void
    >();
    const log = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      meta?: Record<string, unknown>
    ) => logSpy({ level, message, meta });
    return { log, logSpy };
  };

  it("retries once when retry-after metadata is present", async () => {
    const { log, logSpy } = makeLogger();
    const nonceManager = new NonceManager();
    const error = new DiscourseApiError({
      status: 503,
      path: "/retry",
      method: "GET",
      retryAfterMs: 2500,
    });
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce("ok");
    const sleepSpy = vi
      .spyOn(effectHelpers, "sleep")
      .mockImplementation((ms) => Effect.succeed(ms));

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
    });

    const result = await withErrorLogging("retry-action", () => fn(), {});

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledWith(1000);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: "Discourse request retrying after retry-after",
        meta: expect.objectContaining({
          action: "retry-action",
          retryAfterMs: 1000,
          status: 503,
          path: "/retry",
        }),
      })
    );

    sleepSpy.mockRestore();
  });

  it("logs and maps errors when retry is not available", async () => {
    const { log, logSpy } = makeLogger();
    const nonceManager = new NonceManager();
    const boom = new Error("boom");

    const withErrorLogging = createWithErrorLogging({
      log,
      run: Effect.runPromise,
      nonceManager,
      config: makeConfig(),
    });

    await expect(
      withErrorLogging("failing-action", () => {
        throw boom;
      }, {})
    ).rejects.toBe(boom);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        message: "failing-action failed",
        meta: expect.objectContaining({
          action: "failing-action",
          error: expect.objectContaining({ message: "boom" }),
        }),
      })
    );
  });

  it("unwraps nested candidates returned from run failures", async () => {
    const { logSpy, log } = makeLogger();
    const nonceManager = new NonceManager();
    const inner = new Error("inner");

    const withErrorLogging = createWithErrorLogging({
      log,
      run: () => Promise.reject({ defect: inner }),
      nonceManager,
      config: makeConfig(),
    });

    await expect(
      withErrorLogging("unwrap-action", async () => "ok", {})
    ).rejects.toBe(inner);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("rethrows the original error when no unwrap candidates exist", async () => {
    const { logSpy, log } = makeLogger();
    const nonceManager = new NonceManager();
    const outer = new Error("outer");

    const withErrorLogging = createWithErrorLogging({
      log,
      run: () => Promise.reject(outer),
      nonceManager,
      config: makeConfig(),
    });

    await expect(
      withErrorLogging("no-candidate", async () => "ok", {})
    ).rejects.toBe(outer);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
