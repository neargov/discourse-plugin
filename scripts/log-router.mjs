import { createLocalPluginRuntime } from "every-plugin/testing";
import DiscoursePlugin from "../src/index.ts";

const registryEntry = {
  "discourse-plugin": {
    remoteUrl: "http://localhost:3014/remoteEntry.js",
    version: "0.0.1",
    description: "Discourse plugin",
  },
};

const runtime = createLocalPluginRuntime(
  { registry: registryEntry, secrets: { DISCOURSE_API_KEY: "mock" } },
  { "discourse-plugin": DiscoursePlugin }
);

const config = {
  variables: {
    discourseBaseUrl: "https://discuss.example.com",
    discourseApiUsername: "system",
    requestTimeoutMs: 30000,
    nonceTtlMs: 10 * 60 * 1000,
    nonceCleanupIntervalMs: 5 * 60 * 1000,
    clientId: "log-router-client",
  },
  secrets: {
    discourseApiKey: "{{DISCOURSE_API_KEY}}",
  },
};

try {
  const result = await runtime.usePlugin("discourse-plugin", config);
  console.log("usePlugin result keys", Object.keys(result));
  if (result.router) {
    console.log("router keys", Object.keys(result.router));
    console.log(
      "authRoutes keys",
      Object.keys(result.router.authRoutes ?? {})
    );
  } else {
    console.log("router not provided on usePlugin result");
  }
} finally {
  await runtime.shutdown();
  process.exit(0);
}
