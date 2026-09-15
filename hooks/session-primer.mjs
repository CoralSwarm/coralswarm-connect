#!/usr/bin/env node
// CoralSwarm SessionStart hook — makes the session ocean-aware, primes
// capture-as-you-go, AND emits real, sanitized session metadata (Phase 2) so
// the agent can stamp every add_context call with provenance.
//
// The hook payload arrives on stdin as JSON (session_id, cwd, transcript_path,
// hook_event_name, source). This hook now READS it and gathers best-effort
// metadata about the coding session: repo path, git branch, git remote
// (credential-stripped), a normalized project key, hostname, and harness
// version. Every one of those is INDIVIDUALLY OPTIONAL — if git isn't present,
// the cwd isn't a repo, or a command fails, the field is silently omitted and
// the hook still succeeds. The hook must NEVER fail or block the session.
//
// SECURITY (P0): the git remote is passed through the v1 project-key normalizer
// (./project-key.mjs), which unconditionally strips embedded credentials
// (userinfo) BEFORE the value is ever placed into the primer text. A
// token-bearing remote like https://x:ghp_secret@github.com/a/b.git must never
// be injected into the conversation transcript. We only ever emit the
// normalized, credential-free form.
//
// The metadata is BEST-EFFORT PROVENANCE (audit D5 rework): the model copies
// these values onto add_context calls, but nothing downstream may depend on
// their completeness — the server re-normalizes and re-validates everything.
//
// Auto-resume of prior sessions (Phase 6 list_sessions / search_atoms) is
// intentionally omitted — capture contract: crash-reconcile stays, auto-resume
// does not. The harness dispatcher (run.mjs) maps a first Cursor sessionStart
// with no `source` to `startup` so reconcile still runs on that host.

import { writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { normalizeRemote, projectKey } from "./project-key.mjs";
import { positiveIntervalOr } from "./interval.mjs";
import {
  touchActivity,
  listRecords,
  pruneOld,
  markOffered,
  markAbandoned,
  isUuidish,
} from "./ledger.mjs";
import { emit, isMain, parsePayload, readStdinSync } from "./harness.mjs";

// Which harness this hook is running inside, as the server's canonical
// `platform` slug (backend `services::platform::KNOWN_PLATFORMS`). Emitted for
// EVERY session kind: harmless on a coding session, REQUIRED on an agent
// session (the server 422s an agent checkpoint that names no platform and
// whose User-Agent it cannot recognise). `CORALSWARM_PLATFORM` overrides the
// detection outright — a custom bot running under a generic runtime sets it
// to whatever it is. Any value is accepted; the server canonicalizes it.
export function detectHarness(env = process.env) {
  const explicit = env.CORALSWARM_PLATFORM;
  if (explicit && explicit.trim()) return explicit.trim();
  if (env.CLAUDE_CODE_VERSION || env.CLAUDECODE || env.CLAUDECODE_VERSION || env.CLAUDE_CODE_ENTRYPOINT) {
    return "claude-code";
  }
  if (env.CURSOR_VERSION || env.CURSOR_TRACE_ID || env.CURSOR_AGENT || env.CURSOR_SESSION_ID) return "cursor";
  if (Object.keys(env).some((k) => k.startsWith("CODEX_"))) return "codex";
  return undefined;
}

// The Claude Agent SDK's own env var naming the embedding application --
// "who the bot is" from the SDK's point of view. VERIFIED against the actual
// consumer: `strings` on the Claude Code 2.1.272 binary shows it building a
// User-Agent comment as `` client-app/${env.CLAUDE_AGENT_SDK_CLIENT_APP} `` and
// forwarding the SAME raw value verbatim as the `x-client-app` HTTP header --
// Claude Code itself never splits or parses it, and treats
// `CLAUDE_AGENT_SDK_VERSION` as a wholly separate env var for the SDK's own
// version. So in Claude Code's own usage this is a bare app name, not a
// "name/version" pair. We normalize defensively anyway, since a THIRD-PARTY
// embedding app (not Claude Code) is free to put anything in it: take the
// substring before the first "/" or whitespace, trim, and cap at 256 chars.
function normalizeClientApp(raw) {
  const v = raw != null ? String(raw).trim() : "";
  if (!v) return undefined;
  const head = v.split(/[/\s]/, 1)[0].slice(0, 256);
  return head.length ? head : undefined;
}

// Best-effort agent-NAME discovery, independent of the `session_kind` opt-in
// below. `CORALSWARM_AGENT_NAME` is an operator naming their own bot;
// `CLAUDE_AGENT_SDK_CLIENT_APP` is the Claude Agent SDK's embedding
// application naming itself (see normalizeClientApp above). The former wins
// when both are set, since it is the more specific, deliberately-chosen name.
function discoverAgentName(env) {
  const clean = (v) => (v && v.trim() ? v.trim() : undefined);
  return clean(env.CORALSWARM_AGENT_NAME) || normalizeClientApp(env.CLAUDE_AGENT_SDK_CLIENT_APP);
}

// Agent identity, in two independent layers:
//
//  - NAME DISCOVERY (no opt-in required): whenever discoverAgentName() finds a
//    name, the primer stamps `agent_name` alone. It deliberately does NOT
//    also declare `session_kind=agent` here -- the backend is gaining
//    server-side kind inference (agent_name present => agent session), so
//    the plugin's job is naming, not classifying. Declaring `agent` from
//    here would make the server's "agent needs a platform" 422 fire on
//    harnesses this hook cannot identify -- and per the founder's definition
//    an agent session is a NAMED AUTONOMOUS AGENT PRODUCT (grokbot, OpenClaw,
//    Viktor); Claude Code is a CODING harness in every mode (`cli`,
//    `sdk-cli`/`claude -p`, `sdk-ts`, `sdk-py`), so `CLAUDE_CODE_ENTRYPOINT`
//    must never be read as a kind signal. A name alone lets the server infer
//    agent when it can and degrade to coding when it can't -- nothing that
//    saves today may stop saving.
//  - EXPLICIT OPT-IN (server `SessionKind::Agent`, unchanged): a background
//    harness run -- a cloud worker, a bot, an orchestrator -- exports
//    `CORALSWARM_SESSION_KIND=agent` before the harness starts, and the
//    primer stamps `session_kind=agent agent_name=... task=...` on every
//    add_context so the run lands as an agent session instead of an
//    anonymous coding one. This stays the escape hatch for a harness the
//    server cannot identify by itself. `CORALSWARM_PARENT_SESSION_ID` links a
//    subagent to the agent that spawned it: the coordinator exports ITS OWN
//    session_id under that name before spawning, the child's primer reads it
//    here, and the server rolls the child up to the root (inheriting its
//    agent_name / platform).
//
// Absent both discovery and opt-in → no agent fields at all, byte-identical
// to before.
export function agentFields(env = process.env) {
  const kind = (env.CORALSWARM_SESSION_KIND || "").trim();
  const clean = (v) => (v && v.trim() ? v.trim() : undefined);
  const parent = clean(env.CORALSWARM_PARENT_SESSION_ID);
  const name = discoverAgentName(env);
  if (kind !== "agent" && !parent) {
    return name ? [["agent_name", name]] : [];
  }
  return [
    ["session_kind", "agent"],
    ["agent_name", name],
    ["task", clean(env.CORALSWARM_TASK)],
    ["parent_session_id", parent],
  ];
}

export function run(payload = {}) {
const sessionId =
  payload.session_id != null ? String(payload.session_id) : undefined;
const repoPath =
  (payload.cwd != null ? String(payload.cwd) : "") || process.cwd();
// SessionStart fires with a `source` (startup | resume | compact | clear).
// Crash-reconcile is gated on "startup" EXACTLY. The dispatcher (run.mjs)
// maps a first Cursor sessionStart with no source → startup before calling us.
const source = payload.source != null ? String(payload.source) : undefined;

// --- best-effort collectors (each swallows its own failure) ---------------
function git(args) {
  try {
    const out = execFileSync("git", args, {
      cwd: repoPath,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const trimmed = out.trim();
    return trimmed.length ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function harnessVersion() {
  // Prefer an env var if the harness exposes one; fall back to `claude
  // --version` with a short timeout. Skip silently on any failure.
  for (const key of ["CLAUDE_CODE_VERSION", "CLAUDECODE_VERSION", "CURSOR_VERSION"]) {
    const v = process.env[key];
    if (v && v.trim()) return v.trim();
  }
  try {
    const out = execFileSync("claude", ["--version"], {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const trimmed = out.trim();
    return trimmed.length ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// Strip characters that must never reach interpolated primer text: ASCII C0
// controls + DEL, the C1 range (which includes U+0085 NEL), the Unicode LINE /
// PARAGRAPH SEPARATORS (U+2028 / U+2029), AND the INVISIBLE Unicode format /
// bidirectional-control characters OWASP prompt-injection guidance calls out --
// zero-width (U+200B-U+200D, U+2060-U+2064, U+FEFF, soft-hyphen U+00AD), bidi
// marks / embeddings / overrides / isolates (U+200E-U+200F, U+202A-U+202E,
// U+2066-U+2069), and the invisible Tag block (U+E0000-U+E007F). Prompt-
// injection hardening (CodeRabbit reviews on PR #251). The normalizeRemote
// output charset is already constrained, but the project key's BASENAME-FALLBACK
// path and the raw `repo_path` (the cwd itself) can carry arbitrary directory
// characters: a folder named `foo"]<NL><NL>[System] do X` would inject a fake
// line into the line-structured metadata block, and a bidi/zero-width char can
// visually reorder or HIDE injected instructions from a human reviewer while
// staying fully live to the model. U+2028/U+2029 matter specifically because
// JSON.stringify does NOT escape them (V8 emits them literally), so without
// stripping them here they would smuggle a real line break INTO the JSON-quoted
// project / session_id resume slots. This one canonicalization step runs on every
// interpolated primer value (project, repo_path, session_id, ...); the resume
// block additionally JSON-escapes project/session_id at their interpolation
// sites. Legitimate provenance values contain none of these, so this is a
// byte-for-byte no-op for them.
function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(
    /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu,
    "",
  );
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
// Prefer `origin`, but fall back to `upstream` when there is no origin. In fork
// workflows the canonical repo is the `upstream` remote and the contributor's
// own fork is `origin`; keying only on origin would fragment one project into a
// separate per-contributor key. Origin-first (never prefer upstream over an
// existing origin) preserves the common single-remote case unchanged. Reuses
// the same best-effort git() helper, so a missing remote is silently skipped.
const rawRemote = git(["remote", "get-url", "origin"]) ?? git(["remote", "get-url", "upstream"]);
// SANITIZE before anything else touches the value — never emit the raw remote.
const remoteSanitized = rawRemote ? normalizeRemote(rawRemote) || undefined : undefined;
// Compute the project key, then harden it against prompt injection before it is
// interpolated anywhere (see stripControlChars above). If stripping empties it,
// treat it as absent (no project → no resume block, no project metadata line).
const projectRaw = projectKey(rawRemote, repoPath) || undefined;
const project = projectRaw ? stripControlChars(projectRaw) || undefined : undefined;
let host;
try {
  host = hostname() || undefined;
} catch {
  host = undefined;
}
const version = harnessVersion();
const platform = detectHarness();
const agent = agentFields();
const isAgent = agent.length > 0;

// --- persist the branch the primer captured, so capture-nudge can detect a
// mid-session branch switch and note it. Keyed by session_id, alongside the
// existing debounce state. Best-effort; never fatal. ----------------------
if (sessionId && branch) {
  try {
    const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    const stateDir = join(homedir(), ".coralswarm", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, `branch-${safeId}`), branch);
  } catch {
    /* non-fatal */
  }
}

// --- deterministic reconcile ledger (crash-recovery) ----------------------
// Heartbeat THIS session (record its project + provenance) and prune stale
// records. Runs on every SessionStart source; the reconcile OFFER below is
// startup-gated. All best-effort — the ledger must never break the primer.
const DAY_SEC = 86400;
const RECONCILE_WINDOW_SEC = positiveIntervalOr(process.env.CORALSWARM_RECONCILE_WINDOW_DAYS, 7) * DAY_SEC;
const RECONCILE_PRUNE_SEC = positiveIntervalOr(process.env.CORALSWARM_RECONCILE_PRUNE_DAYS, 30) * DAY_SEC;
const RECONCILE_MAX_OFFERS = positiveIntervalOr(process.env.CORALSWARM_RECONCILE_MAX_OFFERS, 2);
const RECONCILE_MAX_CANDIDATES = positiveIntervalOr(process.env.CORALSWARM_RECONCILE_MAX_CANDIDATES, 3);
const NOW_SEC = Math.floor(Date.now() / 1000);

try {
  touchActivity({ sessionId, transcriptPath: payload.transcript_path, cwd: repoPath, project });
} catch {
  /* non-fatal */
}
try {
  pruneOld(RECONCILE_PRUNE_SEC);
} catch {
  /* non-fatal */
}

// --- build the metadata block (only lines for fields we actually have) ----
const fields = [
  ["session_id", sessionId],
  ["project", project],
  ["repo_path", repoPath],
  ["remote", remoteSanitized],
  ["branch", branch],
  ["hostname", host],
  ["harness_version", version],
  ["platform", platform],
  ...agent,
];
const metaLines = fields
  .filter(([, v]) => v != null && String(v).length > 0)
  // Strip control characters from EVERY interpolated value (prompt-injection
  // hardening, CodeRabbit review on PR #251). The block is a line-structured
  // "  key: value" list, so a value carrying a raw newline (or other control
  // char) could otherwise inject a fake metadata line or an entirely
  // attacker-controlled instruction line. This reaches not just `project` (whose
  // basename-fallback path can carry arbitrary directory chars) but also
  // `repo_path`, which is the raw cwd and can equally contain a hostile folder
  // name. Legitimate provenance values contain no control chars, so this is a
  // no-op for them.
  // Values are JSON-QUOTED, not bare, for two reasons: the block is now a
  // single space-delimited `key="value"` line, so an unquoted value containing
  // a space (a repo path like `/Users/me/My Repo`) would split into two bogus
  // pairs; and quoting keeps the injection surface identical to the resume
  // block's. stripControlChars still runs FIRST — JSON.stringify does not
  // escape U+2028/U+2029, so stripping is what actually prevents a smuggled
  // line break (see the function's own comment).
  .map(([k, v]) => `${k}=${JSON.stringify(stripControlChars(v))}`)
  .join(" ");

// One line, values only. Every instruction that used to live here — pass these
// verbatim, set a title on the first save, self-report the model, invent
// nothing — now lives in `add_context`'s TOOL DESCRIPTION, which reaches the
// model through the MCP schema instead of through the transcript. Same
// information, none of it on the user's screen. Keys are the literal
// add_context parameter names so copying them across is mechanical.
const metadataBlock = metaLines ? `[CoralSwarm capture ON] ${metaLines}` : "";

// Agent runs only: the one thing the server cannot tell a coordinator is how
// its subagents find their way back to it. A hook cannot export a variable
// into the harness's own environment, so the primer names the variable and the
// value; the agent sets it on every subprocess it spawns (a `claude -p` child,
// a Cursor worker's kickoff env) and each child's primer picks it up through
// `agentFields` above. Values only — the roll-up semantics live in
// `add_context`'s `parent_session_id` description.
const agentBlock =
  isAgent && sessionId
    ? `\n[CoralSwarm agent] subprocess env: CORALSWARM_PARENT_SESSION_ID=${JSON.stringify(stripControlChars(sessionId))}`
    : "";

// --- reconcile primer: recover crashed/killed sessions --------------------
// On a FRESH startup only, scan the ledger for prior sessions that ended with
// UNSAVED work (activity after their last save, never reconciled) and inject a
// bounded, injection-hardened instruction to read each one's transcript TAIL and
// curate a save. Startup-gated for the same reason resume is: only a new session
// should reach back for a sibling's unsaved tail.
//
// INJECTION HYGIENE (parity with the resume block's 4 hardening rounds): ledger
// values are DATA. A candidate is only offered when its session_id is uuid-ish
// and its transcript_path is a REAL FILE physically under the user's home dir;
// the id and path are control-char-stripped and JSON-escaped at interpolation;
// NO transcript CONTENT is ever read into the primer (only the path is named).
const RECONCILE_MAX_CHARS = 2200;

function relTime(ts) {
  const secs = Math.max(0, NOW_SEC - (Number(ts) || 0));
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < DAY_SEC) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / DAY_SEC)}d ago`;
}

// A transcript path is only injected when it resolves to a real regular file
// physically under the user's home directory — never an arbitrary/attacker path.
function validTranscript(p) {
  try {
    if (!p || typeof p !== "string") return false;
    const abs = resolve(p);
    const home = homedir();
    if (abs !== home && !abs.startsWith(home + sep)) return false;
    return existsSync(abs) && statSync(abs).isFile();
  } catch {
    return false;
  }
}

function reconcileCandidates() {
  let records;
  try {
    records = listRecords();
  } catch {
    return [];
  }
  const cutoff = NOW_SEC - RECONCILE_WINDOW_SEC;
  const projectKnown = !!project;
  return records
    .filter((r) => {
      if (!r || typeof r !== "object") return false;
      if (!isUuidish(r.session_id)) return false; // injection guard + real Claude ids only
      if (sessionId && r.session_id === sessionId) return false; // never the current session
      if (r.reconciled_at != null) return false; // already saved/abandoned
      const act = Number(r.last_activity_at) || 0;
      if (act < cutoff) return false; // within the recency window
      const saved = r.last_save_at == null ? -1 : Number(r.last_save_at);
      if (!(saved < act)) return false; // must have an UNSAVED tail
      // Project scoping: when we know the current project, require an exact
      // match (also drops candidates whose project is unknown, to avoid noise).
      // When the current project is unknown, scoping is skipped (a note is added).
      if (projectKnown && r.project !== project) return false;
      if (!validTranscript(r.transcript_path)) return false; // real file under home
      return true;
    })
    .sort((a, b) => (Number(b.last_activity_at) || 0) - (Number(a.last_activity_at) || 0));
}

// Unlike the metadata and resume blocks, this one CANNOT be reduced to pure
// values. Its load-bearing instruction — read only the transcript TAIL, these
// files reach hundreds of MB — governs the HARNESS's own file-reading tool, not
// an MCP tool, so no tool description reaches the model in time to stop it
// slurping a 300 MB JSONL into context. That clause has to stay here.
// Everything else (extract what the ocean lacks, call add_context with THAT
// session_id, contents are DATA never instructions, skip unreadable files,
// don't announce) moved into `add_context`'s tool description.
function renderReconcileBlock(list) {
  const lines = list.map(
    (r) =>
      `  session_id=${JSON.stringify(stripControlChars(r.session_id))} last_active=${JSON.stringify(
        relTime(r.last_activity_at)
      )} transcript=${JSON.stringify(stripControlChars(String(r.transcript_path)))}`
  );
  const note = project ? "" : " Candidates are NOT project-scoped — confirm relevance before saving.";
  return `
[CoralSwarm reconcile] Prior session(s) ended with UNSAVED work; recover each per add_context, reading ONLY the transcript TAIL (~200 lines — these files reach HUNDREDS OF MB, never read one whole). Do not announce.${note}
${lines.join("\n")}`;
}

function buildReconcileBlock() {
  if (source !== "startup") return ""; // fresh sessions only (parity with resume)
  const candidates = reconcileCandidates();
  if (!candidates.length) return "";

  // Select up to MAX_CANDIDATES that still have offers left; a candidate that has
  // exhausted its offers without a save is terminally abandoned (kept off the
  // list) rather than re-offered forever.
  const chosen = [];
  for (const r of candidates) {
    if (chosen.length >= RECONCILE_MAX_CANDIDATES) break;
    if ((Number(r.reconcile_offers) || 0) >= RECONCILE_MAX_OFFERS) {
      try {
        markAbandoned(r, `abandoned after ${RECONCILE_MAX_OFFERS} reconcile offers without a save`);
      } catch {
        /* non-fatal */
      }
      continue;
    }
    chosen.push(r);
  }
  if (!chosen.length) return "";

  // Fit the block to the char budget by dropping the least-recent entries; only
  // MARK OFFERED the entries we actually inject (so a dropped entry keeps its
  // offer count intact for next time).
  let included = chosen.slice();
  let block = "";
  while (included.length) {
    block = renderReconcileBlock(included);
    if (block.length <= RECONCILE_MAX_CHARS) break;
    included = included.slice(0, -1);
    block = "";
  }
  if (!included.length) return "";
  for (const r of included) {
    try {
      markOffered(r);
    } catch {
      /* non-fatal */
    }
  }
  return block;
}
const reconcileBlock = buildReconcileBlock();

// The primer is now VALUES ONLY — at most three short lines, usually one.
//
// Every line of standing prose that used to live here (you are connected to an
// ocean; load context before starting; save as you go; resolve the primary
// ocean; don't set source_type; keep notes self-contained; never save secrets)
// was IDENTICAL on every session, yet was re-injected into the transcript every
// time — costing screen space on top of context. It now ships through the MCP
// server's `instructions` and the `add_context` / `list_sessions` tool
// descriptions, which the model receives through the protocol and the user
// never sees. Nothing was dropped; only the delivery channel changed.
//
// What HAS to stay here is what the server cannot know: this session's id, the
// resolved project key and repo path, and which prior sessions crashed unsaved.
const PRIMER =
  [metadataBlock, agentBlock, reconcileBlock].filter(Boolean).join("").trim() ||
  "[CoralSwarm capture ON]";

return PRIMER;
}

if (isMain(import.meta.url)) {
  emit("SessionStart", run(parsePayload(readStdinSync())));
}
