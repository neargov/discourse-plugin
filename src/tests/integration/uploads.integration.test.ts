import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupIntegrationTest } from "./helpers";

const ctx = setupIntegrationTest();

describe("multipart uploads", () => {
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  it("rejects multipart completion when parts are empty", async () => {
    const { client } = await ctx.useClient();

    await expect(
      client.completeMultipartUpload({
        uniqueIdentifier: "upload-empty",
        uploadId: "upload-1",
        key: "uploads/key",
        parts: [],
        filename: "file.txt",
      })
    ).rejects.toThrow(/input validation failed/i);
  });

  it("surfaces Discourse errors on multipart completion mismatch", async () => {
    const { client } = await ctx.useClient();

    ctx.fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      headers: {
        get: (key: string) =>
          key.toLowerCase() === "content-type"
            ? "text/plain"
            : key.toLowerCase() === "content-length"
              ? "18"
              : null,
      },
      text: async () => "Upload ID mismatch",
    });

    await expect(
      client.completeMultipartUpload({
        uniqueIdentifier: "upload-2",
        uploadId: "expected-id",
        key: "uploads/key",
        parts: [{ partNumber: 1, etag: "etag-1" }],
        filename: "file.txt",
      })
    ).rejects.toThrow(/upload id mismatch/i);
  });
});
