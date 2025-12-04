import { describe, expect, it, vi } from "vitest";
import { logAndThrowHttpError } from "../../transport";

describe("transport stream error handling", () => {
  it("handles stream read failures and falls back to body unavailable message", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    const response: any = {
      status: 503,
      body: {
        getReader: () => ({
          read: () => Promise.reject(new Error("read failed")),
          cancel,
        }),
      },
    };

    const logger = { error: vi.fn() } as any;
    const onHttpError = vi.fn(({ status, bodySnippet }) => {
      expect(status).toBe(503);
      expect(bodySnippet).toContain("body unavail");
      return new Error("mapped");
    });

    await expect(
      logAndThrowHttpError({
        response: response as any,
        url: "/path",
        method: "GET",
        headersGet: null,
        bodySnippetLength: 16,
        logger,
        onHttpError,
      })
    ).rejects.toThrow("mapped");

    expect(cancel).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(onHttpError).toHaveBeenCalled();
  });

  it("ignores cleanup errors after successful stream read", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
    const reader = {
      read: vi.fn().mockResolvedValue({ value: undefined, done: true }),
      cancel,
    };
    const response: any = {
      status: 500,
      body: { getReader: () => reader },
    };
    const logger = { error: vi.fn() } as any;

    await expect(
      logAndThrowHttpError({
        response: response as any,
        url: "/path",
        method: "GET",
        headersGet: null,
        bodySnippetLength: 8,
        logger,
        onHttpError: ({ bodySnippet }) => {
          expect(bodySnippet).toBe("");
          return new Error("mapped");
        },
      })
    ).rejects.toThrow("mapped");

    expect(cancel).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("falls back to response.text when body reader is unavailable", async () => {
    const logger = { error: vi.fn() } as any;
    const response: any = {
      status: 404,
      text: vi.fn().mockResolvedValue("Not found"),
    };

    await expect(
      logAndThrowHttpError({
        response: response as any,
        url: "/missing",
        method: "GET",
        headersGet: null,
        bodySnippetLength: 32,
        logger,
        onHttpError: ({ bodySnippet }) => {
          expect(bodySnippet).toBe("Not found");
          return new Error("mapped");
        },
      })
    ).rejects.toThrow("mapped");

    expect(response.text).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns empty snippet when neither reader nor text are available", async () => {
    const logger = { error: vi.fn() } as any;
    const response: any = { status: 500 };

    await expect(
      logAndThrowHttpError({
        response: response as any,
        url: "/no-body",
        method: "GET",
        headersGet: null,
        bodySnippetLength: 16,
        logger,
        onHttpError: ({ bodySnippet }) => {
          expect(bodySnippet).toBe("");
          return new Error("mapped");
        },
      })
    ).rejects.toThrow("mapped");
  });
});
