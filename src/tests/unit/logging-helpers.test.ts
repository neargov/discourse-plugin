import { describe, expect, it } from "vitest";
import { sanitizeErrorForLog, resolveBodySnippet, resolveCause } from "../../index";
import { DiscourseApiError } from "../../service";

describe("logging helpers", () => {
  it("resolves body snippet respecting configured max and server cap", () => {
    const error = new DiscourseApiError({
      status: 500,
      path: "/boom",
      method: "GET",
      bodySnippet: "abcdefghij",
      bodySnippetMaxLength: 4,
    });

    expect(resolveBodySnippet(error, 10)).toBe("abcd");
    expect(resolveBodySnippet(error, 2)).toBe("ab");
    expect(resolveBodySnippet(new Error("no snippet"), 5)).toBeUndefined();
  });

  it("sanitizes Discourse errors with trimmed snippets", () => {
    const error = new DiscourseApiError({
      status: 429,
      path: "/rate",
      method: "GET",
      retryAfterMs: 1500,
      requestId: "req-xyz",
      bodySnippet: "123456789",
      bodySnippetMaxLength: 6,
    });

    const sanitized = sanitizeErrorForLog(error, 5);

    expect(sanitized).toMatchObject({
      message: error.message,
      status: 429,
      path: "/rate",
      method: "GET",
      retryAfterMs: 1500,
      requestId: "req-xyz",
      bodySnippet: "12345",
    });
  });

  it("resolves causes for both Error and primitive values", () => {
    const errorCause = new Error("inner");
    const stringCause = "simple cause";

    expect(resolveCause(errorCause)).toBe("inner");
    expect(resolveCause(stringCause)).toBe("simple cause");
    expect(resolveCause(undefined)).toBeUndefined();
  });
});
