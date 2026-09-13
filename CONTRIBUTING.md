# Contributing

This is the public CoralSwarm Connect plugin. `hooks/` execute on every installer's machine, so supply-chain review is the security boundary.

## Pull requests

1. Branch from `main`. Do not push to `main`.
2. Run `node tests/run.mjs`.
3. Open a PR. Squash-merge is the only allowed merge method.
4. Fork PRs need a review from a code owner (`@saad172`). Pushing after approval dismisses that review.

## What to change where

| Change | Files |
|---|---|
| Hook kernel / host adapters | `hooks/` |
| MCP URL | `.mcp.json` **and** `mcp.json` (must stay identical literals) |
| Host install metadata | `.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/` |
| Tests | `tests/run.mjs` |

Do not add npm dependencies without a discussion. The plugin is plain Node on purpose.

## Secrets

Never commit `.env`, credentials, or private keys. Token-bearing git remotes must be stripped by `normalizeRemote` before they can appear in hook output — add a test if you touch that path.
