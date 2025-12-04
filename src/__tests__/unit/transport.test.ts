import { describe, expect, it, vi } from "vitest";
import {
  RequestBuilder,
  RequestLoggerAdapter,
  ResponseParser,
  RetryExecutor,
  Transport,
  logAndThrowHttpError,
  parseJsonBody,
  readBodyWithTimeout,
} from "../../transport";
import * as transportModule from "../../transport";
import type { RetryPolicy } from "../../constants";

const makeResponse = (overrides: Partial<Response> & { status?: number } = {}) =>
  ({
    ok: overrides.ok ?? false,
    status: overrides.status ?? 500,
    text: overrides.text ?? vi.fn(() => Promise.resolve("")),
    json: overrides.json,
    headers: {
      get: (name: string) =>
        (overrides as any).headers?.get?.(name) ?? (name === "content-length" ? null : null),
    },
  } as any as Response);

describe("transport helpers", () => {
  it("readBodyWithTimeout returns text content", async () => {
    const response = makeResponse({ ok: true, text: vi.fn(() => Promise.resolve("hello")) });
    const body = await readBodyWithTimeout(response, 50, "http://example.com");
    expect(body).toBe("hello");
  });

  it("parseJsonBody throws with snippet on invalid JSON", () => {
    const text = "{ bad json";
    expect(() => parseJsonBody(text, "http://example.com", 10)).toThrow(/Failed to parse JSON/);
  });

  it("parseJsonBody includes truncated snippet when body is long", () => {
    const longText = "   { broken json content that is intentionally long to exceed limit }   ";
    expect(() => parseJsonBody(longText, "http://example.com", 5)).toThrow(/…$/);
  });

  it("logAndThrowHttpError handles missing text reader gracefully", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as any;
    const onHttpError = vi.fn(() => new Error("mapped"));
    const response = { ok: false, status: 500, headers: {} } as any as Response;

    await expect(
      logAndThrowHttpError({
        response,
        url: "http://example.com/path",
        method: "GET",
        headersGet: null,
        bodySnippetLength: 10,
        logger,
        onHttpError,
      })
    ).rejects.toThrow("mapped");

    expect(logger.error).toHaveBeenCalled();
    expect(onHttpError).toHaveBeenCalled();
  });

  it("logAndThrowHttpError logs and throws mapped error", async () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    } as any;
    const mappedError = new Error("mapped");
    const onHttpError = vi.fn(() => mappedError);
    const response = makeResponse({
      status: 503,
      text: vi.fn(() => Promise.resolve("service down")),
      headers: {
        get: (name: string) => (name === "retry-after" ? "120" : null),
      },
    });

    await expect(
      logAndThrowHttpError({
        response,
        url: "http://example.com/path",
        method: "GET",
        headersGet: response.headers.get.bind(response.headers),
        bodySnippetLength: 50,
        logger,
        onHttpError,
      })
    ).rejects.toThrow(mappedError);

    expect(logger.error).toHaveBeenCalledWith(
      "Discourse API error",
      expect.objectContaining({ status: 503, path: "http://example.com/path" })
    );
    expect(onHttpError).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, retryAfterMs: 120000 })
    );
  });
});

