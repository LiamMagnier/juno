#!/bin/bash
# Render one pass of the flocked crew sheets (Cycles, Metal GPU).
#   bash tools/crew/flock/render_pass.sh <out_dir> [sheets...]
# Env: RES (portraits), SPP, Q (fuzz quality), LIGHT (1 = lineup only), ONLY_PORTRAITS
set -u
OUT=$1; shift
SHEETS=${@:-A B C}
HERE=$(cd "$(dirname "$0")/../blender" && pwd)
BL=/Applications/Blender.app/Contents/MacOS/Blender
cd "$HERE"
mkdir -p "$OUT"
for S in $SHEETS; do
  if [ -z "${LINEUP_ONLY:-}" ]; then
    RES=${RES:-900} SPP=${SPP:-160} Q=${Q:-1} $BL --background --factory-startup --python flock_render.py -- portraits "$OUT/$S" $S 2>&1 | grep --line-buffered -E "WROTE|Error|rror:|line [0-9]"
  fi
  SPP=${LSPP:-128} Q=${Q:-1} CROP=${CROP:-0.08} $BL --background --factory-startup --python flock_render.py -- lineup "$OUT/$S" $S 2>&1 | grep --line-buffered -E "WROTE|Error|rror:|line [0-9]"
  if [ -z "${LINEUP_ONLY:-}" ]; then
    RES=${RES:-900} SPP=${SPP:-160} Q=${Q:-1} $BL --background --factory-startup --python flock_render.py -- variants "$OUT/$S" $S 2>&1 | grep --line-buffered -E "WROTE|Error|rror:|line [0-9]"
  fi
done
echo PASS_DONE
