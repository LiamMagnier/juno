#!/usr/bin/env bash
#
# Render the Mac transcript's offscreen snapshot suite (§2 of
# docs/native/MACOS_PHASE2_TRANSCRIPT_BRIEF.md) in light and dark.
#
# Nothing is put on screen: the test host runs as an accessory and every
# fixture is drawn into a window that is never ordered in, so this needs no
# Screen Recording permission and is safe to run while you work.
#
# Usage:
#   npm run native:snapshots:transcript            # → .snapshots/transcript/
#   JUNO_SNAPSHOT_DIR=/tmp/shots npm run native:snapshots:transcript
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${JUNO_SNAPSHOT_DIR:-$PWD/.snapshots}"
DERIVED="${JUNO_SNAPSHOT_DERIVED_DATA:-${TMPDIR:-/tmp}/juno-snapshots-derived}"
mkdir -p "$OUT"

# xcodebuild strips the TEST_RUNNER_ prefix before the tests see the variable.
TEST_RUNNER_JUNO_SNAPSHOT_DIR="$OUT" xcodebuild test \
  -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj \
  -scheme JunoDesktop \
  -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED" \
  -only-testing:JunoDesktopTests/TranscriptSnapshotTests \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=

echo "[native:snapshots] wrote $OUT/transcript"