describe("transport collaborators", () => {
  it("request builder sets auth headers correctly", () => {
    const builder = new RequestBuilder({
      baseUrl: "https://example.com",
      defaultTimeoutMs: 1000,
      userAgent: "agent",
      userApiClientId: "client",
      systemApiKey: "sys",
      systemUsername: "system",
    });

    const built = builder.build("/posts", {
      method: "post",
      body: { foo: "bar" },
      userApiKey: "user-key",
    });

    expect(built.methodUpper).toBe("POST");
    expect(built.headers["User-Api-Key"]).toBe("user-key");
    expect(built.headers["User-Api-Client-Id"]).toBe("client");
    expect(built.headers["Api-Key"]).toBeUndefined();
    expect(built.headers.Accept).toBe("application/json");
  });

  it("prefers body factory output when building request payloads", () => {
    const builder = new RequestBuilder({
      baseUrl: "https://example.com",
      defaultTimeoutMs: 1000,
      userAgent: "agent",
      userApiClientId: "client",
      systemApiKey: "sys",
      systemUsername: "system",
    });
    const bodyFactory = vi.fn(() => ({ built: true }));

    const built = builder.build("/dynamic", {
      method: "post",
      body: { built: false },
      bodyFactory,
    });

    expect(bodyFactory).toHaveBeenCalledTimes(1);
    expect(built.resolvedBody).toBe(JSON.stringify({ built: true }));
    expect(built.headers["Content-Type"]).toBe("application/json");
  });

  it("response parser parses JSON and cleans up", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      bodySnippetLength: 50,
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });
    const cleanup = vi.fn();
    const response = makeResponse({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
      text: vi.fn(() => Promise.resolve('{"hello":"world"}')),
    });

    const parsed = await parser.parse<{ hello: string }>({
      response,
      cleanup,
      url: "http://example.com",
      method: "GET",
      readTimeoutMs: 10,
    });

    expect(parsed).toEqual({ hello: "world" });
    expect(cleanup).toHaveBeenCalled();
  });

  it("short-circuits when content-length is zero without reading body", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      bodySnippetLength: 10,
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });
    const cleanup = vi.fn();
    const text = vi.fn();
    const response = makeResponse({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-length" ? "0" : null) },
      text,
    });

    const parsed = await parser.parse({
      response,
      cleanup,
      url: "http://example.com",
      method: "GET",
    });

    expect(parsed).toBeUndefined();
    expect(text).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("handles missing headers.get when reading body", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      bodySnippetLength: 10,
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });
    const cleanup = vi.fn();
    const response = {
      ok: true,
      text: vi.fn(async () => ""),
    } as any as Response;

    const parsed = await parser.parse({
      response,
      cleanup,
      url: "http://example.com",
      method: "GET",
    });

    expect(parsed).toBeUndefined();
    expect(cleanup).toHaveBeenCalled();
  });

  it("falls back to json() when body read is undefined", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      bodySnippetLength: 50,
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });
    const cleanup = vi.fn();
    const response = makeResponse({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({ ok: true })),
      text: vi.fn(),
    });
    const readSpy = vi.spyOn(transportModule, "readBodyWithTimeout");
    readSpy.mockResolvedValueOnce(undefined as any);

    const parsed = await parser.parse<{ ok: boolean }>({
      response,
      cleanup,
      url: "http://example.com",
      method: "GET",
    });

    expect(parsed).toEqual({ ok: true });
    expect(response.json).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    readSpy.mockRestore();
  });

  it("returns undefined when parsed text is only whitespace", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      bodySnippetLength: 10,
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });
    const cleanup = vi.fn();
    const response = makeResponse({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
      text: vi.fn(async () => "   "),
    });

    const parsed = await parser.parse({
      response,
      cleanup,
      url: "http://example.com",
      method: "GET",
    });

    expect(parsed).toBeUndefined();
    expect(cleanup).toHaveBeenCalled();
  });

  it("returns raw text when content-type is not JSON", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      bodySnippetLength: 10,
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });
    const cleanup = vi.fn();
    const response = makeResponse({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "text/plain" : null) },
      text: vi.fn(async () => "plain response"),
    });

    const parsed = await parser.parse<string>({
      response,
      cleanup,
      url: "http://example.com",
      method: "GET",
    });

    expect(parsed).toBe("plain response");
    expect(cleanup).toHaveBeenCalled();
  });

  it("invokes HTTP error handler when response not ok", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      bodySnippetLength: 10,
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });
    const cleanup = vi.fn();
    const response = makeResponse({ ok: false, status: 404 });

    await expect(
      parser.parse({
        response,
        cleanup,
        url: "http://example.com/not-found",
        method: "GET",
      })
    ).rejects.toThrow("err-404");

    expect(logger.error).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it("defaults body snippet length and still logs errors", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });
    const cleanup = vi.fn();
    const response = makeResponse({
      ok: false,
      status: 500,
      text: vi.fn(async () => {
        throw new Error("read-fail");
      }),
    });

    await expect(
      parser.parse({
        response,
        cleanup,
        url: "http://example.com/internal",
        method: "GET",
      })
    ).rejects.toThrow("err-500");

    expect(logger.error).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it("invokes handleHttpError directly for non-ok responses", async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
    const parser = new ResponseParser({
      logger,
      onHttpError: (payload) => new Error(`err-${payload.status}`),
    });

    await expect(
      (parser as any).handleHttpError(
        makeResponse({ ok: false, status: 418 }),
        { url: "http://example.com", method: "GET", headersGet: null }
      )
    ).rejects.toThrow("err-418");

    expect(logger.error).toHaveBeenCalled();
  });

  it("request logger adapter normalizes attempt numbers", () => {
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    const requestLogger = vi.fn();
    const adapter = new RequestLoggerAdapter(logger as any, requestLogger);

    adapter.log({
      url: "http://example.com",
      method: "GET",
      attempt: 0,
      outcome: "success",
      durationMs: 5,
      status: 200,
    });

    expect(requestLogger).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, status: 200, outcome: "success" })
    );
    expect(logger.debug).toHaveBeenCalled();
  });

  it("retry executor logs retry and uses sleep", async () => {
    const logger = new RequestLoggerAdapter(
      {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as any,
      vi.fn()
    );
    const sleepSpy = vi.fn(() => Promise.resolve());
    const executor = new RetryExecutor(logger, sleepSpy);
    let attempts = 0;
    const retryPolicy: RetryPolicy = { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };

    const result = await executor.runWithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("boom"), { status: 503 });
        }
        return "ok";
      },
      { url: "http://example.com", method: "GET" },
      retryPolicy,
      {
        shouldRetry: () => true,
        computeDelayMs: () => 0,
      }
    );

    expect(result).toBe("ok");
    expect(sleepSpy).toHaveBeenCalled();
  });
});

