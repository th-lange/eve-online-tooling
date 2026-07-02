#!/usr/bin/env bash
#
# Bump the app version everywhere it lives, in one shot.
#
# The version appears in three hand-maintained files (package.json,
# src-tauri/Cargo.toml, src-tauri/tauri.conf.json) plus two lockfiles. Editing
# them by hand for every release is easy to get wrong — miss one and the built
# installer disagrees with the tag. This script edits all three and regenerates
# both lockfiles, then prints the release checklist.
#
# Usage:
#   scripts/bump-version.sh <version>      # e.g. scripts/bump-version.sh 0.25.0
#
# It does NOT commit, tag, or push — review the diff first.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version>   (e.g. $0 0.25.0)" >&2
  exit 1
fi

# Accept a leading 'v' but store the bare semver everywhere.
VERSION="${VERSION#v}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$ ]]; then
  echo "error: '$VERSION' is not a semver version (expected e.g. 0.25.0)" >&2
  exit 1
fi

# Resolve the repo root from this script's location so it works from anywhere.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="eve-online-tooling"

echo "Bumping to $VERSION ..."

# package.json — the first top-level "version" key.
node -e '
  const fs = require("fs");
  const p = process.argv[1], v = process.argv[2];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = v;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$ROOT/package.json" "$VERSION"

# src-tauri/tauri.conf.json — top-level "version".
node -e '
  const fs = require("fs");
  const p = process.argv[1], v = process.argv[2];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = v;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$ROOT/src-tauri/tauri.conf.json" "$VERSION"

# src-tauri/Cargo.toml — the package version (first `version = "..."` under
# [package], which is the first version key in the file).
perl -0pi -e 's/^version = "[^"]*"/version = "'"$VERSION"'"/m unless $done++' "$ROOT/src-tauri/Cargo.toml"

# Regenerate lockfiles so they agree with the new versions.
echo "Updating package-lock.json ..."
( cd "$ROOT" && npm install --package-lock-only --silent )

echo "Updating Cargo.lock ..."
# The manifest version already changed above; this resolves it into Cargo.lock
# without touching any other dependency.
( cd "$ROOT/src-tauri" && cargo update -p "$CRATE" >/dev/null )

echo
echo "Done. Review, then cut the release:"
echo "  git diff --stat"
echo "  git commit -am \"chore(release): v$VERSION\""
echo "  git tag v$VERSION && git push origin main --tags"
