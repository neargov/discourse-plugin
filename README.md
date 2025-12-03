# Discourse Plugin

Type-safe Discourse integration for every-plugin runtimes. Exposes common forum operations (link, create/edit posts, search, browse) with built-in retry, logging, and nonce management.

## Installation

```bash
bun install
```

## Quick Start

```ts
import { createLocalPluginRuntime } from "every-plugin/testing";
import DiscoursePlugin from "discourse-plugin";

const runtime = createLocalPluginRuntime(
  {
    registry: {
      "discourse-plugin": {
        remoteUrl: "http://localhost:3014/remoteEntry.js",
        version: "0.0.1",
        description: "Discourse plugin",
      },
    },
    secrets: { DISCOURSE_API_KEY: process.env.DISCOURSE_API_KEY! },
  },
  { "discourse-plugin": DiscoursePlugin }
);

const { client } = await runtime.usePlugin("discourse-plugin", {
  variables: {
    discourseBaseUrl: "https://discuss.example.com",
    discourseApiUsername: "system",
    clientId: "your-client-id",
    requestTimeoutMs: 30_000,
    nonceTtlMs: 10 * 60 * 1000,
    nonceCleanupIntervalMs: 5 * 60 * 1000,
  },
  secrets: { discourseApiKey: "{{DISCOURSE_API_KEY}}" },
});

const { authUrl, nonce } = await client.initiateLink({
  clientId: "your-client-id",
  applicationName: "Your App",
});

// After Discourse redirects back with an encrypted payload:
const link = await client.completeLink({
  payload: "encrypted-payload-from-discourse",
  nonce,
});

await client.createPost({
  username: link.discourseUsername,
  title: "Hello from every-plugin",
  raw: "Posting via the Discourse plugin.",
  category: 1,
});

await runtime.shutdown();
```

## Configuration (validated via Zod)

- `discourseBaseUrl` **required**: Base Discourse URL.
- `discourseApiUsername` default `system`: Impersonated system username for API calls.
- `clientId` default `discourse-plugin`: Discourse user API client identifier.
- `requestTimeoutMs` default `30000`: Per-request timeout.
- `nonceTtlMs` default `600000`: Lifetime for issued nonces (ms).
- `nonceCleanupIntervalMs` default `300000`: Background cleanup cadence (ms).
- `logBodySnippetLength` default `500`: Maximum characters from response bodies to include in logs/errors.
- `operationRetryPolicy` optional: Override retry settings per operation type (`default`, `reads`, `writes`).
- `userAgent` optional: Custom User-Agent header.
- `discourseApiKey` **secret**: Discourse system API key (template-injected as `{{DISCOURSE_API_KEY}}`).

Observability hooks:
- `requestLogger`: Structured per-attempt request events (`path`, `method`, `attempt`, `status`, `outcome`, `retryDelayMs`, `error`).
- `fetch`: Custom `fetch` implementation for proxying, mTLS, or tracing instrumentation.

## Contract (procedures)

- `initiateLink`: Generate a user API auth URL, nonce, and expiration.
- `completeLink`: Decrypt the returned payload and resolve the Discourse user.
- `createPost`: Create a topic or reply (impersonates provided username).
- `editPost`: Edit an existing post (impersonates provided username).
- `prepareUpload`: Build an authenticated upload request for Discourse.
- `presignUpload` / `batchPresignMultipartUpload`: Request presigned URLs for direct and multipart uploads.
- `completeMultipartUpload` / `abortMultipartUpload`: Finalize or cancel multipart uploads.
- `search`: Search Discourse content with optional filters.
- `ping`: Health probe against the forum.
- `getCategories`: List categories.
- `getCategory`: Fetch a category and its subcategories.
- `getTopic`: Fetch a topic.
- `getLatestTopics`: Paginated latest topics.
- `getTopTopics`: Paginated top topics by period.
- `getPost`: Fetch a post (optionally with raw) and its topic.
- `getPostReplies`: Fetch replies for a post.
- `getUser`: Fetch a user profile.

All procedures surface `CommonPluginErrors` from every-plugin. Notable codes:
- `BAD_REQUEST`: Invalid nonce/payload/input.
- `UNAUTHORIZED`/`FORBIDDEN`: Credential or authorization issues.
- `NOT_FOUND`: Missing resources.
- `TOO_MANY_REQUESTS`: Discourse rate limits or nonce capacity reached (includes `retryAfterMs` when available).
- `SERVICE_UNAVAILABLE`: Upstream failures or missing required fields.

## Development

```bash
bun test          # unit + integration tests
bun run build     # bundle + type output
```
