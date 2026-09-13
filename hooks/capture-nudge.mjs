#!/usr/bin/env node
// CoralSwarm UserPromptSubmit hook — the recurring, mid-session capture, plus
// (Phase 2) a lightweight branch-switch notice.
//
// Fires on every user prompt. Two independent, quiet behaviors:
//
//  1. SAVE NUDGE (debounced ~15 min/session): injects a "save your recent
//     progress" reminder at most once per interval so work is persisted as it
//     accumulates without being noisy. Keyed on session_id.
//
//  2. BRANCH REFRESH (Phase 2): cheaply re-reads the current git branch and
//     compares it to what session-primer captured (persisted at
//     ~/.coralswarm/state/branch-<session_id>). When it differs, injects a
//     one-line note with the updated branch and records the new value — so it
//     fires at most once per actual switch, never on every prompt. If git is
//     absent or the cwd isn't a repo, this is silently skipped.
//
// Library: `run(payload)` returns the context string (empty if nothing to say).
// CLI / dispatcher emit via harness.mjs (dual JSON). Always exit 0.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { positiveIntervalOr } from "./interval.mjs";
import { touchActivity } from "./ledger.mjs";
import { emit, isMain, parsePayload, readStdinSync } from "./harness.mjs";

const INTERVAL_SEC = positiveIntervalOr(process.env.CORALSWARM_NUDGE_INTERVAL_SEC, 900); // 15 min

export function run(payload = {}) {
  const rawSessionId = payload.session_id != null ? String(payload.session_id) : "";
  const sessionId = String(payload.session_id || "unknown").replace(
    /[^A-Za-z0-9._-]/g,
    "_"
  );
  const cwd = (payload.cwd != null ? String(payload.cwd) : "") || process.cwd();

  try {
    touchActivity({ sessionId: rawSessionId, transcriptPath: payload.transcript_path, cwd });
  } catch {
    /* non-fatal */
  }

  const stateDir = join(homedir(), ".coralswarm", "state");
  const now = Math.floor(Date.now() / 1000);
  const parts = [];

  function currentBranch() {
    try {
      const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
      const t = out.trim();
      return t.length ? t : undefined;
    } catch {
      return undefined;
    }
  }

  const branchFile = join(stateDir, `branch-${sessionId}`);
  const branch = currentBranch();
  if (branch) {
    let prevBranch;
    try {
      if (existsSync(branchFile))
        prevBranch = readFileSync(branchFile, "utf8").trim() || undefined;
    } catch {
      /* ignore */
    }
    if (prevBranch && prevBranch !== branch) {
      parts.push(`[CoralSwarm] branch=${JSON.stringify(branch)} (was ${JSON.stringify(prevBranch)}) — use it on subsequent add_context calls.`);
    }
    if (prevBranch !== branch) {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(branchFile, branch);
      } catch {
        /* non-fatal */
      }
    }
  }

  const saveFile = join(stateDir, `nudge-${sessionId}`);
  let last = 0;
  try {
    if (existsSync(saveFile)) last = Number(readFileSync(saveFile, "utf8").trim()) || 0;
  } catch {
    /* ignore */
  }
  if (last === 0) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(saveFile, String(now));
    } catch {
      /* non-fatal */
    }
  } else if (now - last >= INTERVAL_SEC) {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(saveFile, String(now));
    } catch {
      /* non-fatal */
    }
    parts.push(`[CoralSwarm checkpoint] Save anything meaningful since your last add_context; skip if nothing qualifies.`);
  }

  return parts.length ? parts.join("\n\n") : "";
}

if (isMain(import.meta.url)) {
  emit("UserPromptSubmit", run(parsePayload(readStdinSync())));
}
