import { constants, publicEncrypt } from "crypto";
import { Effect } from "every-plugin/effect";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { buildConfig, createRuntime, TEST_CONFIG } from "../integration/helpers";

const baseUrl = TEST_CONFIG.variables.discourseBaseUrl;

const handlers = [
  http.get(`${baseUrl}/session/current.json`, () =>
    HttpResponse.json({
      current_user: { id: 7, username: "alice", name: "Alice" },
    })
  ),
  http.post(`${baseUrl}/posts.json`, async () =>
    HttpResponse.json({
      id: 321,
      topic_id: 654,
      topic_slug: "hello-world",
    })
  ),
];

const server = setupServer(...handlers);

const encryptPayload = (publicKey: string, apiKey: string) => {
  const buffer = Buffer.from(JSON.stringify({ key: apiKey }), "utf-8");
  const encrypted = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
    buffer
  );
  return encrypted.toString("base64");
};

describe("e2e auth + post flow", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterAll(() => server.close());
  beforeEach(() => server.resetHandlers(...handlers));

  it("links a user and creates a post through the plugin boundary", async () => {
    const runtime = createRuntime();
    const { client, initialized } = await runtime.usePlugin(
      "discourse-plugin",
      buildConfig()
    );

    try {
      const link = await client.initiateLink({
        clientId: TEST_CONFIG.variables.clientId,
        applicationName: "E2E Test App",
      });

      const publicKey = link.authUrl
        ? new URL(link.authUrl).searchParams.get("public_key")
        : null;
      expect(publicKey).toBeTruthy();

      vi.spyOn(initialized.context.cryptoService, "decryptPayload").mockReturnValue(
        Effect.succeed("user-api-key-e2e")
      );

      const nonceData = initialized.context.nonceManager.get(link.nonce);
      expect(nonceData?.privateKey).toBeTruthy();

      const encryptedPayload = encryptPayload(
        publicKey as string,
        "user-api-key-e2e"
      );

      const completed = await client.completeLink({
        payload: encryptedPayload,
        nonce: link.nonce,
        clientId: TEST_CONFIG.variables.clientId,
      });

      expect(completed).toMatchObject({
        userApiKey: "user-api-key-e2e",
        discourseUsername: "alice",
        discourseUserId: 7,
      });

      const post = await client.createPost({
        title: "E2E Hello World",
        raw: "This is an end-to-end smoke test post.",
        category: 1,
        username: "alice",
    });

    expect(post).toMatchObject({
      success: true,
      postId: 321,
      topicId: 654,
      postUrl: expect.stringContaining("/hello-world/654"),
    });
    } finally {
      await runtime.shutdown();
    }
  });
});
