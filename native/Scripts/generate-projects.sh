#!/bin/sh
set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_DIRECTORY=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "error: XcodeGen is required (brew install xcodegen)." >&2
  exit 1
fi

xcodegen generate --spec "$NATIVE_DIRECTORY/macOS/JunoMac/project.yml"
xcodegen generate --spec "$NATIVE_DIRECTORY/iOS/JunoMobile/project.yml"
