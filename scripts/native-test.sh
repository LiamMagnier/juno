#!/usr/bin/env bash
#
# Test the Swift packages the way CI does, with the scratch directory OUTSIDE
# the checkout.
#
# This exists because of a foot-gun that kept going off. A bare
# `swift test --package-path native/Packages/JunoNativeKit` puts its build
# products in `native/Packages/JunoNativeKit/.build`, and `.gitignore` hides
# that, so nothing ever complains — the three packages had quietly accumulated
# 1.9 GB inside the working tree across repeated ad-hoc runs.
#
# Size is the least of it. `.github/workflows/native.yml` says the scratch path
# is deliberately outside the checkout because a `.build` directory in a File
# Provider-backed tree (iCloud Drive, Dropbox, and the Desktop folder on a Mac
# with Desktop & Documents syncing on — which is where this repo lives) picks up
# resource forks that break product signing. The one script that already got
# this right is `native/Scripts/release-macos.sh`; everything else was a command
# typed from memory.
#
# So: a command to reach for, rather than a convention to remember. Flags match
# the `packages` job in native.yml — warnings are errors there, and finding that
# out on a runner after a green local run is the other half of this problem.
#
# Usage:
#   npm run native:test                 # all three packages
#   npm run native:test JunoNativeKit   # one, by directory name
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# Under TMPDIR, never under the repo. Keyed by a hash of the checkout path so two
# clones do not fight over one scratch tree, and stable across runs so the build
# stays incremental — the point is to move the directory, not to make every run
# cold.
SCRATCH_ROOT="${JUNO_SWIFT_SCRATCH:-${TMPDIR:-/tmp}/juno-swift-$(printf '%s' "$ROOT" | shasum | cut -c1-12)}"

PACKAGES=("$@")
if [ ${#PACKAGES[@]} -eq 0 ]; then
  PACKAGES=(JunoNativeKit JunoWork JunoCode)
fi

echo "[native:test] scratch: $SCRATCH_ROOT"
mkdir -p "$SCRATCH_ROOT"

failed=()
for pkg in "${PACKAGES[@]}"; do
  path="native/Packages/$pkg"
  if [ ! -d "$path" ]; then
    echo "[native:test] no such package: $path" >&2
    exit 2
  fi
  echo ""
  echo "[native:test] === $pkg ==="
  # `|| failed+=(…)` rather than letting `set -e` abort: one red package should
  # still tell you about the other two, the way the CI matrix does.
  if swift test \
    --package-path "$path" \
    --scratch-path "$SCRATCH_ROOT/$pkg" \
    --no-parallel \
    -Xswiftc -warnings-as-errors; then
    echo "[native:test] $pkg ok"
  else
    failed+=("$pkg")
  fi
done

# A `.build` that appeared anyway means something in this run ignored the
# scratch path — a nested package manifest, or a tool invoked underneath. Worth
# saying out loud at the moment it happens, because the next person to notice it
# will be looking at a signing failure instead.
strays=()
for d in "$ROOT"/.build "$ROOT"/native/Packages/*/.build; do
  [ -d "$d" ] && strays+=("${d#"$ROOT"/}")
done
if [ ${#strays[@]} -gt 0 ]; then
  echo ""
  echo "[native:test] note: build scratch inside the checkout — ${strays[*]}"
  echo "[native:test] safe to delete when no build is running: rm -rf ${strays[*]}"
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo ""
  echo "[native:test] FAILED: ${failed[*]}" >&2
  exit 1
fi

echo ""
echo "[native:test] all packages passed"
