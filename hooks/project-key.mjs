// CoralSwarm project-key normalizer — JS parity port of backend v1.
//
// PARITY PORT of `backend/src/project_key.rs` (the pinned, versioned v1
// normalizer landed in Phase 1 / PR #246). This module MUST produce byte-for-
// byte identical keys to the Rust source for every input — the server
// re-normalizes everything it receives (defense in depth), so any divergence
// here just means the hook-side key and the server-side key disagree, which
// silently forks a project. Keep the two in lockstep: any change to the Rust
// algorithm bumps PROJECT_KEY_NORMALIZER_VERSION there and must be mirrored
// here (and in project-key.test.mjs).
//
// # The P0: credential stripping
//
// `add_context`'s server-side validator (`ingest.rs` validate_provenance_label)
// checks only NUL bytes + a length cap — a raw
// `https://x-access-token:ghp_xxxx@github.com/org/repo.git` remote passes that
// validator verbatim. But the far more dangerous leak is client-side: if the
// hook injected an unsanitized remote into the SessionStart primer text, a live
// token would be written straight into the conversation transcript before the
// server is ever contacted. `normalizeRemote` unconditionally strips userinfo
// (everything up to and including the LAST '@' in the authority) BEFORE the
// value is ever placed in hook output, so a credential-bearing URL is
// structurally unable to reach the transcript through this path.
//
// # What normalization does (v1) — identical to the Rust doc comment:
//   1. Strip userinfo (`user:pass@` / `user@`) — CRITICAL, see above.
//   2. Fold SCP-style syntax (`git@github.com:org/repo.git`) into `host/path`.
//   3. Strip the scheme (`https://`, `ssh://`, `git://`, `git+ssh://`, ...).
//   4. Strip an explicit port (`:22`, `:443`, ...).
//   5. Lowercase the host (path case preserved — GitHub/GitLab paths ARE
//      case-sensitive in practice).
//   6. Strip a trailing `.git` suffix and any trailing `/`.
// Output shape: `"{host}/{path}"`, e.g. `"github.com/coralswarm/coralswarm"`.

// Version of the normalization algorithm. Mirror of the Rust constant
// PROJECT_KEY_NORMALIZER_VERSION. Bump in lockstep with the Rust source.
//
// v2 (CodeRabbit reviews on PRs #246/#247): reject Windows drive-letter paths
// (`C:/...` and `C:\...`) outright, and extend the final output invariant to
// forbid `?`/`#`/`=` (query-string / fragment credential forms) alongside
// `@`/`:`. Both changes turn previously-emitted (unsafe) keys into null, so
// this bumps the version per the freeze-forever contract. Must stay in
// lockstep with the Rust source `backend/src/project_key.rs`.
//
// v3 (CodeRabbit re-review on PR #247): the v2 drive-letter guard only saw the
// RAW input, so a scheme-prefixed drive path — `file://C:/Users/dev/repo` —
// slipped past it and still minted fake host `c`. v3 re-applied the guard to
// the post-scheme-strip string.
//
// v4 (CodeRabbit re-review on PR #247, round 3): a drive letter hidden behind
// USERINFO — `ssh://user@C:/x`, `user@C:\x` — still slipped past v3, because
// the guard ran before userinfo stripping revealed the drive letter. v4 is a
// STRUCTURAL fix, not another patch: userinfo is now stripped BEFORE authority/
// path splitting, and the drive-letter guard runs once on the fully-revealed
// residue (after both scheme AND userinfo removal), immediately before the
// port-strip that would erase the drive colon. `foldScpSyntax` also learns to
// reject a userinfo-cloaked single-letter drive host. Bumped in lockstep with
// the Rust source.
//
// v5 (CodeRabbit Data-Integrity review on PR #246): a bracketed IPv6 authority
// — `ssh://[2001:db8::1]/team/repo`, `[::1]/x` — minted the fake host `[2001`
// (the `[` was not in the forbidden-char set, and the inner `:` was eaten by
// the port-split). v5 rejects any authority starting with `[` (IPv6 is out of
// scope for v1) and adds `[`/`]` to the forbidden-char output invariant as
// belt-and-braces. Bumped in lockstep with the Rust source
// `backend/src/project_key.rs` (PR #246).
export const PROJECT_KEY_NORMALIZER_VERSION = 5;

// A project key is STRUCTURALLY forbidden from carrying any character a
// credential can ride in on: '@' and ':' (userinfo), '?' and '#'
// (query string / fragment), '=' (key=value pair, e.g.
// "repo?access_token=secret" / "repo#token=secret"), and '['/']'
// (IPv6-authority brackets — belt-and-braces for the step-4b IPv6 rejection).
// Shared by the normalizeRemote final output invariant and normalizeFallback so
// both reject the exact same set. Mirror of Rust `key_has_forbidden_char`.
function keyHasForbiddenChar(s) {
  return (
    s.includes("@") ||
    s.includes(":") ||
    s.includes("?") ||
    s.includes("#") ||
    s.includes("=") ||
    s.includes("[") ||
    s.includes("]")
  );
}

