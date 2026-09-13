#!/usr/bin/env bash
#
# check-version.sh — one version, everywhere.
#
# This repo ships the same plugin under four manifests (Claude Code, Cursor,
# Codex, and the MCP Registry's server.json). A release is a single tag, so all
# four MUST carry the same version string or installers and the registry end up
# describing different artifacts under one name.
#
# The check runs two ways round, because a checker that only looks where it was
# told to look cannot fail when someone adds a fifth manifest:
#
#   1. DECLARED -> found. Every file/path in DECLARED below must exist and must
#      carry a string version. A deleted or renamed manifest fails here.
#   2. Found -> DECLARED. Every `"version": "<string>"` in every tracked .json
#      (at any depth) must appear in DECLARED. A NEW manifest fails here until
#      it is added to the list, rather than drifting silently.
#
# Deliberately out of scope: hooks/project-key.mjs's PROJECT_KEY_NORMALIZER_VERSION
# is an algorithm revision pinned in lockstep with backend/src/project_key.rs,
# not the plugin's release version. It must NOT be unified with this.
#
# Usage:
#   bash scripts/check-version.sh                  # all manifests agree
#   bash scripts/check-version.sh --expect 1.1.0   # ...and equal 1.1.0 (CI, from the tag)
#
# Exit 0 on agreement, 1 on any disagreement.

set -euo pipefail

# file<TAB>jq-path — every place the plugin's release version is written.
DECLARED='.claude-plugin/plugin.json	.version
.codex-plugin/plugin.json	.version
.cursor-plugin/plugin.json	.version
server.json	.version'

EXPECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expect)
      EXPECT="${2-}"
      if [ -z "$EXPECT" ]; then
        echo "check-version: --expect needs a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --expect=*)
      EXPECT="${1#--expect=}"
      shift
      ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      echo "check-version: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "check-version: jq is required but was not found on PATH" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # Refuse rather than silently fall back to a narrower file set.
  echo "check-version: $REPO_ROOT is not a git checkout; the sweep needs 'git ls-files'" >&2
  exit 1
fi

failures=0
fail() {
  echo "  ✗ $*" >&2
  failures=$((failures + 1))
}

FOUND="$(mktemp)"
trap 'rm -f "$FOUND"' EXIT

# ── sweep: every version string in every tracked .json, at any depth ─────────
json_files=()
while IFS= read -r -d '' f; do
  json_files+=("$f")
done < <(git -C "$REPO_ROOT" ls-files -z -- '*.json')

if [ "${#json_files[@]}" -eq 0 ]; then
  fail "no tracked .json files found; the sweep for stray version fields cannot run"
fi

# ${arr[@]+"${arr[@]}"} so an empty array does not trip `set -u` on bash 3.2 (macOS).
for f in ${json_files[@]+"${json_files[@]}"}; do
  # Lockfiles carry thousands of dependency versions that are not ours.
  case "$f" in
    *lock.json) continue ;;
  esac
  if ! jq -e . "$REPO_ROOT/$f" >/dev/null 2>&1; then
    fail "$f is not valid JSON"
    continue
  fi
  jq -r --arg f "$f" '
    paths(type == "string") as $p
    | select($p[-1] == "version")
    | [ $f
      , ($p | map(if type == "number" then "[\(.)]" else "." + . end) | join(""))
      , getpath($p)
      ]
    | @tsv
  ' "$REPO_ROOT/$f" >>"$FOUND"
done

# ── direction 1: every declared version field exists ────────────────────────
# Read the declared files directly rather than through the sweep, so the error
# says which of "missing / untracked / malformed / no version" actually happened.
versions=""
while IFS=$'\t' read -r file path; do
  [ -n "$file" ] || continue
  if [ ! -f "$REPO_ROOT/$file" ]; then
    fail "$file is declared in check-version.sh but is missing from the repo"
    continue
  fi
  if ! git -C "$REPO_ROOT" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
    fail "$file is not tracked by git, so a CI checkout would not have it — git add it"
    continue
  fi
  if ! jq -e . "$REPO_ROOT/$file" >/dev/null 2>&1; then
    fail "$file is not valid JSON"
    continue
  fi
  hit="$(jq -r "$path // empty | if type == \"string\" then . else empty end" "$REPO_ROOT/$file")"
  if [ -z "$hit" ]; then
    fail "$file has no string version at $path"
    continue
  fi
  echo "  $file $path = $hit"
  versions="$versions$hit
"
done <<EOF
$DECLARED
EOF

# ── direction 2: no version field outside the declared set ──────────────────
while IFS=$'\t' read -r file path value; do
  [ -n "$file" ] || continue
  if ! printf '%s\n' "$DECLARED" | grep -qxF "$file	$path"; then
    fail "$file has an unregistered version field at $path ($value) — add it to DECLARED in scripts/check-version.sh, or remove it"
  fi
done <"$FOUND"

# ── all values identical ────────────────────────────────────────────────────
unique="$(printf '%s' "$versions" | sort -u)"
count="$(printf '%s\n' "$unique" | grep -c . || true)"
if [ "$count" -gt 1 ]; then
  fail "manifests disagree: $(printf '%s' "$unique" | tr '\n' ' ')"
fi

VERSION="$(printf '%s\n' "$unique" | head -1)"

# ── shape: a release tag is v<version>, and the registry rejects ranges ─────
if [ -n "$VERSION" ]; then
  if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'; then
    fail "version '$VERSION' is not MAJOR.MINOR.PATCH[-prerelease][+build]"
  fi
fi

# ── optional: must equal the release tag ────────────────────────────────────
if [ -n "$EXPECT" ] && [ "$VERSION" != "$EXPECT" ]; then
  fail "expected version '$EXPECT' but the manifests say '$VERSION'"
fi

if [ "$failures" -gt 0 ]; then
  echo "✗ check-version: $failures problem(s)" >&2
  exit 1
fi

echo "✓ check-version: all manifests at $VERSION"
