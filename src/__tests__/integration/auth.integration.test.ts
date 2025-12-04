import { Effect } from "every-plugin/effect";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NonceManager } from "../../service";
import { effectHelpers } from "../../utils";
import {
  buildConfig,
  createRuntime,
  setupIntegrationTest,
  TEST_CONFIG,
  TEST_PLUGIN_MAP,
  TEST_REGISTRY,
} from "./helpers";
import { createLocalPluginRuntime } from "every-plugin/testing";

const ctx = setupIntegrationTest();

describe("auth flows", () => {
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  describe("initiateLink", () => {
    it("composes auth URL with expected parameters", async () => {
      const { client } = await ctx.useClient();

      const link = await client.initiateLink({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      expect(link.authUrl).toContain("https://discuss.example.com/user-api-key/new");
      expect(link.authUrl).toContain("client_id=test-client");
      expect(link.authUrl).toContain("application_name=Test%20Application");
      expect(link.authUrl).toContain("scopes=read%2Cwrite");
      expect(link.nonce).toBeDefined();
    });

    it("computes expiry within configured window", async () => {
      const { client } = await ctx.useClient();

      const link = await client.initiateLink({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      expect(link.expiresAt).toBeDefined();
      const expiresAt = new Date(link.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now() - 1000);
      expect(expiresAt).toBeLessThan(Date.now() + TEST_CONFIG.variables.nonceTtlMs + 1000);
    });

    it("generates unique nonces per request", async () => {
      const { client } = await ctx.useClient();

      const first = await client.initiateLink({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      const second = await client.initiateLink({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      expect(first.nonce).toBeDefined();
      expect(second.nonce).toBeDefined();
      expect(first.nonce).not.toBe(second.nonce);
      expect(second.expiresAt).toBeDefined();
    });

    it("fails fast when nonce expiration cannot be computed", async () => {
      const { client, initialized } = await ctx.useClient();
      vi.spyOn(initialized.context.nonceManager, "getExpiration").mockReturnValue(null);

      await expect(
        client.initiateLink({
          clientId: "test-client",
          applicationName: "Test Application",
        })
      ).rejects.toThrow("Failed to compute nonce expiration");
    });

    it("rejects when nonce per-client limit is exceeded", async () => {
      const limitedRuntime = createLocalPluginRuntime(
        {
          registry: TEST_REGISTRY,
          secrets: { DISCOURSE_API_KEY: "test-api-key" },
        },
        TEST_PLUGIN_MAP
      );

      const { client } = await limitedRuntime.usePlugin(
        "discourse-plugin",
        buildConfig({
          variables: {
            ...TEST_CONFIG.variables,
            nonceMaxPerClient: 1,
            nonceLimitStrategy: { perClient: "rejectNew" },
          },
        })
      );

      await client.initiateLink({
        clientId: "limited-client",
        applicationName: "Limited App",
      });

      await expect(
        client.initiateLink({
          clientId: "limited-client",
          applicationName: "Limited App",
        })
      ).rejects.toThrow(/nonce.*limit/i);

      await limitedRuntime.shutdown();
    });

    it("evicts oldest nonce when strategy is evictOldest", async () => {
      const evictingRuntime = createLocalPluginRuntime(
        {
          registry: TEST_REGISTRY,
          secrets: { DISCOURSE_API_KEY: "test-api-key" },
        },
        TEST_PLUGIN_MAP
      );

      const { client, initialized } = await evictingRuntime.usePlugin(
        "discourse-plugin",
        buildConfig({
          variables: {
            ...TEST_CONFIG.variables,
            nonceMaxPerClient: 1,
            nonceLimitStrategy: { perClient: "evictOldest" },
          },
        })
      );

      const first = await client.initiateLink({
        clientId: "evict-client",
        applicationName: "Evict App",
      });

      const second = await client.initiateLink({
        clientId: "evict-client",
        applicationName: "Evict App",
      });

      expect(first.nonce).not.toBe(second.nonce);
      expect(initialized.context.nonceManager.verify(first.nonce, "evict-client")).toBe(
        false
      );
      expect(initialized.context.nonceManager.verify(second.nonce, "evict-client")).toBe(
        true
      );

      await evictingRuntime.shutdown();
    });

    it("applies configured user API scopes", async () => {
      const customRuntime = createLocalPluginRuntime(
        {
          registry: TEST_REGISTRY,
          secrets: { DISCOURSE_API_KEY: "test-api-key" },
        },
        TEST_PLUGIN_MAP
      );

      const { client } = await customRuntime.usePlugin(
        "discourse-plugin",
        buildConfig({
          variables: {
            ...TEST_CONFIG.variables,
            userApiScopes: ["read", "message"],
          },
        })
      );

      const result = await client.initiateLink({
        clientId: "test-client",
        applicationName: "Test Application",
      });

      expect(result.authUrl).toContain("scopes=message%2Cread");

      await customRuntime.shutdown();
    });

    it("fails initialization when user API scopes are invalid", async () => {
      const invalidRuntime = createRuntime();

      await expect(
        invalidRuntime.usePlugin(
          "discourse-plugin",
          buildConfig({
            variables: {
              ...TEST_CONFIG.variables,
              userApiScopes: [""],
            },
          })
        )
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringMatching(/user api scope/i),
            }),
          ]),
        }),
      });

      await invalidRuntime.shutdown();
    });
  });

  describe("completeLink", () => {
    it("rejects invalid nonce", async () => {
      const { client } = await ctx.useClient();

      await expect(
        client.completeLink({
          payload: "fake-encrypted-payload",
          nonce: "invalid-nonce",
        })
      ).rejects.toThrow(/invalid or expired nonce/i);
    });

    it("rejects expired nonce before decrypt", async () => {
      const { client, initialized } = await ctx.useClient();

      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
      const nonce = initialized.context.nonceManager.create("test-client", "private-key");
      nowSpy.mockReturnValue(11 * 60 * 1000);

      await expect(
        client.completeLink({
          payload: "irrelevant",
          nonce,
        })
      ).rejects.toThrow("Invalid or expired nonce");

      nowSpy.mockRestore();
    });

    it("returns BAD_REQUEST when payload cannot be decrypted", async () => {
      const { client, initialized } = await ctx.useClient();

      const nonce = initialized.context.nonceManager.create("test-client", "private-key");

      vi.spyOn(initialized.context.cryptoService, "decryptPayload").mockReturnValue(
        Effect.fail(new Error("decrypt failed"))
      );

      await expect(
        client.completeLink({
          payload: "encrypted",
          nonce,
        })
      ).rejects.toThrow("Invalid or expired payload");

      expect(initialized.context.nonceManager.get(nonce)).toBeNull();
    });

    it("rejects when nonce verification fails", async () => {
      const { client, initialized } = await ctx.useClient();

      const nonce = initialized.context.nonceManager.create("test-client", "private-key");

      vi.spyOn(initialized.context.nonceManager, "verify").mockReturnValue(false);

      await expect(
        client.completeLink({
          payload: "encrypted",
          nonce,
        })
      ).rejects.toThrow(/invalid or expired nonce/i);
    });

    it("completes link successfully", async () => {
      const { client, initialized } = await ctx.useClient();

      const nonce = initialized.context.nonceManager.create("test-client", "private-key");

      vi.spyOn(initialized.context.cryptoService, "decryptPayload").mockReturnValue(
        Effect.succeed("user-api-key")
      );
      vi.spyOn(initialized.context.discourseService, "getCurrentUser").mockReturnValue(
        Effect.succeed({ id: 1, username: "alice", name: "Alice" })
      );

      const result = await client.completeLink({
        payload: "encrypted",
        nonce,
      });

      expect(result).toEqual({
        userApiKey: "user-api-key",
        discourseUsername: "alice",
        discourseUserId: 1,
      });

      expect(initialized.context.nonceManager.get(nonce)).toBeNull();
    });

    it("completes link via router", async () => {
      const { client, initialized } = await ctx.useClient();
      const nonce = initialized.context.nonceManager.create("test-client", "priv-key");

      vi.spyOn(initialized.context.cryptoService, "decryptPayload").mockReturnValue(
        Effect.succeed("user-api-key")
      );
      vi.spyOn(initialized.context.discourseService, "getCurrentUser").mockReturnValue(
        Effect.succeed({ id: 7, username: "alice", name: "Alice" })
      );

      const result = await client.completeLink({
        payload: "encrypted",
        nonce,
      });

      expect(result).toEqual({
        userApiKey: "user-api-key",
        discourseUsername: "alice",
        discourseUserId: 7,
      });
    });
  });

  describe("runtime lifecycle", () => {
    const advanceTimers = async (ms: number) => {
      if (typeof vi.advanceTimersByTimeAsync === "function") {
        await vi.advanceTimersByTimeAsync(ms);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, ms));
    };

    beforeEach(() => {
      const canUseFakeTimers =
        typeof vi.advanceTimersByTimeAsync === "function" ||
        typeof vi.advanceTimersByTime === "function";
      if (canUseFakeTimers) {
        vi.useFakeTimers();
      } else {
        vi.useRealTimers();
      }
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("interrupts the cleanup fiber on shutdown", async () => {
      const interruptSpy = vi
        .spyOn(effectHelpers, "interrupt")
        .mockReturnValue(Effect.succeed({} as any));

      const { initialized } = await ctx.useClient();

      await ctx.runtime.shutdown();

      expect(interruptSpy).toHaveBeenCalledWith(initialized.context.cleanupFiber);
    });

    it("shuts down a new runtime cleanly", async () => {
      const tempRuntime = createRuntime();

      const { initialized } = await tempRuntime.usePlugin("discourse-plugin", TEST_CONFIG);
      expect(initialized.plugin.id).toBe("discourse-plugin");

      await expect(tempRuntime.shutdown()).resolves.toBeUndefined();
    });

    it("calls plugin shutdown hook", async () => {
      const { initialized } = await ctx.useClient();
      await expect(Effect.runPromise(initialized.plugin.shutdown())).resolves.toBeUndefined();
    });

    it("runs nonce cleanup immediately and on interval", async () => {
      const cleanupSpy = vi.spyOn(NonceManager.prototype, "cleanup");
      const tempRuntime = createRuntime();

      try {
        await tempRuntime.usePlugin(
          "discourse-plugin",
          buildConfig({
            variables: {
              ...TEST_CONFIG.variables,
              nonceCleanupIntervalMs: 25,
            },
          })
        );
        expect(cleanupSpy).toHaveBeenCalledTimes(1);

        await advanceTimers(75);
        expect(cleanupSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        await tempRuntime.shutdown();
        cleanupSpy.mockRestore();
      }
    });
  });
});
