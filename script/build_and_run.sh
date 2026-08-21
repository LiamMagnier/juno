#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="JunoDesktop"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${JUNO_NATIVE_BUILD_ROOT:-/tmp/juno-native-launch-cache}"
STAGED_NATIVE="$BUILD_ROOT/native"
PROJECT="$STAGED_NATIVE/macOS/JunoDesktop/JunoDesktop.xcodeproj"
DERIVED_DATA="$BUILD_ROOT/derived-data"
APP_BUNDLE="$DERIVED_DATA/Build/Products/Debug/$APP_NAME.app"

stop_app() {
  pkill -x "$APP_NAME" >/dev/null 2>&1 || true
}

build_app() {
  # Xcode 27 beta can hold an NSFileCoordinator claim on a project inside a
  # heavily edited workspace before it reaches Swift compilation. Keep the
  # user's source tree authoritative, but build from an incremental exact copy
  # so the Run button is deterministic and does not inherit that coordinator
  # state. The cache lives in /tmp and is refreshed with rsync on each run.
  mkdir -p "$BUILD_ROOT"
  rsync -a --delete \
    --exclude '.build' \
    --exclude '.derived-data' \
    "$ROOT_DIR/native/" "$STAGED_NATIVE/"

  xcodebuild \
    -project "$PROJECT" \
    -scheme JunoDesktop \
    -configuration Debug \
    -destination 'platform=macOS' \
    -derivedDataPath "$DERIVED_DATA" \
    build
}

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

stop_app

case "$MODE" in
  run)
    build_app
    open_app
    ;;
  --debug|debug)
    build_app
    lldb -- "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
    ;;
  --logs|logs)
    build_app
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    build_app
    open_app
    /usr/bin/log stream --info --style compact --predicate 'subsystem == "com.liammagnier.JunoDesktop.debug"'
    ;;
  --verify|verify)
    build_app
    open_app
    sleep 1
    pgrep -x "$APP_NAME" >/dev/null
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
