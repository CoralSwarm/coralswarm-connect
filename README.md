# CoralSwarm Connect

Connect the CoralSwarm MCP and turn on **automatic, in-session** capture of your
work into your ocean — at natural checkpoints *during* the session, not only
when it ends. Ships for Claude Code, Cursor, and Codex. Enable the plugin in
**one** manager; leaving two copies enabled will fire SessionStart twice (the
kernel no-ops the duplicate).

## New machine?

**Claude Code**

```bash
claude plugin marketplace add CoralSwarm/coralswarm-connect
claude plugin install coralswarm-connect@coralswarm
```

Then run `/mcp` and **Authenticate** on the `coralswarm` server (Clerk OAuth).

**Cursor** — install `coralswarm-connect` from the CoralSwarm marketplace, then
complete MCP login (`/mcp login` or the `mcp_auth` prompt) against
`https://api.coralswarm.com/mcp`. The URL must match that literal string;
Cursor rejects a `fly.dev` resource that does not match the server metadata.

**Codex** — install the same plugin; Codex may ask you to trust hooks the first
time.

Do **not** run `scripts/install.mjs` when the plugin is enabled — that would
register the same events a second time in `settings.json`.

> **Public plugin repo.** This repository is the marketplace source. The
> product backend still lives in `CoralSwarm/coralswarm`. Refresh with
> `/plugin marketplace update coralswarm`.
>
> **One-time trust + OAuth.** A plugin-provided MCP server still requires you to
> approve the server (trust prompt) and complete OAuth via `/mcp` the first time
> — the plugin declares the server, it can't pre-authorize your account.

## What the plugin sets up

1. **MCP connection** (`.mcp.json`) — declares the CoralSwarm MCP server
   (HTTP transport) so its tools (`list_oceans`, `recent_activity`, `ask_ocean`,
   `search_atoms`, `get_reef`, `add_context`, `list_sessions`, …) are available
   once you authenticate.

   The plugin `.mcp.json` is the **literal** URL
   `https://api.coralswarm.com/mcp` (hosts do not expand `${VAR:-default}`, and
   Cursor requires a byte-exact match with the server's protected-resource
   metadata). There is no separate org address; the same URL serves your
   personal ocean AND every organization you belong to. Staging or a local
   backend is a user-level MCP override (`~/.cursor/mcp.json` /
   `claude mcp add`), not a plugin edit.

   Personal vs. organization is chosen IN-BAND, not by URL: if you belong to
   ≥1 organization, the connection starts restricted to one tool,
   `list_tenants`. Call it, then call `select_tenant` with the org you want
   (or leave it unselected to work in your personal ocean) — that unlocks the
   rest of the tools, scoped to whichever plane you picked. Calling
   `select_tenant` again, any time, switches — no new session required,
   unlike the old per-URL setup.

   Want both at once? Register this SAME URL a second time under its own
   server name (see *Manual install* below) and call `select_tenant`
   independently on each registration — each gets its own OAuth connection
   and its own remembered selection. You get both tool sets in one session,
   distinguished by server name.
2. **Capture hooks** (`hooks/hooks.json`), all firing *during* a session:
   - `SessionStart` → primes the agent to load relevant ocean context and to
     save each milestone as it happens, **and emits sanitized session metadata**
     (project key, git branch, credential-stripped remote, repo path, hostname,
     harness version) for the agent to stamp onto every save. A hybrid
     **inventory line** lists registered capture events vs those observed this
     session — hosts that never fire a given event stay dark (degrade in
     public) instead of blocking the turn.
   - `UserPromptSubmit` → a **debounced** reminder (about every 15 min of active
     work) to save recent progress, plus a one-line notice when the git branch
     changes mid-session. This is the recurring, mid-session capture.
   - `PreCompact` → flushes unsaved work into the ocean right before the
     conversation is compacted, so nothing is lost.
   - `Stop` → a final backstop (debounced ~10 min).
   - `PostToolUse` (matcher `add_context`) → stamps a local activity
     ledger every time an `add_context` save runs (Claude `mcp__…add_context`,
     Cursor `MCP: …/add_context` / CallDynamicTool), powering deterministic
     recovery of crashed sessions (see below). Every event is dispatched through
     `hooks/run.mjs`.
3. **The `coralswarm-connect` skill** — say **"onboard coralswarm"** and the
   bundled skill walks through the same setup conversationally (useful if you
   installed the MCP some other way, or to verify the round-trip).

> **Plugin installs always get the `Stop` backstop.** The manual installer
> (`scripts/install.mjs`) exposes a `--no-stop` flag to omit it, but a plugin's
> `hooks.json` is static — it can't take install-time flags — so the `Stop`
> hook is always included here. It's debounced (~10 min per session), so it
> stays quiet; `PreCompact` and the mid-session nudges do most of the work.

The hooks reference `${CLAUDE_PLUGIN_ROOT}`, which Claude Code, Cursor, and
Codex expand to this plugin's install directory. Every event's command is
`node "${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs"` (Cursor ignores a separate `args`
array). Hook scripts write per-session debounce/branch/primer state under
`~/.coralswarm/state/` (shared with the manual-install path). The primer runs
once per `session_id` so a dual Claude+Cursor install does not inject twice.

### Session metadata & the credential-stripping guarantee (Phase 2)