// True if `raw` is a Windows drive-letter path — `^[A-Za-z]:[/\\]`, i.e. a
// single ASCII letter, a colon, then a slash in EITHER direction ("C:/..." or
// "C:\..."). Such a local filesystem path is never a git remote and must not
// mint a project key. Mirror of Rust `is_windows_drive_path`.
function isWindowsDrivePath(raw) {
  return /^[A-Za-z]:[/\\]/.test(raw);
}

// Strip userinfo ("user@" / "user:pass@") from the authority segment (the part
// before the first "/") of a scheme-stripped remote, returning the residue with
// the credential removed and the path preserved verbatim. Everything up to and
// including the LAST "@" in that segment is dropped, so
// "user@name:pass@host/path" -> "host/path". Stripping userinfo HERE, before
// authority/path splitting, is what lets normalizeRemote's structural drive-
// letter guard run on the fully-revealed residue. Mirror of Rust `strip_userinfo`.
function stripUserinfo(s) {
  const slash = s.indexOf("/");
  if (slash >= 0) {
    const authority = s.slice(0, slash);
    const path = s.slice(slash + 1);
    const at = authority.lastIndexOf("@");
    const host = at >= 0 ? authority.slice(at + 1) : authority;
    return `${host}/${path}`;
  }
  const at = s.lastIndexOf("@");
  return at >= 0 ? s.slice(at + 1) : s;
}

// Rust `str::trim()` strips Unicode whitespace; JS String.prototype.trim()
// matches that closely enough for our inputs (git remote URLs / folder names).

/**
 * Detect and fold SCP-style git syntax (`[user@]host:path`) into `host/path`.
 * Mirror of Rust `fold_scp_syntax`. Returns null when the input is not SCP
 * syntax (no-op for the caller).
 *
 * Must NOT fire on: an already-schemed URL (contains "://"); a Windows drive-
 * letter path ("C:\..." / "C:/..." — single char before ':'); a path with no
 * ':' at all; or credential-bearing schemeless input ("user:pass@host/path" /
 * "token:secret@host:2222/repo") — see the P0 note below.
 *
 * The P0 bypass this guards against (CodeRabbit review on PR #246, Rust fix
 * fc395e0): genuine SCP syntax is `[user@]host:path` — when userinfo is
 * present, the `@` sits in the AUTHORITY, strictly BEFORE the colon
 * (`git@github.com:org/repo`). A schemeless `user:pass@host/path` URL instead
 * has its `@` strictly AFTER the first colon, in what would become the "path"
 * half of an SCP split. Folding that anyway produces `"user/pass@host/path"`,
 * so the credential survives — because folding runs BEFORE the authority
 * `@`-split that would otherwise strip it. We therefore refuse to fold
 * whenever an `@` appears in the first path segment (up to the next `/`, or
 * the whole remainder if there's no `/`); the unfolded path handles that shape
 * correctly via the authority `@`-split and comes out credential-free.
 */
function foldScpSyntax(raw) {
  if (raw.includes("://")) return null;
  const colon = raw.indexOf(":");
  if (colon < 0) return null;
  // Reject drive letters ("C:", "D:") — a single char before ':' is never a
  // plausible SCP host (matches Rust `colon < 2`).
  if (colon < 2) return null;
  const authority = raw.slice(0, colon);
  // Reject a drive letter HIDDEN BEHIND USERINFO ("user@C:\x", "user:pass@D:/
  // repo") — CodeRabbit re-review on PR #247, round 3 (mirror of Rust v4). The
  // `colon < 2` check only catches a BARE leading drive letter; once a "user@"
  // prefix is present the colon is no longer near the start, so strip the SCP
  // authority's own userinfo and re-test: a single ASCII letter left over is a
  // drive letter, not a host — never SCP syntax, refuse to fold.
  const atIdx = authority.lastIndexOf("@");
  const scpHost = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
  if (/^[A-Za-z]$/.test(scpHost)) return null;
  const path = raw.slice(colon + 1); // drop the ':'
  // A real SCP remote's path is non-empty and never starts with '/' (that is
  // the ssh://host/path or host:/abs/path form, which parses fine unfolded).
  if (path.length === 0 || path.startsWith("/")) return null;
  // CRITICAL (P0 bypass fix, round 2, mirror of Rust 1bc987a): if an '@'
  // appears ANYWHERE in the post-colon remainder — not just its first
  // '/'-delimited segment — this is credential-bearing
  // "user:pass@host[:port]/path" input (a slash-containing credential such as
  // "user:pa/ss@host/org/repo" included, whose '@' lands in a LATER segment),
  // not SCP syntax — refuse to fold. When in doubt, don't fold.
  if (path.includes("@")) return null;
  // authority may itself contain "user@host" — userinfo stripping happens
  // later in the pipeline, exactly as in Rust.
  return `${authority}/${path}`;
}

