# Security

This repository is a **public marketplace plugin**. The files in `hooks/` run as local Node processes inside Claude Code, Cursor, and Codex sessions. Treat a malicious merge to `main` as remote code execution on every installer who updates.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/CoralSwarm/coralswarm-connect/security/advisories/new). Do not file a public issue for:

- hook or installer RCE
- credential leakage into transcripts (git remotes, env, MCP tokens)
- prompt-injection that exfiltrates ocean contents

We will acknowledge reports and ship a fix before any public write-up.

## What this plugin must never do

- Commit or emit secrets, tokens, private keys, or raw `.env` files
- Write a credential-bearing git remote into hook output (see `hooks/project-key.mjs`)
- Call `pull_request_target` or grant `contents: write` to CI
- Expand `${VAR}` in `.mcp.json` / `mcp.json` (hosts do not expand it; Cursor requires a byte-exact URL)

## Maintainer process

- `main` accepts squash-merged pull requests only
- Fork PRs require an owner review; stale approvals are dismissed on new pushes
- CI (`test`) is a required check and runs with `contents: read` and no secrets
