# distribution-registry

Open registry of communities where AI builders post side-projects.

## Why this exists

Every indie maker keeps their own private Notion list of Telegram chats, subreddits, Discord servers, and dev directories where they post their launches. The lists go stale, overlap, and get rediscovered every six months by the next builder.

This repo consolidates that knowledge into a single machine-readable registry. Add a node once, everyone benefits. Reader apps consume the JSON directly via `raw.githubusercontent.com` — no API, no rate limits, no infrastructure.

## Structure

```
nodes/
├── telegram-chat/     # Telegram group chats
├── subreddit/         # Reddit communities
├── discord-server/    # Discord servers
└── directory/         # Product directories (Product Hunt, BetaList, etc.)
```

Each node is a single JSON file validated against [`schema.json`](./schema.json).

## How to contribute

1. Fork the repo
2. Add a new JSON file under the appropriate `nodes/<type>/` directory
3. Fill every required field (see [`schema.json`](./schema.json) and [`CONTRIBUTING.md`](./CONTRIBUTING.md))
4. Open a PR
5. CI validates schema + URL reachability
6. On green, a maintainer merges. Auto-merge on green is enabled for trusted contributors.

## Reader app

A Next.js reader app consumes this registry: _[link placeholder — coming soon]_.

The reader fetches raw JSON directly from GitHub, so your PR goes live within a minute of merge.

## Schema versioning

Current version: `1`. Breaking changes will bump `schema_version` and require a migration note in `CHANGELOG.md`. Unknown fields are rejected (`additionalProperties: false`) to keep the registry tidy.

## License

Copyright © 2026 - Present. Alexey Elizarov. See [LICENSE](./LICENSE) — personal use and contributions via GitHub Fork only; no redistribution without written consent.

## Code of conduct

Be useful. Be accurate. Don't spam. Don't add communities you've never actually posted in. If a mod asks us to remove a node, we remove it — no argument.

Disagreements get resolved by the person who did the work. Builders over bureaucrats.
