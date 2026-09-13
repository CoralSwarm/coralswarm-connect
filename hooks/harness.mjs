// CoralSwarm harness adapter — normalize host stdin into a Claude-shaped
// canonical payload, dual-emit stdout both hosts accept, and keep the
// once-per-session / observed-event inventory on disk.
//
// Canonical fields the rest of the kernel speaks:
//   session_id, cwd, source, transcript_path, hook_event_name, tool_name, tool_input
//
// Cursor: workspace_roots[0] → cwd; first sessionStart without source → startup;
// tool names like `MCP: …/add_context` or CallDynamicTool args. Claude family
// (Claude Code, Codex) already match the canonical shape. Unknown hosts ride
// whichever fields they share; missing events stay dark (degrade in public).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTERED = ["primer", "nudge", "flush", "stop", "tracker"];

const EVENT_MAP = {
  sessionstart: "SessionStart",
  userpromptsubmit: "UserPromptSubmit",
  beforesubmitprompt: "UserPromptSubmit",
  precompact: "PreCompact",
  stop: "Stop",
  posttooluse: "PostToolUse",
  aftermcpexecution: "PostToolUse",
};

const OBSERVED_MAP = {
  SessionStart: "primer",
  UserPromptSubmit: "nudge",
  PreCompact: "flush",
  Stop: "stop",
  PostToolUse: "tracker",
};

export function isMain(metaUrl) {
  try {
    const here = fileURLToPath(metaUrl);
    const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
    return here === argv1;
  } catch {
    return false;
  }
}

export function readStdinSync() {
  try {
    return readFileSync(0, "utf8") || "";
  } catch {
    return "";
  }
}

export function parsePayload(raw) {
  try {
    const obj = JSON.parse(raw || "{}");
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

export function canonicalEvent(raw) {
  const s = String(raw || "");
  return EVENT_MAP[s.toLowerCase()] || s;
}

export function extractToolName(payload) {
  if (!payload || typeof payload !== "object") return "";
  const args = payload.arguments && typeof payload.arguments === "object" ? payload.arguments : null;
  if (args && (args.toolName || args.tool_name)) {
    const ns = args.namespace != null ? String(args.namespace) : "";
    const tn = String(args.toolName || args.tool_name);
    return ns ? `${ns}/${tn}` : tn;
  }
  const nested = payload.tool && typeof payload.tool === "object" ? payload.tool : null;
  const candidates = [
    payload.tool_name,
    payload.toolName,
    typeof payload.tool === "string" ? payload.tool : null,
    nested && (nested.name || nested.tool_name),
    payload.mcp_tool,
    payload.mcpTool,
  ];
  for (const c of candidates) {
    if (c != null && String(c).length) return String(c);
  }
  return "";
}

export function extractToolInput(payload) {
  if (!payload || typeof payload !== "object") return {};
  if (payload.tool_input && typeof payload.tool_input === "object") return payload.tool_input;
  if (payload.toolInput && typeof payload.toolInput === "object") return payload.toolInput;
  const args = payload.arguments && typeof payload.arguments === "object" ? payload.arguments : null;
  if (args && args.arguments && typeof args.arguments === "object") return args.arguments;
  if (args && args.toolName && typeof args === "object") {
    const { toolName, tool_name, namespace, ...rest } = args;
    if (Object.keys(rest).length) return rest;
  }
  return {};
}

// Defensive add_context detector: matcher is `add_context` (substring). Reject
// sibling tools whose names merely sit nearby (search_atoms, etc.).
export function isAddContext(toolName) {
  const n = String(toolName || "");
  if (!/add_context/i.test(n)) return false;
  if (/search_atoms|list_sessions|list_oceans|ask_ocean|get_reef/i.test(n)) return false;
  return true;
}

export function normalize(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const hook_event_name = canonicalEvent(p.hook_event_name || p.hookEventName || "");
  const session_id =
    p.session_id != null
      ? String(p.session_id)
      : p.sessionId != null
        ? String(p.sessionId)
        : p.conversation_id != null
          ? String(p.conversation_id)
          : undefined;
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  const cwd =
    (p.cwd != null && String(p.cwd).length ? String(p.cwd) : "") ||
    (roots.length && roots[0] != null ? String(roots[0]) : "") ||
    process.cwd();
  let source = p.source != null ? String(p.source) : undefined;
  if (source == null && hook_event_name === "SessionStart") source = "startup";
  const transcript_path = p.transcript_path != null ? p.transcript_path : p.transcriptPath;
  const tool_name = extractToolName(p);
  const tool_input = extractToolInput(p);
  return {
    ...p,
    session_id,
    cwd,
    source,
    transcript_path,
    hook_event_name,
    tool_name,
    tool_input,
  };
}

function stateDir(home = homedir()) {
  return join(home, ".coralswarm", "state");
}

function safeId(id) {
  return String(id == null ? "unknown" : id).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function primerAlreadyRan(sessionId, home = homedir()) {
  if (!sessionId) return false;
  try {
    return existsSync(join(stateDir(home), `primer-${safeId(sessionId)}`));
  } catch {
    return false;
  }
}

export function markPrimerRan(sessionId, home = homedir()) {
  if (!sessionId) return;
  try {
    const dir = stateDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `primer-${safeId(sessionId)}`), String(Math.floor(Date.now() / 1000)));
  } catch {
    /* non-fatal */
  }
}

export function markObserved(sessionId, event, home = homedir()) {
  if (!sessionId) return [];
  const key = OBSERVED_MAP[event];
  if (!key) return readObserved(sessionId, home);
  try {
    const dir = stateDir(home);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `observed-${safeId(sessionId)}`);
    let set = [];
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, "utf8") || "[]");
        if (Array.isArray(parsed)) set = parsed;
      } catch {
        set = [];
      }
    }
    if (!set.includes(key)) set.push(key);
    writeFileSync(p, JSON.stringify(set));
    return set;
  } catch {
    return [key];
  }
}

export function readObserved(sessionId, home = homedir()) {
  if (!sessionId) return [];
  try {
    const p = join(stateDir(home), `observed-${safeId(sessionId)}`);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function inventoryLine(observed) {
  const seen = Array.isArray(observed) && observed.length ? observed.join(",") : "(none yet)";
  return `[CoralSwarm capture] registered: ${REGISTERED.join(", ")}. observed this session: ${seen}.`;
}

export function dualPayload(hookEventName, additionalContext) {
  if (!additionalContext) return {};
  return {
    additional_context: additionalContext,
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
}

export function emit(hookEventName, additionalContext) {
  const body = dualPayload(hookEventName, additionalContext);
  process.stdout.write(JSON.stringify(body));
  process.exitCode = 0;
}
