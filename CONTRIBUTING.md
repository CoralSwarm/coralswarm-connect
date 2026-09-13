# Contributing

This is the public CoralSwarm Connect plugin. `hooks/` execute on every installer's machine, so supply-chain review is the security boundary.

## Pull requests

1. Branch from `main`. Do not push to `main`.
2. Run `node tests/run.mjs` and `bash scripts/check-version.sh`.
3. Open a PR. Squash-merge is the only allowed merge method.
4. Fork PRs need a review from a code owner (`@saad172`). Pushing after approval dismisses that review.

## What to change where

| Change | Files |
|---|---|
| Hook kernel / host adapters | `hooks/` |
| MCP URL | `.mcp.json` **and** `mcp.json` (must stay identical literals) **and** `server.json` (`remotes[0].url`) |
| Host install metadata | `.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/` |
| MCP Registry listing | `server.json` |
| Tests | `tests/run.mjs` |

Do not add npm dependencies without a discussion. The plugin is plain Node on purpose.

## Releasing

The release version lives in four manifests (`.claude-plugin/plugin.json`,
`.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`, `server.json`) and
`scripts/check-version.sh` fails if they disagree. Bump all four in a PR; after
it merges, push a `vX.Y.Z` tag matching them. The tag runs
`.github/workflows/release.yml`, which re-checks the tag against the manifests
and publishes `server.json` to the official MCP Registry. Never tag a commit
whose manifests say something else — the workflow refuses it.

Versions must be strict SemVer 2.0.0. The rule lives twice — `SEMVER_ERE` in
`scripts/check-version.sh` and `SEMVER` in `tests/run.mjs` — and `tests/run.mjs`
runs both over one shared table, so change them together or the suite fails.

If you add a **new** manifest that carries a version, add it to `DECLARED` in
`scripts/check-version.sh`; the script fails on any unregistered `version` field
rather than quietly ignoring it.

`release.yml` pins `mcp-publisher` to an exact release and verifies its SHA-256
before running it — that step is handed the registry signing key, so it must not
execute an unverified binary. Bumping `MCP_PUBLISHER_VERSION` **requires**
updating `MCP_PUBLISHER_SHA256` in the same commit; take the digest from the
pinned release's `registry_<version>_checksums.txt`.

## Secrets

Never commit `.env`, credentials, or private keys. Token-bearing git remotes must be stripped by `normalizeRemote` before they can appear in hook output — add a test if you touch that path.
