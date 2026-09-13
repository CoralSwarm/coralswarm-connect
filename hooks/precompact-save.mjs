#!/usr/bin/env node
// CoralSwarm PreCompact (and optional Stop) hook — the "don't lose it"
// checkpoint. Fires right before the conversation is compacted (or at Stop, if
// installed as the backstop) and injects a reminder to flush any unsaved work
// into the ocean BEFORE that context is summarized away.
//
// DEBOUNCED: Stop fires at the end of every agent turn, so a naive version would
// re-nudge on every single response. This debounces per session (default 10 min)
// so the reminder appears at most occasionally, not every turn. PreCompact is
// rare enough that the debounce almost never suppresses it.
//
// Library: `run(payload)` returns the context string (empty if debounced).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { positiveIntervalOr } from "./interval.mjs";
import { touchActivity } from "./ledger.mjs";
import { canonicalEvent, emit, isMain, parsePayload, readStdinSync } from "./harness.mjs";

const INTERVAL_SEC = positiveIntervalOr(process.env.CORALSWARM_SAVE_INTERVAL_SEC, 600); // 10 min

export function run(payload = {}) {
  const event = canonicalEvent(payload.hook_event_name) === "Stop" ? "Stop" : "PreCompact";
  const sessionId = String(payload.session_id || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");

  try {
    const rawSessionId = payload.session_id != null ? String(payload.session_id) : "";
    touchActivity({ sessionId: rawSessionId, transcriptPath: payload.transcript_path, cwd: payload.cwd });
  } catch {
    /* non-fatal */
  }

  if (event === "Stop") {
    const stateDir = join(homedir(), ".coralswarm", "state");
    const stateFile = join(stateDir, `save-${sessionId}`);
    const now = Math.floor(Date.now() / 1000);
    let last = 0;
    try {
      if (existsSync(stateFile)) last = Number(readFileSync(stateFile, "utf8").trim()) || 0;
    } catch {
      /* ignore */
    }
    if (now - last < INTERVAL_SEC) return "";
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(stateFile, String(now));
    } catch {
      /* ignore */
    }
  }

  return event === "Stop"
    ? `[CoralSwarm final save] Session wrapping up — save anything not yet in the ocean via add_context; skip if it already is (no duplicates).`
    : `[CoralSwarm save-before-compaction] Context is about to be summarized away — save anything not yet in the ocean via add_context first.`;
}

if (isMain(import.meta.url)) {
  const payload = parsePayload(readStdinSync());
  const event = canonicalEvent(payload.hook_event_name) === "Stop" ? "Stop" : "PreCompact";
  emit(event, run(payload));
}
