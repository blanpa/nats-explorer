#!/usr/bin/env bash
# Prints the CHANGELOG.md section of one version, for the body of the GitHub
# release. Without it the release notes are the commit titles of the tag, which
# say far less than the changelog entry that was written for the same release.
# Usage: scripts/release-notes.sh 0.3.0
set -euo pipefail
VERSION="${1#v}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
awk -v v="$VERSION" '
  $0 ~ "^## \\[" v "\\]" { found = 1; next }   # skip the heading itself
  found && /^## / { exit }                      # stop at the next version
  found { print }
' "$ROOT/CHANGELOG.md" | sed -e '/./,$!d' | awk '{ lines[NR] = $0 } END { last = NR; while (last > 0 && lines[last] == "") last--; for (i = 1; i <= last; i++) print lines[i] }'
