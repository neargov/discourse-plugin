const port = Number(process.env.PLUGIN_PORT ?? 3014);

const config = {
  variables: {
    discourseBaseUrl:
      process.env.DISCOURSE_BASE_URL ?? "https://discuss.example.com",
    discourseApiUsername: process.env.DISCOURSE_API_USERNAME ?? "system",
    clientId: process.env.DISCOURSE_CLIENT_ID ?? "discourse-plugin",
    requestTimeoutMs: 30_000,
    requestsPerSecond: 10,
    rateLimitBucketTtlMs: 5 * 60 * 1000,
    rateLimitMaxBuckets: 1_000,
    rateLimitStrategy: "global",
    cacheMaxSize: 500,
    cacheTtlMs: 60_000,
    nonceTtlMs: 10 * 60 * 1000,
    nonceCleanupIntervalMs: 5 * 60 * 1000,
    userApiScopes: "read,write",
    logBodySnippetLength: 500,
  },
  secrets: {
    discourseApiKey: process.env.DISCOURSE_API_KEY ?? "dev-api-key",
  },
};

export default { port, config };
