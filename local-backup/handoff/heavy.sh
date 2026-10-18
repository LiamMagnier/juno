#!/bin/bash
# Run a memory-heavy command only when one of the machine-wide slots is free.
#
#   bash /Users/liammagnier/Developer/project/Juno/.claude/handoff/heavy.sh npm run -s typecheck
#
# Heavy means: typecheck (tsc), next build, next dev / next start, Playwright, the full
# test suite, xcodebuild, swift build / swift test, the iOS simulator. A full typecheck of
# this repo needs about 5 GB, and the Mac has 24 GB shared by every agent (Claude and
# ChatGPT), so at most HEAVY_SLOTS of these run at once. Everyone else waits here.
# A slot whose holder died is reclaimed automatically (shlock checks the PID).
SLOTS="${HEAVY_SLOTS:-2}"
DIR="/Users/liammagnier/Developer/project/Juno/.claude/handoff/heavy-locks"
mkdir -p "$DIR"
waited=0
while :; do
  for i in $(seq 1 "$SLOTS"); do
    if shlock -f "$DIR/slot$i" -p $$ 2>/dev/null; then
      trap 'rm -f "$DIR/slot'"$i"'"' EXIT INT TERM
      [ "$waited" -gt 0 ] && echo "heavy.sh: got slot $i after ${waited}s" >&2
      "$@"
      exit $?
    fi
  done
  [ "$waited" -eq 0 ] && echo "heavy.sh: all $SLOTS heavy slots busy, waiting..." >&2
  sleep 10
  waited=$((waited + 10))
done
