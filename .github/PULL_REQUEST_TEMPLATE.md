## Summary

<!-- What changed and why. Hooks in this repo execute on user machines. -->

## Test plan

- [ ] `node tests/run.mjs` passes locally
- [ ] No secrets, tokens, or private keys in the diff
- [ ] If `hooks/` changed: credential-stripping and prompt-injection tests still cover the new path
- [ ] If a manifest / `.mcp.json` / `mcp.json` changed: the MCP URL is still the literal `https://api.coralswarm.com/mcp`
