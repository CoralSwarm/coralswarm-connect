// CoralSwarm per-session activity ledger — the deterministic half of capture.
//
// The model-driven nudges (capture-nudge / precompact-save / the primer) are
// best-effort: a hard-killed session (SIGKILL, closed laptop, OOM) fires NO exit
// hook, so an "unsaved tail" marker can never be written AT death. Instead we
// write a tiny heartbeat record CONTINUOUSLY during normal operation, and
// reconcile at the START of the next session: if a record shows activity after
// its last save and was never reconciled, its session died with unsaved work.
//
// One JSON record per session lives at
//   ~/.coralswarm/state/sessions/{session_id}.json
// and holds PATHS + TIMESTAMPS ONLY — never transcript content. Every write is
// best-effort and never throws: a ledger failure must never break a hook.
//
// SECURITY: the record is DATA, later interpolated into the SessionStart primer
// (a prompt). Sanitization/validation happens at the INJECTION boundary in
// session-primer.mjs (uuid-shape check, transcript-under-home check, control-
// char stripping, JSON-escaping). This module only stores and retrieves.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSIONS_SUBDIR = join(".coralswarm", "state", "sessions");

export function sessionsDir(home = homedir()) {
  return join(home, SESSIONS_SUBDIR);
}

// Sanitize a session id for use as a filename component. Real Claude Code
// session ids are UUIDs (only [0-9a-fA-F-]), so this is a no-op for them; the
// replacement only guards against a malformed/hostile id ever reaching the FS
// (path traversal, separators). Keying reads and writes through the SAME
// function guarantees they hit the same file.
export function sanitizeId(id) {
  return String(id == null ? "" : id).replace(/[^A-Za-z0-9._-]/g, "_");
}

// UUID shape (8-4-4-4-12 hex). Used as an injection guard: only a uuid-ish
// session id may (a) clear a DIFFERENT session's record from a later session and
// (b) be offered as a reconcile candidate whose id is interpolated into a prompt.
const UUIDISH = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isUuidish(id) {
  return typeof id === "string" && UUIDISH.test(id);
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

function recordPath(id, home) {
  return join(sessionsDir(home), `${sanitizeId(id)}.json`);
}

function freshRecord(sessionId, t) {
  return {
    session_id: String(sessionId),
    transcript_path: null,
    cwd: null,
    project: null,
    created_at: t,
    last_activity_at: t,
    last_save_at: null,
    reconciled_at: null,
    reconcile_offers: 0,
    reconcile_offered_at: null,
    reconcile_note: null,
  };
}

// Read one record; return null on missing OR corrupt (never throw). A corrupt
// file must not crash the primer — the caller just skips it.
export function readRecord(id, home = homedir()) {
  try {
    const p = recordPath(id, home);
    if (!existsSync(p)) return null;
    const obj = JSON.parse(readFileSync(p, "utf8") || "null");
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// Write one record (best-effort). Keyed by rec.session_id (or the passed id).
// Written to a same-dir temp file then renamed into place: several hook
// processes share these records, and rename is atomic on one filesystem, so a
// concurrent reader never observes a torn half-written file.
export function writeRecord(id, record, home = homedir()) {
  try {
    mkdirSync(sessionsDir(home), { recursive: true });
    const dst = recordPath(id, home);
    const tmp = `${dst}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, dst);
    return true;
  } catch {
    return false;
  }
}

// Heartbeat: create-or-update the current session's record with fresh activity.
// Fills provenance fields when provided; never overwrites a known value with a
// blank one. Called on every prompt (capture-nudge) and turn/compaction
// (precompact-save), and once with the project key at SessionStart (primer).
export function touchActivity({ sessionId, transcriptPath, cwd, project }, home = homedir()) {
  if (sessionId == null || sessionId === "") return;
  const t = now();
  const rec = readRecord(sessionId, home) || freshRecord(sessionId, t);
  rec.session_id = String(sessionId);
  rec.last_activity_at = t;
  if (transcriptPath) rec.transcript_path = String(transcriptPath);
  if (cwd) rec.cwd = String(cwd);
  if (project) rec.project = String(project);
  if (rec.created_at == null) rec.created_at = t;
  writeRecord(sessionId, rec, home);
}

// Stamp a save on a session's record (last_save_at = now). This is what makes a
// pending "unsaved tail" clear: the reconcile scan keys off last_activity_at >
// last_save_at. A save against a session that had been OFFERED for reconciliation
// also CLOSES it (reconciled_at) so it can't be re-offered and prunes cleanly.
export function markSave(sessionId, home = homedir()) {
  if (sessionId == null || sessionId === "") return;
  const t = now();
  const rec = readRecord(sessionId, home) || freshRecord(sessionId, t);
  rec.session_id = String(sessionId);
  rec.last_save_at = t;
  if ((Number(rec.reconcile_offers) || 0) > 0 && rec.reconciled_at == null) {
    rec.reconciled_at = t;
    rec.reconcile_note = "recovered via reconciliation save";
  }
  writeRecord(sessionId, rec, home);
}

// Record that a candidate was OFFERED for reconciliation this startup (bumps the
// offer count + timestamp) so the same session isn't re-offered forever.
export function markOffered(rec, home = homedir()) {
  rec.reconcile_offers = (Number(rec.reconcile_offers) || 0) + 1;
  rec.reconcile_offered_at = now();
  writeRecord(rec.session_id, rec, home);
}

// Terminally close a candidate that exhausted its offers without a save.
export function markAbandoned(rec, note, home = homedir()) {
  rec.reconciled_at = now();
  rec.reconcile_note = note || "abandoned";
  writeRecord(rec.session_id, rec, home);
}

// All parseable records (corrupt files skipped). Bounded by the number of
// sessions retained (pruneOld caps this at ~30 days).
export function listRecords(home = homedir()) {
  const out = [];
  let names = [];
  try {
    names = readdirSync(sessionsDir(home));
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const rec = readRecord(name.slice(0, -5), home);
    if (rec) out.push(rec);
  }
  return out;
}

// Hygiene: delete records whose newest timestamp is older than maxAgeSec.
// Corrupt/unparseable files (timestamp 0) are also removed. Bounded work.
export function pruneOld(maxAgeSec, home = homedir()) {
  const cutoff = now() - maxAgeSec;
  let names = [];
  try {
    names = readdirSync(sessionsDir(home));
  } catch {
    return;
  }
  for (const name of names) {
    // Sweep any .tmp orphaned by a crash between writeRecord's write and rename.
    if (name.endsWith(".tmp")) {
      try {
        unlinkSync(join(sessionsDir(home), name));
      } catch {
        /* best-effort */
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const rec = readRecord(name.slice(0, -5), home);
    const stamp = rec
      ? Math.max(Number(rec.last_activity_at) || 0, Number(rec.created_at) || 0)
      : 0;
    if (stamp < cutoff) {
      try {
        unlinkSync(join(sessionsDir(home), name));
      } catch {
        /* non-fatal */
      }
    }
  }
}
