# Contributing

## Add a new node

1. Pick the right type directory under `nodes/`:
   - `telegram-chat/` — Telegram group chats (not channels)
   - `telegram-channel/` — broadcast channels (create directory if adding first one)
   - `subreddit/` — Reddit communities
   - `discord-server/` — Discord servers
   - `slack-community/` — Slack workspaces
   - `directory/` — Product Hunt, BetaList, etc.
   - `x-person/` — individual X/Twitter accounts who repost builder launches
   - `email-list/` — newsletters accepting builder submissions

2. Create `<slug>.json` where slug is kebab-case, unique across all types.

3. Fill every required field. See [`schema.json`](./schema.json) for the full contract.

## Minimum viable node

```json
{
  "schema_version": 1,
  "id": "my-cool-chat",
  "type": "telegram-chat",
  "name": "My Cool Chat",
  "url": "https://t.me/mycoolchat",
  "audience_size": 1200,
  "topics": ["indie-hackers", "ai"],
  "post_rules": "Introduce yourself first. One self-promo link per week max.",
  "post_format": "casual",
  "language": "en",
  "last_verified_at": "2026-04-24",
  "contributor": "your-github-handle"
}
```

## Rules

- **Only add communities you have actually posted in.** Drive-by additions hurt the registry.
- **Be conservative on `audience_size`.** If you don't know, use `0`. We'd rather have honest zeros than inflated guesses.
- **Write `post_rules` in your own words** — don't paste the pinned message verbatim. Summarize. Be useful.
- **Set `last_verified_at` to the day you opened the PR.**
- **`contributor`** is your GitHub handle without the `@`.

## What gets rejected

CI will reject your PR if:
- Required fields are missing
- `type` is not in the allowed enum
- `url` is malformed or returns 4xx/5xx
- `id` duplicates another node's `id`
- Any unknown field is present (`additionalProperties: false`)

Run validation locally before opening the PR:

```bash
cd scripts
bun install
bun run validate.ts
bun test ../tests/
```

## Removing a node

Open a PR deleting the file. In the PR description, state why (chat closed, mod request, etc.). No drama, no debate.