/**
 * Strip a leading URL scheme (`https://`, `ssh://`, `git://`, `git+ssh://`, ...)
 * if present. Mirror of Rust `strip_scheme`: recognizes any
 * `[a-zA-Z][a-zA-Z0-9+.-]*://` prefix rather than an exact allowlist.
 */
function stripScheme(s) {
  const idx = s.indexOf("://");
  if (idx > 0) {
    const scheme = s.slice(0, idx);
    const first = scheme[0];
    const firstIsAlpha = /[a-zA-Z]/.test(first);
    const allValid = /^[a-zA-Z0-9+.-]+$/.test(scheme);
    if (firstIsAlpha && allValid) {
      return s.slice(idx + 3);
    }
  }
  return s;
}

/**
 * Normalize a raw git remote URL (HTTPS, SSH, git://, or SCP-style) into a
 * canonical project key `"{host}/{path}"`. Mirror of Rust `normalize_remote`.
 *
 * Returns null when the input is empty/whitespace-only, or when nothing
 * resembling a host/path survives normalization — callers fall back to
 * `normalizeFallback` in that case.
 *
 * Security: userinfo is ALWAYS stripped, unconditionally, before any other
 * transform. No option, no bypass.
 */
export function normalizeRemote(raw) {
  if (raw == null) return null;
  raw = String(raw).trim();
  if (raw.length === 0) return null;

  // Step 0: reject a Windows drive-letter path ("C:\..." OR "C:/...") OUTRIGHT,
  // before any splitting (mirror of Rust v2, CodeRabbit review on PR #246). The
  // backslash form is already refused downstream, but the FORWARD-slash form
  // ("C:/Users/dev/repo") slips past foldScpSyntax's drive-letter guard and
  // flows into the scheme-based split: indexOf("/") gives authority "C:", the
  // port-strip discards ":", and "c" is emitted as a fake host
  // ("c/Users/dev/repo"). A local filesystem path is never a git remote.
  if (isWindowsDrivePath(raw)) return null;

  // Step 1: fold SCP-style syntax into "host/path" before anything else.
  const folded = foldScpSyntax(raw) ?? raw;

  // Step 2: strip scheme, if any.
  const withoutScheme = stripScheme(folded);

  // Step 3: strip userinfo (CRITICAL, P0) BEFORE authority/path splitting.
  // Userinfo is everything up to and including the LAST '@' in the authority
  // component (the segment before the first '/'), so a pathological
  // "user@name:pass@host" keeps only the real host. Doing this here — rather
  // than after the split — is what lets the structural guard below run on the
  // FULLY-REVEALED residue (mirror of Rust v4).
  const residue = stripUserinfo(withoutScheme);

  // Step 3b: STRUCTURAL drive-letter guard (mirror of Rust v4, CodeRabbit
  // reviews on PRs #246/#247, three rounds). Scheme stripping AND userinfo
  // stripping are the only two transforms that can UNCOVER a drive-letter path
  // hidden behind a prefix — a scheme ("file://C:/x"), userinfo
  // ("ssh://user@C:/x"), or both. This single guard runs on the residue AFTER
  // both reveals and immediately BEFORE the port-strip (step 5) that would
  // otherwise erase the drive colon, so it catches every position the drive
  // letter can hide in — bare, schemed, and userinfo-cloaked, in either slash
  // direction — instead of one patch per uncovered case. (Step 0 above is a
  // cheap early-out for the common bare form; this is the load-bearing check.)
  if (isWindowsDrivePath(residue)) return null;

  // Step 4: split authority (host[:port]) from path on the FIRST '/'. The
  // residue no longer carries userinfo (stripped in step 3), so authority is
  // just "host[:port]".
  let authority;
  let path;
  const slash = residue.indexOf("/");
  if (slash >= 0) {
    authority = residue.slice(0, slash);
    path = residue.slice(slash + 1);
  } else {
    authority = residue;
    path = "";
  }
  if (authority.length === 0) return null;

  // Step 4b: reject a bracketed IPv6 authority ("[2001:db8::1]", "[::1]")
  // OUTRIGHT (mirror of Rust v5, CodeRabbit Data-Integrity review on PR #246).
  // An IPv6 literal is never a git-hosting identity, and its inner ':' would be
  // swallowed by the naive port-split below — "[2001:db8::1]/team/repo"
  // otherwise mints the fake host "[2001" (the '[' survives because it is not in
  // the forbidden-char set). IPv6 remotes are explicitly OUT OF SCOPE for v1:
  // bail rather than emit a mangled, non-canonical key. The '[' start is the
  // unambiguous signal.
  if (authority.startsWith("[")) return null;

  // Step 5: strip an explicit port ("host:22" -> "host"), splitting on the
  // FIRST ':' (mirror of Rust `split_once(':')`).
  const portColon = authority.indexOf(":");
  const host = portColon >= 0 ? authority.slice(0, portColon) : authority;
  if (host.length === 0) return null;

  // Step 6: lowercase the host only. Path case is preserved.
  const hostLower = host.toLowerCase();

  // Step 7: clean the path — trim slashes, strip a trailing ".git".
  path = trimSlashes(path);
  if (path.endsWith(".git")) path = path.slice(0, -4);
  path = trimSlashes(path);

  if (path.length === 0) return null; // bare host is not a usable key

  const key = `${hostLower}/${path}`;

  // Final output invariant (P0 defense in depth, mirror of Rust v2): a project
  // key is STRUCTURALLY forbidden from carrying any character a credential can
  // ride in on — '@'/':' (userinfo), plus '?'/'#'/'=' (query string / fragment
  // / key=value pair, e.g. "repo?access_token=secret" or "repo#token=secret",
  // CodeRabbit review on PR #247). A slash embedded inside a credential (e.g.
  // "user:pa/ss@host/org/repo") can defeat the step-by-step stripping above no
  // matter where the naive "split at the first '/'" assumption lands (SCP fold
  // OR scheme-based split), and a query/fragment simply is never part of a git
  // remote's repo identity. Rather than trust that every step is airtight,
  // re-verify the ACTUAL output: if it still contains any forbidden char,
  // return null. A false-negative on a legitimate remote whose path contains
  // one literally is the accepted trade-off — dropping a usable key is always
  // safer than risking a leak; basename fallback covers keying.
  if (keyHasForbiddenChar(key)) return null;

  return key;
}

