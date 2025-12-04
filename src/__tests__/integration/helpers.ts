import type { PluginRegistry } from "every-plugin";
import { createLocalPluginRuntime } from "every-plugin/testing";
import { vi } from "vitest";
import DiscoursePlugin, { type DiscoursePluginConfigInput } from "../../index";

export const TEST_REGISTRY: PluginRegistry = {
  "discourse-plugin": {
    remoteUrl: "http://localhost:3014/remoteEntry.js",
    version: "0.0.1",
    description: "Discourse plugin for integration testing",
  },
};

export const TEST_PLUGIN_MAP = {
  "discourse-plugin": DiscoursePlugin,
} as const;

export const TEST_CONFIG: DiscoursePluginConfigInput = {
  variables: {
    discourseBaseUrl: "https://discuss.example.com",
    discourseApiUsername: "system",
    clientId: "test-client",
    requestTimeoutMs: 30000,
    nonceTtlMs: 10 * 60 * 1000,
    nonceCleanupIntervalMs: 5 * 60 * 1000,
  },
  secrets: {
    discourseApiKey: "{{DISCOURSE_API_KEY}}",
  },
};

export const buildConfig = (overrides: Partial<DiscoursePluginConfigInput> = {}) => ({
  ...TEST_CONFIG,
  ...overrides,
  variables: {
    ...TEST_CONFIG.variables,
    ...(overrides.variables ?? {}),
  },
  secrets: {
    ...TEST_CONFIG.secrets,
    ...(overrides.secrets ?? {}),
  },
});

export const createRuntime = () =>
  createLocalPluginRuntime(
    {
      registry: TEST_REGISTRY,
      secrets: { DISCOURSE_API_KEY: "test-api-key" },
    },
    TEST_PLUGIN_MAP
  );

export type Runtime = ReturnType<typeof createRuntime>;

export const setupIntegrationTest = () => {
  let runtime: Runtime;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;

  const useClient = () => runtime.usePlugin("discourse-plugin", TEST_CONFIG);

  return {
    get runtime() {
      return runtime;
    },
    get fetchMock() {
      return fetchMock;
    },
    useClient,
    beforeEach: () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      fetchMock = vi.fn();
      originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      runtime = createRuntime();
    },
    afterEach: async () => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
      await runtime.shutdown();
    },
  };
};