The `SessionStart` primer reads the hook stdin payload and collects
**best-effort** session metadata — every field is individually optional and the
hook never fails or blocks if git/env is missing. The git remote is run through
`hooks/project-key.mjs`, a byte-for-byte parity port of the backend v1
normalizer (`backend/src/project_key.rs`), which **unconditionally strips
embedded credentials before the value is ever injected into the prompt** — a
token-bearing remote like `https://x:ghp_secret@github.com/a/b.git` is only ever
emitted as `github.com/a/b`. These values are best-effort provenance; the server
re-normalizes and re-validates everything.

### Deterministic reconciliation — how crashed/killed sessions get recovered

The nudges above are **model-driven**: they only help if the agent acts on them.
Three ways work still slips through:

- a **hard kill** — SIGKILL, a closed laptop, an OOM — fires **no** exit hook at
  all, so nothing can flush at death;
- the agent **ignores** a mid-session nudge;
- a **long single turn** does a lot of work between debounced reminders.

Because a dead session can't write a "you have unsaved work" marker *at* death,
the plugin writes a **heartbeat continuously during normal operation** and
**reconciles at the start of the next session**. It keeps a tiny per-session
record — **paths and timestamps only, never transcript content** — at
`~/.coralswarm/state/sessions/{session_id}.json`:

- `SessionStart`, `UserPromptSubmit`, and `Stop`/`PreCompact` bump
  `last_activity_at` (and record the transcript path, cwd, and project key);
- the `PostToolUse` hook stamps `last_save_at` whenever `add_context` runs.
  When a *recovery* save passes the **original** session's `session_id` in the
  tool input, the stamp lands on **that** session's record — which is what lets a
  save in a later session deterministically clear an earlier session's pending
  flag.

On the **next** fresh `SessionStart`, the primer scans the ledger for records
whose `last_activity_at` is **after** their `last_save_at` (i.e. work that was
never saved), scoped to the **same project**, within the last 7 days, excluding
the current session, capped at the 3 most recent. For each, it injects a bounded
instruction to **read only the tail** of that session's local transcript (these
files can be hundreds of MB — never the whole thing), curate a concise summary,
and `add_context` it with the original `session_id`. That save clears the flag.
A session is offered at most twice, then marked abandoned so the list stays
clean; records older than 30 days are pruned.

This stays entirely **local**: no backend changes, no long-lived tokens, no
raw-transcript upload. The model still curates exactly what gets saved — the
ledger only makes the *reminder* deterministic. Injection hygiene: ledger values
are **data**, so a candidate is only offered when its
`session_id` is uuid-shaped and its transcript path is a **real file physically
under your home directory**; ids and paths are control-char-stripped and
JSON-escaped, and **no transcript content** is ever read into the primer.

Tunable via env (finite-positive-clamped, like the interval vars):
`CORALSWARM_RECONCILE_WINDOW_DAYS` (7), `CORALSWARM_RECONCILE_PRUNE_DAYS` (30),
`CORALSWARM_RECONCILE_MAX_OFFERS` (2), `CORALSWARM_RECONCILE_MAX_CANDIDATES` (3).

## Tests (no dependencies)

```bash
node plugins/coralswarm-connect/tests/run.mjs
```

Runs the normalizer against the same case matrix as the Rust unit tests, an
end-to-end `session-primer` run in a temp git repo with a token-bearing remote
(asserting the secret never appears in output), graceful degradation outside a
repo, crash-reconcile, Cursor-shaped stdin through `run.mjs` (dual emit,
primer-once, `MCP:` / CallDynamicTool save stamps), the deterministic-reconcile
ledger, and `node --check` on every `.mjs`. Auto-resume (`[CoralSwarm resume]`)
is intentionally omitted.

Capture is performed by the connected agent calling the `add_context` MCP tool,
so it rides your existing OAuth — no credentials are stored and no backend
changes are required.

## Manual install / uninstall (fallback, no plugin system)

If you can't use the plugin route (older Claude Code, or you want the hooks in a
specific `settings.json` scope), the original installer still works. It copies
the hook scripts to `~/.coralswarm/hooks/` and merges the hook entries into a
Claude Code `settings.json` idempotently — it never clobbers existing hooks, and
only ever touches hooks whose command path points at the CoralSwarm hooks dir.

```bash
node plugins/coralswarm-connect/scripts/install.mjs --scope project     # this repo only (default)
node plugins/coralswarm-connect/scripts/install.mjs --scope user        # every session
node plugins/coralswarm-connect/scripts/install.mjs --scope project --no-stop     # omit the Stop backstop
node plugins/coralswarm-connect/scripts/install.mjs --scope project --uninstall
```

The manual path and the plugin path are functionally equivalent (same four
events, same commands). Don't run both against the same scope — you'd get the
hooks twice. If you install the plugin, you don't need the manual installer.

## Scope of automation & the deterministic upgrade

This is **model-driven**: capture depends on the agent acting on the hook
prompts. That's reliable for meaningful milestones but not byte-for-byte
guaranteed. A fully deterministic path — a shell hook that POSTs the raw session
transcript to CoralSwarm regardless of the agent — needs a long-lived CLI token
issued at onboarding plus an ingest-auth endpoint. That's a documented
follow-up, not built yet.

## Other hosts

A new MCP host is a **new manifest**, not a kernel rewrite. Claude Code uses
`.claude-plugin/plugin.json`; Cursor uses `.cursor-plugin/plugin.json`; Codex
uses `.codex-plugin/plugin.json`. All three point at the same `.mcp.json`,
`skills/`, and `hooks/hooks.json`. `scripts/install.mjs` remains a Claude
`settings.json` fallback (exec form: `command: "node"`, `args: [absolute
run.mjs]`) for machines without a plugin manager.
