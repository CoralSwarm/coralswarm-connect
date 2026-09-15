---
name: coralswarm-connect
description: Connect CoralSwarm MCP and configure ongoing session capture in Claude Code, Cursor, Codex, or a custom bot. Use when onboarding CoralSwarm, installing capture hooks, or wiring a bot's conversation/run checkpoints into an ocean.
---

# CoralSwarm Connect — set up session capture

Goal: after running this skill, the user's sessions are wired to their CoralSwarm
ocean so that (a) relevant ocean knowledge is loaded at the start of
each session and (b) meaningful work is saved back into the ocean **throughout
the session**, at natural checkpoints — never waiting for the session to end.

This runs entirely on the CoralSwarm MCP's existing OAuth connection. It
installs no credentials and needs no backend changes — the capture is performed
by the connected agent calling the `add_context` write tool. Supported harnesses
receive reminders from `hooks/run.mjs`. Enable the plugin in **one** manager only.

## Choose the setup path

- **Claude Code, Cursor, or Codex:** follow the setup steps below. Before the first
  save, read [Saving work](../coralswarm/SKILL.md#saving-work) for the note/session
  decision, stable IDs, call examples, retries, and confirmation criteria.
- **Custom bot with an MCP connection:** read that same save contract and the
  [Agent sessions](#agent-sessions-session_kindagent) section below. Keep IDs in the
  bot's conversation/run state and invoke `add_context` at milestones. Verify the
  first real checkpoint using the contract's confirmation steps. Hooks are useful
  only if the bot runs in a supported harness that fires them.
- **Tools already connected and asked only to save context:** use
  [Saving work](../coralswarm/SKILL.md#saving-work) directly; setup is already complete.

## What "automatic, not at session end" means here

Claude Code, Cursor, and Codex fire hooks on in-session events (names vary;
`hooks/run.mjs` normalizes them). This skill leans on the ones that happen
DURING a session, not the terminal `Stop` event. Events the host never fires
stay dark — the primer injects a compact inventory of registered vs observed
this session, and the hook never blocks a turn.

- **`SessionStart`** — runs once when a session begins. Primes the agent to be
  ocean-aware and to save each milestone as it happens, **and emits real,
  sanitized session metadata** (see below).
- **`UserPromptSubmit`** — the recurring, mid-session capture. Fires on every
  prompt but **debounces** to ~once every 15 min (per session), injecting a
  brief "save your recent progress" reminder so work is persisted as it
  accumulates, not batched for the end. (Tune via `CORALSWARM_NUDGE_INTERVAL_SEC`.)
  It also emits a **one-line branch-switch notice** when the git branch changes
  mid-session (fires once per switch, not per prompt).
- **`PreCompact`** — runs right before the conversation is compacted (the
  natural moment where context would otherwise be summarized away). It reminds
  the agent to save unsaved decisions/progress before that context is lost.

A `Stop` hook is added only as a final backstop (omit with `--no-stop`); the
whole point is that capture already happened before you got there. All four
inject an instruction into the agent's context via the hook `additionalContext`
contract, and the agent performs the actual save with the authenticated
`add_context` MCP tool.

## Session metadata (Phase 2)

At `SessionStart`, the primer reads the hook payload on stdin and gathers
**best-effort** metadata about the coding session, then injects a compact block
telling the agent to stamp every session checkpoint with those exact values:

- `session_id` (from the payload), `repo_path` (cwd), git `branch`
  (`git rev-parse --abbrev-ref HEAD`), the git `remote`, a normalized `project`
  key, `hostname`, and `harness_version`.
- The hook collects fields **individually**: if git is absent, the cwd isn't a
  repo, or a command fails, the field is silently omitted and the hook still
  succeeds. The hook never fails or blocks the session.

**Credential-stripping guarantee (P0).** The git remote is passed through the
shared `hooks/project-key.mjs` normalizer — a byte-for-byte parity port of the
backend v1 normalizer (`backend/src/project_key.rs`) — which unconditionally
strips embedded credentials (userinfo) **before** the value is ever placed into
the primer text. A token-bearing remote such as
`https://x:ghp_secret@github.com/a/b.git` is emitted only as
`github.com/a/b`; the token can never enter the conversation transcript. The
server re-normalizes everything it receives as defense in depth.

The optional provenance fields are best-effort. **`session_id` is needed to create
a session checkpoint**; copy it from the primer on each save. If it is missing,
follow the [session ID rules](../coralswarm/SKILL.md#keep-one-conversation-together)
before claiming session capture works.

The primer also emits `platform` — the harness it is running inside, as the
server's canonical slug (`claude-code`, `cursor`, `codex`, …), detected from
the harness's own environment markers (`CLAUDECODE` / `CLAUDE_CODE_VERSION`,
`CURSOR_TRACE_ID` / `CURSOR_VERSION`, any `CODEX_*`). `CORALSWARM_PLATFORM`
overrides the detection; any value is accepted and canonicalized server-side.
See [Provenance](../coralswarm/SKILL.md#provenance) for choosing `platform` versus
`model` and interpreting the client-header mismatch flag.

## Agent sessions (`session_kind=agent`)

An interactive Claude Code / Cursor session is a **coding** session. A run with
no human at the keyboard — a cloud worker, a bot, an orchestrator and the
subagents it spawns — is an **agent** session: same capture path, but the
corals land as `agent_session` and the session carries who the agent is, where
it runs and what it is doing, so the Library's *Agent sessions* facet and the
`list_sessions` / `search_atoms` filters can find it.

For a supported harness, **naming the agent is enough** — the server infers
`session_kind=agent` from `agent_name`'s presence, so no explicit opt-in is
required. `CORALSWARM_SESSION_KIND=agent` remains available as an explicit
opt-in for a harness the server can't otherwise identify (it stamps
`session_kind` itself instead of relying on inference). The primer emits these
fields with the harness-supplied **`session_id`**; copy them onto every
checkpoint. The ID keeps the run together, and the kind labels that session.

Claude Code is a **coding** harness in every mode it can run in — interactive
`cli`, `sdk-cli` (`claude -p`), `sdk-ts`, `sdk-py` — never an agent; its
`CLAUDE_CODE_ENTRYPOINT` value is never read as a kind or name signal.

| Source | `add_context` field | Notes |
| --- | --- | --- |
| Harness hook payload | `session_id` | Required for a session; reuse across the run's topics and checkpoints. |
| `CORALSWARM_AGENT_NAME` | `agent_name` | What the agent calls itself (`grokbot`, `pr-reviewer`). Naming it is sufficient for the server to infer `session_kind=agent` — no opt-in needed. |
| `CLAUDE_AGENT_SDK_CLIENT_APP` | `agent_name` | Set automatically by the Claude Agent SDK to identify the embedding application; used as a fallback name when `CORALSWARM_AGENT_NAME` isn't set. |
| `CORALSWARM_SESSION_KIND=agent` | `session_kind` | Explicit opt-in for a harness the server can't identify by itself. Optional when a name is discoverable (above). |
| `CORALSWARM_PLATFORM` | `platform` | Optional when the harness is detectable; **required** otherwise — the server rejects an agent checkpoint with no platform and an unrecognised User-Agent. |
| `CORALSWARM_TASK` | `task` | Free text or a story id (`CS-042`). Only emitted alongside the explicit `CORALSWARM_SESSION_KIND=agent` opt-in. |
| `CORALSWARM_PARENT_SESSION_ID` | `parent_session_id` | Set on a **subagent**: the spawning agent's `session_id`. Implies `session_kind=agent`. |

**Subagent roll-up.** A subagent inherits its root agent's `agent_name` and
`platform` (its own declared name is kept as `subagent_name`), and every
filter on the root — `list_sessions agent_name=…`, `search_atoms
root_session_id=…` — matches the whole tree. A hook cannot export a variable
into the harness's own environment, so when the primer runs as an agent it
adds one line naming what to set on spawned subprocesses:

    [CoralSwarm agent] subprocess env: CORALSWARM_PARENT_SESSION_ID="<this session's id>"

Set exactly that on every child you spawn (a `claude -p` run, a worker's
kickoff env); each child uses its **own `session_id`**, and the server links it. The
parent must have checkpointed at least once before a child does — a
`parent_session_id` that names no existing agent session is rejected. A root bot
omits `parent_session_id`.

**Custom bots:** pass the fields directly to MCP `add_context`, including
`session_id` and a retry-stable `checkpoint_id`, as shown in the
[minimal calls](../coralswarm/SKILL.md#minimal-mcp-calls). Environment variables
only affect the plugin hooks; setting them alone does not populate a bot's MCP call.

An existing direct HTTP integration using `/v1/ingest/atom` must follow that
endpoint's schema, including `graph_id`, `source_type`, `source_id`, `content`,
`participants`, and `timestamp`. Pass `session_id` plus the agent fields there too,
and build `source_id="cc:{session_id}:{checkpoint_id}"` in the caller. That endpoint
has no `checkpoint_id` field or MCP defaults.

## Recovering crashed/killed sessions (deterministic reconcile)

Because a hard-killed session (SIGKILL, closed laptop, OOM) fires **no** exit
hook, capture can't flush at death. So the hooks write a tiny per-session
**activity ledger** (paths + timestamps only, never transcript content) under
`~/.coralswarm/state/sessions/` — `last_activity_at` bumped on every
prompt/turn, `last_save_at` stamped by a `PostToolUse` hook whenever
`add_context` runs (Claude `mcp__…add_context`, Cursor `MCP: …/add_context` or
CallDynamicTool). On the **next** fresh `SessionStart`, the primer scans for
same-project sessions whose activity outran their last save, and injects a
bounded, injection-hardened instruction to read only the **tail** of each
crashed session's local transcript, curate a summary, and `add_context` it with
that session's `session_id` (which clears the flag). Offered at most twice then
abandoned; pruned after 30 days. Entirely local — no backend, tokens, or
raw-transcript upload; the model still curates what gets saved. When you drive
this skill in **plugin mode you do nothing extra** — the `PostToolUse` ledger
hook ships in `hooks.json`; the manual installer registers it too.

## Tests

`node tests/run.mjs` runs a dependency-free suite:
the normalizer against the same case matrix as the Rust unit tests, an
end-to-end `session-primer` run in a temp git repo with a token-bearing remote
(asserting the secret never appears in output), graceful degradation outside a
repo, crash-reconcile, Cursor-shaped stdin through `run.mjs`, and `node --check`
on every `.mjs`. Auto-resume (`[CoralSwarm resume]`) is omitted.

## Are you already running as the plugin?

This skill ships **inside the `coralswarm-connect` plugin**. If the plugin is
installed (Claude Code, Cursor, or Codex), two things are already done for you
and you must NOT redo them:

- the MCP server is declared by the plugin's `.mcp.json` (you only need the
  one-time OAuth), and
- the four capture hooks are already active via the plugin's `hooks/hooks.json`
  — **do NOT run `scripts/install.mjs`**, or the hooks would fire twice (once
  from the plugin, once from `settings.json`).

Quick check — is the plugin installed?

```bash
claude plugin list 2>/dev/null | grep -i coralswarm-connect
# Cursor: Plugins → CoralSwarm Connect
```

- **If it lists `coralswarm-connect`** → you're in plugin mode. Skip the
  `install.mjs` step entirely; just do Step 1 (finish the OAuth) and Step 3
  (confirm). The hooks are already on.
- **If it does NOT** (the skill was copied in standalone, or you're on an older
  Claude Code without the plugin system) → follow all three steps below,
  including the manual `install.mjs` in Step 2.

## Steps to run

Work through these in order. Prefer the project scope unless the user asks for
global.

### 1. Confirm / establish the MCP connection

Check whether the CoralSwarm MCP is already connected:

```bash
claude mcp list 2>/dev/null | grep -i coralswarm
```

- If it shows `✔ Connected`, continue.
- **Plugin mode:** the plugin's `.mcp.json` already declares the `coralswarm`
  server, so `claude mcp add` is unnecessary — the server appears on its own.
  Just make sure the user has approved the server (trust prompt) and completed
  the one-time OAuth: Claude Code `/mcp` → Authenticate; Cursor `/mcp login` or
  the `mcp_auth` prompt. The declared URL is the literal
  `https://api.coralswarm.com/mcp` — Cursor requires a byte-exact match with
  the server's protected-resource metadata.

  **There is only one URL now — personal vs. organization is chosen IN-BAND,
  by a tool call, not by which URL/host you connect to** (claim-based-tenancy
  §Phase 3 PR 3.3 retired the separate org MCP address).
  `https://api.coralswarm.com/mcp` is the SAME address for a personal ocean
  and for every organization the user belongs to. Do NOT point it at
  `<org-slug>.api.coralswarm.com` or `coralswarm-backend.fly.dev` — those
  either fall back silently to personal or fail Cursor's resource match.

  If the user belongs to ≥1 organization, the connection starts restricted to
  exactly one callable tool: `list_tenants`. Call it, present the returned
  organizations to the user **by name** (never pick or guess on their
  behalf), then call `select_tenant` with the `org_id` they choose. Only
  after that does the rest of the tool catalogue unlock, scoped to that
  org's content. Calling `select_tenant` with no `org_id` (or an empty one)
  returns to their personal ocean. The choice is remembered for this MCP
  connection and re-verified as a live membership on every call — it
  survives across turns in the same session, but a BRAND NEW connection
  (a fresh `claude mcp add` registration, or removing/re-adding the server)
  starts the choice over.

  Two things still worth telling them:

  1. A user with NO organizations never sees this restriction at all — their
     full catalogue is available from the very first call, exactly as before.
  2. Switching organizations mid-session is a normal tool call
     (`select_tenant` again) — no env var, no new session, unlike the old
     per-URL setup.

  **Both planes at once** is still possible: register the SAME apex URL as a
  SECOND server under its own name (see the non-plugin instructions below),
  each getting its OWN OAuth connection and therefore its OWN independent
  `select_tenant` state. They then get both tool sets in one session,
  distinguished by server name — call `select_tenant` once on the second
  registration to point it at the org, and leave the first on personal.
- If it is missing (non-plugin mode), register it (prod URL):

  ```bash
  claude mcp add --transport http coralswarm https://api.coralswarm.com/mcp
  ```

  Then tell the user to complete the one-time Clerk OAuth consent in the browser
  window that opens on first use. (Staging URL, for testing:
  `https://coralswarm-backend-staging.fly.dev/mcp`.)

  This ONE URL serves both the personal ocean and every organization the user
  belongs to — there is no separate org address anymore. If they belong to
  ≥1 organization, the connection starts restricted to `list_tenants` only:
  call it, present the organizations by name, then call `select_tenant` with
  their pick to unlock the rest of the tools against that org's content (or
  leave it on personal — nothing else to do). To work in a SECOND org (or an
  org plus personal) at once in the same session, register this same URL
  again under a different server name (e.g.
  `claude mcp add --transport http coralswarm-acme https://api.coralswarm.com/mcp`)
  and call `select_tenant` on that registration independently — each
  registration gets its own OAuth connection and its own remembered
  selection. Do not guess an org's name: ask, or call `list_tenants` and read
  the names back.

- Verify the tools are reachable by calling the `list_oceans` MCP tool. Note the
  user's **primary** ocean id — the hooks reference "your primary ocean", and
  the agent resolves it via `list_oceans` at runtime, so nothing is hard-coded.

> If the tools are connected in `claude mcp list` but NOT available in this
> running session, they were added after the session started. Tell the user to
> resume the session (`claude -c`) so the tools load, then re-run this skill.

### 2. Install the auto-capture hooks (non-plugin mode only)

> **Skip this entire step in plugin mode.** If `claude plugin list` showed
> `coralswarm-connect`, the hooks are already active via the plugin's
> `hooks/hooks.json` — running `install.mjs` would install them a SECOND time
> into settings.json and every hook would fire twice. Go straight to Step 3.

Run the installer bundled with this plugin — `scripts/install.mjs`. It lives at
the **plugin root's** `scripts/` dir, which is two levels up from this SKILL.md
(`SKILL_DIR` below is this skill's own directory, e.g.
`skills/coralswarm-connect`, wherever the plugin is
installed — resolve it from where you loaded this SKILL.md; the installer is at
`$SKILL_DIR/../../scripts/install.mjs`). It copies the hook scripts to
`~/.coralswarm/hooks/` and merges the hook entries into settings.json
idempotently (it never clobbers existing hooks, and re-running is safe):

```bash
node "$SKILL_DIR/../../scripts/install.mjs" --scope project
# from a repo checkout you can equivalently run it by its repo path:
#   node scripts/install.mjs --scope project
```

- `--scope project` (default) writes to `./.claude/settings.json` — capture is
  enabled only in this repo.
- `--scope user` writes to `~/.claude/settings.json` — capture in every session.
- `--no-stop` omits the terminal `Stop` backstop hook.

Node is required (the hook scripts are Node too). If it isn't installed, tell
the user to install Node, or show them the settings.json snippet from the
skill's README to add by hand.

### 3. Confirm and explain

- Show the user which scope was configured and which capture hooks are active.
- Use the first real checkpoint to confirm capture, following
  [Confirm the result](../coralswarm/SKILL.md#confirm-the-result). Include the session
  fields and verify its session record; a successful standalone note proves only
  note ingestion. Reuse a checkpoint already saved during setup instead of writing
  another test coral.
- Explain the behavior: the agent will now load recent ocean context at the
  start of a session and save meaningful milestones as it works; `PreCompact`
  requests a save before compaction. Capture depends on the agent making the call.

## Notes & extension

- **Determinism.** This is model-driven: capture depends on the agent following
  the primer, which is reliable for meaningful milestones but not byte-perfect.
  For fully deterministic capture (a shell hook that POSTs the raw transcript
  regardless of the agent), CoralSwarm needs a long-lived CLI token issued at
  onboarding + an ingest-auth path — a documented follow-up, not yet built.
- **Other hosts.** Cursor and Codex load the same kernel via their own
  plugin manifests. `install.mjs` remains Claude `settings.json` fallback only.
- **Turning it off.** `node "$SKILL_DIR/../../scripts/install.mjs" --uninstall
  --scope project` removes the hooks (matched by their command path, so nothing
  else is touched). In plugin mode there is nothing to uninstall this way —
  disable the plugin instead (`claude plugin disable coralswarm-connect`).
