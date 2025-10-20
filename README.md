# Discourse Plugin

Connect NEAR accounts with Discourse usernames to enable verifiable forum interactions.

## What's Included

```bash
src/
├── contract.ts    # oRPC (4 procedures: initiate, verify, createPost, getLinkage)
├── service.ts     # Discourse API calls with NEP-413 signature verification
└── index.ts       # Plugin implementation with createPlugin
```

## Quick Start

1. **Clone repo:**

```bash
git clone https://github.com/neargov/discourse-plugin && cd discourse-plugin
```

2. **Install dependencies:**

```bash
bun install
```

3. **Configure environment:**
   Create a `.env` file with:

```
DISCOURSE_BASE_URL=https://discuss.near.vote
DISCOURSE_API_KEY=your_system_api_key
DISCOURSE_API_USERNAME=admin
DISCOURSE_RECIPIENT=social.near
```

4. **Run tests:**

```bash
bun test
```

## Every Plugin Framework

→ [Template](https://github.com/near-everything/every-plugin/tree/main/plugins/_template)

## License

MIT
