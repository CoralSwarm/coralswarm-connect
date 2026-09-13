#!/usr/bin/env node
// CoralSwarm PostToolUse hook — stamps a save on the session ledger whenever an
// add_context tool call succeeds. This is the deterministic signal the reconcile
// scan (session-primer.mjs) uses to know a session's work HAS been persisted.
//
// Matcher in hooks.json is `add_context` (substring). This module also
// re-checks the tool name defensively via harness.isAddContext so Cursor
// (`MCP: …/add_context`, CallDynamicTool) and Claude (`mcp__.*add_context`)
// both stamp, and sibling tools do not.
//
// CROSS-SESSION CLEAR: when the agent recovers a crashed session it calls
// add_context passing that ORIGINAL session's `session_id` in the tool input.
// We stamp last_save_at on THAT session's record when the id is uuid-ish AND
// the record already exists.
//
// Library: `run(payload)` performs the stamp and returns "" (no inject).

import { isUuidish, markSave, readRecord } from "./ledger.mjs";
import { emit, extractToolInput, extractToolName, isAddContext, isMain, parsePayload, readStdinSync } from "./harness.mjs";

export function run(payload = {}) {
  const toolName = extractToolName(payload) || String(payload.tool_name || "");
  if (!isAddContext(toolName)) return "";

  const currentId =
    payload.session_id != null && payload.session_id !== "" ? String(payload.session_id) : undefined;

  const input = extractToolInput(payload);
  const inputId = input.session_id != null ? String(input.session_id) : undefined;

  let target = currentId;
  if (inputId && inputId !== currentId && isUuidish(inputId) && readRecord(inputId) != null) {
    target = inputId;
  }

  if (target) {
    try {
      markSave(target);
    } catch {
      /* non-fatal */
    }
  }
  return "";
}

if (isMain(import.meta.url)) {
  run(parsePayload(readStdinSync()));
  emit("PostToolUse", "");
}
