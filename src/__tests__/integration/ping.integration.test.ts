import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupIntegrationTest } from "./helpers";

const ctx = setupIntegrationTest();

describe("ping procedure", () => {
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  it("returns healthy status", async () => {
    ctx.fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    });

    const { client } = await ctx.useClient();

    const result = await client.ping();

    expect(result).toEqual({
      status: "healthy",
      checks: {
        discourse: true,
        cache: true,
        cleanup: true,
      },
      timestamp: expect.any(String),
    });
  });

});