/**
 * Sanitize a non-URL fallback input (e.g. a working-directory basename) into a
 * project key when no git remote is available. Mirror of Rust
 * `normalize_fallback`: lowercases, trims whitespace/slashes, strips a trailing
 * `.git`. Never attempts URL/host parsing.
 *
 * Returns null for empty/whitespace-only input, OR when the cleaned input still
 * contains any forbidden char '@'/':'/'?'/'#'/'=' (P0 defense in depth, mirror
 * of Rust v2 — same final-output invariant `normalizeRemote` enforces). This
 * guards against a caller mistakenly feeding a raw credential- or query-bearing
 * string into the fallback path (e.g. a remote URL via repo_path, or
 * "repo#token=secret") instead of `normalizeRemote`; callers get null instead,
 * and session capture still works without a project key.
 */
export function normalizeFallback(raw) {
  if (raw == null) return null;
  let trimmed = trimSlashes(String(raw).trim());
  if (trimmed.length === 0) return null;
  let lowered = trimmed.toLowerCase();
  let cleaned = lowered.endsWith(".git") ? lowered.slice(0, -4) : lowered;
  cleaned = trimSlashes(cleaned);
  if (cleaned.length === 0) return null;
  // Same forbidden-char invariant as normalizeRemote's final output check:
  // reject '@'/':'/'?'/'#'/'=' outright (P0 defense in depth, mirror of Rust
  // v2) so a caller mistakenly feeding a credential- or query-bearing string
  // (e.g. "repo#token=secret") down the fallback path can never mint a key
  // carrying it.
  if (keyHasForbiddenChar(cleaned)) return null;
  return cleaned;
}

/**
 * Derive a project key from a (possibly missing) remote and a working-directory
 * path: normalized remote first, else the sanitized basename of the cwd. Returns
 * null when neither yields a key. Convenience helper for the hooks.
 */
export function projectKey(remoteRaw, cwd) {
  const fromRemote = remoteRaw ? normalizeRemote(remoteRaw) : null;
  if (fromRemote) return fromRemote;
  if (cwd) {
    const base = basename(cwd);
    if (base) return normalizeFallback(base);
  }
  return null;
}

// --- small helpers (kept dependency-free) ---------------------------------

// Trim leading/trailing '/' only, mirroring Rust `trim_matches('/')`.
function trimSlashes(s) {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "/") start++;
  while (end > start && s[end - 1] === "/") end--;
  return s.slice(start, end);
}

// Basename of a filesystem path (handles trailing slashes and both separators).
function basename(p) {
  const cleaned = String(p).replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}
