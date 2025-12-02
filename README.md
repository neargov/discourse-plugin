# Discourse Plugin

Connect NEAR accounts with Discourse usernames to enable verifiable, signed forum interactions.

## Quick start

```bash
bun install
bun test
```

Minimal runtime wiring:

```ts
import { createLocalPluginRuntime } from "every-plugin/testing";
import DiscoursePlugin from "@neargov/discourse";

const { client } = await createLocalPluginRuntime(
  {
    registry: {
      "@neargov/discourse": {
        remoteUrl: "http://localhost:3014/remoteEntry.js",
        version: "0.0.1",
        description: "Discourse NEAR plugin",
      },
    },
    secrets: { DISCOURSE_API_KEY: process.env.DISCOURSE_API_KEY! },
  },
  { "@neargov/discourse": DiscoursePlugin }
).usePlugin("@neargov/discourse", {
  variables: {
    discourseBaseUrl: "https://discuss.near.vote",
    discourseApiUsername: "system",
    clientId: "your-client-id",
    recipient: "social.near",
    requestTimeoutMs: 30000,
    nonceTtlMs: 10 * 60 * 1000,
    nonceCleanupIntervalMs: 5 * 60 * 1000,
    signatureTtlMs: 300000,
  },
  secrets: { discourseApiKey: "{{DISCOURSE_API_KEY}}" },
});

const auth = await client.getUserApiAuthUrl({
  clientId: "your-client-id",
  applicationName: "Your App",
});

// Later: complete the link after Discourse redirects back
await client.completeLink({
  payload: "encrypted-payload-from-discourse",
  nonce: auth.nonce,
  authToken: "near-signed-token",
});

// Create a post as the linked Discourse user
await client.createPost({
  authToken: "near-signed-token",
  title: "Hello from NEAR",
  raw: "This is my first forum post via the plugin.",
  category: 1,
});
```

## Configuration (validated with Zod)

- `discourseBaseUrl` **required**: Base forum URL (https). Invalid URLs fail fast.
- `discourseApiUsername` default `system`: Impersonated username for system calls.
- `clientId` default `discourse-near-plugin`: Passed to Discourse user API auth flow.
- `recipient` default `social.near`: NEP-413 expected recipient for signature verification.
- `requestTimeoutMs` default `30000`: HTTP timeout per Discourse request.
- `nonceTtlMs` default `600000`: TTL for generated nonces (ms).
- `nonceCleanupIntervalMs` default `300000`: Background sweep cadence for expired nonces (ms).
- `signatureTtlMs` default `300000`: Max NEP-413 signature age (ms).
- `userAgent` optional: Custom User-Agent header.
- `discourseApiKey` **secret**: Discourse system API key (referenced as `{{DISCOURSE_API_KEY}}`).

## Procedures & errors (oRPC contract)

- `getUserApiAuthUrl`: returns `{ authUrl, nonce, expiresAt }`.
- `completeLink`: verifies NEAR signature, decrypts user API key, stores linkage.
- `createPost`: creates a topic or reply on behalf of linked user.
- `editPost`: edits an existing post as linked user.
- `getLinkage`, `validateLinkage`, `unlinkAccount`, `search`, `read` (topics/posts/users/categories).

Common error codes:
- `UNAUTHORIZED`: NEAR signature verification failed.
- `FORBIDDEN`: Missing linked account.
- `BAD_REQUEST`: Invalid/expired nonce or malformed payload.
- `SERVICE_UNAVAILABLE`: Upstream Discourse response missing required fields.
- `NOT_FOUND`: Linkage not present when unlinking.

Every error carries an `action` hint in `data` when relevant.

## Security & safety

- Signatures are time-bound via `signatureTtlMs`.
- Nonces expire after `nonceTtlMs` and are cleaned up continuously (`nonceCleanupIntervalMs` tunable).
- Secrets are never logged; logger failures are swallowed by the safe logger wrapper.
- Discourse requests honor timeouts and abort correctly; base URL is validated up front.

## Testing & release

```bash
bun test
bunx vitest run --coverage
bun run build
```

Before publishing:
- ensure `dist/` is fresh (`bun run build`)
- inspect the pack output: `npm pack --dry-run`
- verify coverage remains 100% (sources only)

## Type bindings for consumers

```ts
// src/types.d.ts in your consuming app
import type DiscoursePlugin from "@neargov/discourse";

declare module "every-plugin" {
  interface RegisteredPlugins {
    "@neargov/discourse": typeof DiscoursePlugin;
  }
}
```

## License

MIT

## Further docs

- Getting started: https://plugin.everything.dev/docs/getting-started
- Creating plugins: https://plugin.everything.dev/docs/creating-plugins
- Type safety: https://plugin.everything.dev/docs/getting-started/type-safety
- Using plugins: https://plugin.everything.dev/docs/using-plugins
- Local development (`createLocalPluginRuntime`): https://plugin.everything.dev/docs/using-plugins/local-development
- Testing: https://plugin.everything.dev/docs/testing
- Deployment (Module Federation, dev server, bundling): https://plugin.everything.dev/docs/creating-plugins/deployment