describe("Transport integration", () => {
  it("retries once on failure then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(
        makeResponse({
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
          text: vi.fn(() => Promise.resolve('{"ok":true}')),
        })
      );

    const requestLogger = vi.fn();
    const transport = new Transport({
      baseUrl: "https://example.com",
      defaultTimeoutMs: 50,
      userAgent: "agent",
      userApiClientId: "client",
      systemApiKey: "sys",
      systemUsername: "system",
      bodySnippetLength: 100,
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as any,
      requestLogger,
      fetchImpl: fetchMock as any,
      retryPolicy: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      retryPolicies: {
        default: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        reads: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        writes: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      },
      onHttpError: (params) => new Error(`http-${params.status}`),
    });

    const result = await transport.fetchApi<{ ok: boolean }>(
      "/foo",
      {},
      {
        shouldRetry: () => true,
        computeDelayMs: () => 0,
      },
      () => ({ maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestLogger).toHaveBeenCalledWith(expect.objectContaining({ outcome: "retry" }));
    expect(requestLogger).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
  });

  it("passes readTimeout override to parser and logs success", async () => {
    const requestLogger = { log: vi.fn() };
    const parser = { parse: vi.fn(async () => ({ ok: true })) };
    const cleanup = vi.fn();
    const response = makeResponse({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
    });
    const fetchWithTimeout = vi.fn().mockResolvedValue({ response, cleanup });

    const transport = new Transport({
      baseUrl: "https://example.com",
      defaultTimeoutMs: 50,
      userAgent: "agent",
      userApiClientId: "client",
      systemApiKey: "sys",
      systemUsername: "system",
      bodySnippetLength: 100,
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as any,
      requestLogger: vi.fn(),
      fetchImpl: vi.fn(),
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      retryPolicies: {
        default: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        reads: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        writes: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      },
      onHttpError: (params) => new Error(`http-${params.status}`),
    }) as any;

    transport.fetchWithTimeout = fetchWithTimeout;
    transport.responseParser = parser;
    transport.requestLogger = requestLogger;

    await transport.fetchApi(
      "/foo",
      { readTimeoutMs: 10 },
      {
        shouldRetry: () => false,
        computeDelayMs: () => 0,
      },
      () => ({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
    );

    expect(fetchWithTimeout).toHaveBeenCalledWith(
      "https://example.com/foo",
      expect.objectContaining({ method: "GET" }),
      50
    );
    expect(parser.parse).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/foo",
        method: "GET",
        readTimeoutMs: 10,
      })
    );
    expect(requestLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, outcome: "success" })
    );
  });

  it("falls back to request timeout when readTimeoutMs is not provided", async () => {
    const parser = { parse: vi.fn(async () => undefined) };
    const cleanup = vi.fn();
    const response = makeResponse({ ok: true, status: 200 });
    const fetchWithTimeout = vi.fn().mockResolvedValue({ response, cleanup });

    const transport = new Transport({
      baseUrl: "https://example.com",
      defaultTimeoutMs: 123,
      userAgent: "agent",
      userApiClientId: "client",
      systemApiKey: "sys",
      systemUsername: "system",
      bodySnippetLength: 100,
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      } as any,
      requestLogger: vi.fn(),
      fetchImpl: vi.fn(),
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      retryPolicies: {
        default: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        reads: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        writes: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      },
      onHttpError: (params) => new Error(`http-${params.status}`),
    }) as any;

    transport.fetchWithTimeout = fetchWithTimeout;
    transport.responseParser = parser;
    transport.requestLogger = { log: vi.fn() };

    await transport.fetchApi(
      "/bar",
      {},
      {
        shouldRetry: () => false,
        computeDelayMs: () => 0,
      },
      () => ({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 })
    );

    expect(parser.parse).toHaveBeenCalledWith(
      expect.objectContaining({
        readTimeoutMs: 123,
      })
    );
  });
});
