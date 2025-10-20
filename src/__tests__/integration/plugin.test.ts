import type { PluginRegistry } from "every-plugin";
import { createLocalPluginRuntime } from "every-plugin/testing";
import { beforeAll, describe, expect, it } from "vitest";
import DiscoursePlugin from "../../index";

const TEST_REGISTRY: PluginRegistry = {
  "@neargov/discourse": {
    remoteUrl: "http://localhost:3014/remoteEntry.js",
    version: "0.0.1",
    description: "Discourse NEAR plugin for integration testing",
  },
};

const TEST_PLUGIN_MAP = {
  "@neargov/discourse": DiscoursePlugin,
} as const;

const TEST_CONFIG = {
  variables: {
    discourseBaseUrl: "https://discuss.near.vote",
    discourseApiUsername: "system",
    clientId: "test-client",
    recipient: "social.near",
  },
  secrets: {
    discourseApiKey: "test-api-key",
  },
};

describe("Discourse Plugin Integration Tests", () => {
  const runtime = createLocalPluginRuntime<typeof TEST_PLUGIN_MAP>(
    {
      registry: TEST_REGISTRY,
      secrets: { DISCOURSE_API_KEY: "test-api-key" },
    },
    TEST_PLUGIN_MAP
  );

  beforeAll(async () => {
    const { initialized } = await runtime.usePlugin(
      "@neargov/discourse",
      TEST_CONFIG
    );
    expect(initialized).toBeDefined();
    expect(initialized.plugin.id).toBe("@neargov/discourse");
  });

  describe("ping procedure", () => {
    it("should return healthy status", async () => {
      const { client } = await runtime.usePlugin(
        "@neargov/discourse",
        TEST_CONFIG
      );

      const result = await client.ping();

      expect(result).toEqual({
        status: "ok",
        timestamp: expect.any(String),
        discourseConnected: true,
      });
    });
  });

  describe("getUserApiAuthUrl procedure", () => {
    it("should generate auth URL successfully", async () => {
      const { client } = await runtime.usePlugin(
        "@neargov/discourse",
        TEST_CONFIG
      );

      const result = await client.getUserApiAuthUrl({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      expect(result.authUrl).toContain(
        "https://discuss.near.vote/user-api-key/new"
      );
      expect(result.authUrl).toContain("client_id=test-client");
      expect(result.authUrl).toContain("application_name=Test%20Application");
      expect(result.nonce).toBeDefined();
      expect(typeof result.nonce).toBe("string");
      expect(result.nonce.length).toBeGreaterThan(0);
    });

    it("should generate unique nonces", async () => {
      const { client } = await runtime.usePlugin(
        "@neargov/discourse",
        TEST_CONFIG
      );

      const result1 = await client.getUserApiAuthUrl({
        clientId: "test-client",
        applicationName: "Test App",
      });

      const result2 = await client.getUserApiAuthUrl({
        clientId: "test-client",
        applicationName: "Test App",
      });

      expect(result1.nonce).not.toBe(result2.nonce);
    });
  });

  describe("getLinkage procedure", () => {
    it("should return null for non-existent linkage", async () => {
      const { client } = await runtime.usePlugin(
        "@neargov/discourse",
        TEST_CONFIG
      );

      const result = await client.getLinkage({
        nearAccount: "nonexistent.near",
      });

      expect(result).toBeNull();
    });
  });

  describe("completeLink procedure", () => {
    it("should reject invalid nonce", async () => {
      const { client } = await runtime.usePlugin(
        "@neargov/discourse",
        TEST_CONFIG
      );

      await expect(
        client.completeLink({
          payload: "fake-encrypted-payload",
          nonce: "invalid-nonce",
          authToken: "fake-auth-token",
        })
      ).rejects.toThrow();
    });
  });

  describe("createPost procedure", () => {
    it("should reject when no linkage exists", async () => {
      const { client } = await runtime.usePlugin(
        "@neargov/discourse",
        TEST_CONFIG
      );

      await expect(
        client.createPost({
          authToken: "fake-auth-token",
          title: "Test Post Title Here",
          raw: "This is a test post content that is long enough.",
        })
      ).rejects.toThrow();
    });
  });
});
