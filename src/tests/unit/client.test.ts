import { describe, expect, it } from "vitest";
import { DiscourseClient } from "../../client";

describe("DiscourseClient utilities", () => {
  it("exposes a safe logger wrapper", () => {
    const client = new DiscourseClient("https://example.com", "key", "system");

    const safe = client.getSafeLogger();
    expect(typeof safe.error).toBe("function");

    expect(() => safe.error("oops")).not.toThrow();
  });

  it("flags only transport-style errors as retryable", () => {
    const client = new DiscourseClient("https://example.com", "key", "system");

    const retryable = (client as any).shouldRetry(
      new TypeError("NetworkError when attempting to fetch resource")
    );
    const notRetryable = (client as any).shouldRetry(new Error("validation failed: bad input"));

    expect(retryable).toBe(true);
    expect(notRetryable).toBe(false);
  });
});
