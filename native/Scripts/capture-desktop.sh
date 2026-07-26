#!/bin/bash
# Capture the Juno Mac app's surfaces in both appearances, deterministically.
#
# Why this exists: "light and dark" is a stated design requirement, and until now
# there was no repeatable way to produce the evidence. Appearance came from either
# the account's theme setting (the fixture account has one) or the system's
# (flipping which changes every other window on the reviewer's Mac), and window
# size came from AppKit's restored state rather than from the run. So dark
# appearance and narrow widths were reasoned about rather than looked at.
#
# The preview harness now accepts `--juno-preview-appearance`, `--juno-preview-tab`
# and `--juno-preview-size`, which makes each surface a pinned, reproducible launch.
#
# The harness is DEBUG-only and talks to a throwaway encrypted database with a
# no-network transport, so this never touches a real account.
#
# Usage:
#   ./native/Scripts/capture-desktop.sh <path/to/JunoDesktop.app> [output-dir]
#
# Requires: Screen Recording permission for the calling terminal, and a *signed*
# build. An unsigned build has a different code identity from the one that created
# the Keychain item, so macOS raises a modal password prompt that no script can
# answer — see docs/native/TESTING.md.

set -euo pipefail

APP="${1:-}"
OUT="${2:-/tmp/juno-desktop-capture}"

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
    echo "usage: $0 <path/to/JunoDesktop.app> [output-dir]" >&2
    exit 2
fi

BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
if [ ! -x "$BIN" ]; then
    echo "error: no executable at $BIN" >&2
    exit 2
fi

if ! codesign -dv "$APP" 2>&1 | grep -q "TeamIdentifier=[A-Z0-9]"; then
    echo "warning: $APP has no Team ID. Expect a modal Keychain prompt that will" >&2
    echo "         block capture. Build with automatic signing first." >&2
fi

SIZE="${JUNO_CAPTURE_SIZE:-1440x900}"

mkdir -p "$OUT"
echo "Capturing $(basename "$APP") at ${SIZE} into $OUT"

# Each surface a reviewer needs to see. `chat` is the draft/greeting state; the
# rest are the destinations reachable from the navigation column.
SURFACES="chat library artifacts projects connections tasks usage search settings"

capture() {
    local surface="$1" appearance="$2"
    local target="$OUT/${surface}-${appearance}.png"

    pkill -f "$(basename "$APP")" 2>/dev/null || true
    sleep 2

    # The executable directly, not `open -n`. `open` hands arguments to LaunchServices,
    # which will reuse or "reopen" a just-terminated instance and can bring the process
    # up with the arguments applied but no window ever created — the app becomes
    # frontmost, its menu bar appears, and there is nothing to capture.
    "$BIN" \
        --juno-ui-preview \
        --juno-preview-tab "$surface" \
        --juno-preview-appearance "$appearance" \
        --juno-preview-size "$SIZE" \
        >/dev/null 2>&1 &

    # Wait for the window rather than sleeping a fixed amount: a cold launch that
    # has to open the throwaway database is much slower than a warm one, and a
    # fixed sleep either wastes time or captures a half-built window.
    local bounds="" tries=0
    while [ $tries -lt 40 ]; do
        bounds=$(osascript -e 'tell application "System Events" to tell (first process whose name contains "JunoDesktop") to get {position, size} of first window' 2>/dev/null || true)
        [ -n "$bounds" ] && break
        tries=$((tries + 1))
        sleep 0.5
    done

    if [ -z "$bounds" ]; then
        echo "  FAIL ${surface}/${appearance}: no window appeared" >&2
        return 1
    fi

    osascript -e 'tell application "System Events" to set frontmost of first process whose name contains "JunoDesktop" to true' >/dev/null 2>&1 || true
    sleep 1.5

    # `-R` takes a rectangle in points — the same units System Events reports —
    # and resolves the display's backing scale itself. Capturing the whole screen
    # and cropping in pixels means reproducing that scale by hand, which is 2 on
    # a Retina display and 1 on an external one.
    local x y w h
    IFS=',' read -r x y w h <<< "$(echo "$bounds" | tr -d ' ')"
    screencapture -x -o -R "${x},${y},${w},${h}" "$target"
    echo "  $target"
}

FAILED=0
for appearance in light dark; do
    for surface in $SURFACES; do
        capture "$surface" "$appearance" || FAILED=1
    done
done

pkill -f "$(basename "$APP")" 2>/dev/null || true

echo
if [ $FAILED -eq 0 ]; then
    echo "Captured $(ls -1 "$OUT"/*.png | wc -l | tr -d ' ') images in $OUT"
else
    echo "Some surfaces failed to capture; see above." >&2
    exit 1
fi
