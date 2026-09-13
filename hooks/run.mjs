#!/usr/bin/env node
// CoralSwarm capture dispatcher — the ONLY command hooks.json / install.mjs
// should invoke. Normalizes host stdin, routes to the library scripts, dual-
// emits stdout, records hybrid inventory, and no-ops a second SessionStart
// for the same session_id (Claude plugin cache + Cursor marketplace overlap).

import { run as runPrimer } from "./session-primer.mjs";
import { run as runNudge } from "./capture-nudge.mjs";
import { run as runFlush } from "./precompact-save.mjs";
import { run as runTracker } from "./save-tracker.mjs";
import {
  readStdinSync,
  parsePayload,
  normalize,
  emit,
  primerAlreadyRan,
  markPrimerRan,
  markObserved,
  inventoryLine,
  isAddContext,
} from "./harness.mjs";

function main() {
  const canonical = normalize(parsePayload(readStdinSync()));
  const event = canonical.hook_event_name;
  const sid = canonical.session_id;

  try {
    markObserved(sid, event);
  } catch {
    /* non-fatal */
  }

  let context = "";
  try {
    if (event === "SessionStart") {
      if (primerAlreadyRan(sid)) {
        emit(event, "");
        return;
      }
      markPrimerRan(sid);
      context = runPrimer(canonical) || "";
      const observed = markObserved(sid, event);
      const inv = inventoryLine(observed);
      context = context ? `${context}\n${inv}` : inv;
    } else if (event === "UserPromptSubmit") {
      context = runNudge(canonical) || "";
    } else if (event === "PreCompact" || event === "Stop") {
      context = runFlush(canonical) || "";
    } else if (event === "PostToolUse") {
      if (isAddContext(canonical.tool_name)) runTracker(canonical);
      context = "";
    }
  } catch {
    // Never block the turn.
    context = "";
  }
  emit(event || "SessionStart", context);
}

main();
