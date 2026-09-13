#!/usr/bin/env node
// CoralSwarm Connect — install/uninstall the auto-capture hooks.
//
// Copies the hook scripts to ~/.coralswarm/hooks/ and merges the hook entries
// into a Claude Code settings.json. Idempotent: re-running never duplicates
// entries, and it only ever touches hooks whose command points at the
// CoralSwarm hooks directory — existing/user hooks are left untouched.
//
// Usage:
//   node install.mjs [--scope project|user] [--no-stop] [--uninstall]
//     --scope project  (default) -> ./.claude/settings.json  (this repo only)
//     --scope user               -> ~/.claude/settings.json   (every session)
//     --no-stop                  omit the terminal Stop backstop hook
//     --uninstall                remove the CoralSwarm hooks from the target

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const scope = val("--scope", "project");
const noStop = has("--no-stop");
const uninstall = has("--uninstall");

const HOME = homedir();
const HOOKS_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "hooks");
const HOOKS_DST = join(HOME, ".coralswarm", "hooks");
const MARKER = join(".coralswarm", "hooks"); // any hook command containing this is ours

const settingsPath = scope === "user"
  ? join(HOME, ".claude", "settings.json")
  : join(process.cwd(), ".claude", "settings.json");

function readJson(p) {
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8") || "{}"); }
  catch (e) { console.error(`! ${p} is not valid JSON — aborting so nothing is lost.`); process.exit(1); }
}
function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

// True when a hook entry is one of ours — i.e. it references the CoralSwarm
// hooks directory. We must recognize BOTH shapes so reinstall/uninstall stays
// idempotent across an upgrade:
//   • the legacy shell-string form: `{ command: "node /…/.coralswarm/hooks/x.mjs" }`
//   • the current exec form:        `{ command: "node", args: ["/…/.coralswarm/hooks/x.mjs"] }`
// so the marker can live in `command` OR in any `args` entry.
function isOurs(h) {
  if (String(h?.command || "").includes(MARKER)) return true;
  if (Array.isArray(h?.args) && h.args.some((a) => String(a).includes(MARKER))) return true;
  return false;
}

// Strip any existing CoralSwarm hook entries (by the hooks-dir marker), leaving
// every other hook in place. Returns the cleaned hooks object.
function stripOurs(hooks) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks || {})) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks || []).length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

const settings = readJson(settingsPath);
settings.hooks = stripOurs(settings.hooks || {});

if (uninstall) {
  writeJson(settingsPath, settings);
  console.log(`✓ Removed CoralSwarm hooks from ${settingsPath}`);
  process.exit(0);
}

// Copy hook scripts into the user's home so settings can reference a stable
// path. This copies EVERY file in hooks/ — including the shared library module
// project-key.mjs (imported by session-primer.mjs), which is copied but never
// registered as a hook entry below.
mkdirSync(HOOKS_DST, { recursive: true });
for (const f of readdirSync(HOOKS_SRC)) {
  const dst = join(HOOKS_DST, f);
  copyFileSync(join(HOOKS_SRC, f), dst);
  if (f.endsWith(".sh") || f.endsWith(".mjs")) { try { chmodSync(dst, 0o755); } catch {} }
}

// Exec form (command + args array) rather than a single shell string, so a home
// directory containing spaces (e.g. "/Users/Jane Doe/.coralswarm/hooks/x.mjs")
// is passed as one argument instead of being word-split by the shell.
const runner = (file) => (file.endsWith(".mjs") ? "node" : "bash");
// `matcher` is optional; when present it becomes a group-level tool-name regex
// (used for PostToolUse). stripOurs preserves it via its `{ ...g }` spread.
const group = (file, matcher) => {
  const g = { hooks: [{ type: "command", command: runner(file), args: [join(HOOKS_DST, file)] }] };
  if (matcher != null) g.matcher = matcher;
  return g;
};

// Add our entries alongside whatever is already there.
const add = (event, file, matcher) => {
  settings.hooks[event] = settings.hooks[event] || [];
  settings.hooks[event].push(group(file, matcher));
};

// Match any add_context MCP tool name regardless of how the server was
// registered: mcp__coralswarm__add_context (local) or
// mcp__claude_ai_Coralswarm__add_context (via claude.ai), etc.
const ADD_CONTEXT_MATCHER = "add_context";

add("SessionStart", "run.mjs");
add("UserPromptSubmit", "run.mjs");
add("PreCompact", "run.mjs");
if (!noStop) add("Stop", "run.mjs");
add("PostToolUse", "run.mjs", ADD_CONTEXT_MATCHER);

writeJson(settingsPath, settings);

console.log(`✓ CoralSwarm auto-capture hooks installed → ${settingsPath}`);
console.log(`  scope: ${scope}   stop-backstop: ${noStop ? "off" : "on"}`);
console.log(`  hook scripts: ${HOOKS_DST}`);
console.log(`  events: SessionStart, UserPromptSubmit (debounced), PreCompact${noStop ? "" : ", Stop"}, PostToolUse (${ADD_CONTEXT_MATCHER})`);
console.log(`  Capture happens DURING the session — SessionStart primes it AND`);
console.log(`  emits sanitized session metadata (project/branch/remote/hostname,`);
console.log(`  credentials stripped), the debounced UserPromptSubmit nudge saves`);
console.log(`  periodically and notes branch switches, and PreCompact flushes`);
console.log(`  before any context is compacted. A per-session activity ledger`);
console.log(`  (${join(".coralswarm", "state", "sessions")}) lets the next SessionStart`);
console.log(`  deterministically RECONCILE sessions that were hard-killed with`);
console.log(`  unsaved work — PostToolUse stamps a save whenever add_context runs.`);
console.log(`  Uninstall: --uninstall.`);
