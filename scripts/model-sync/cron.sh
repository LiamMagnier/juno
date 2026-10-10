#!/usr/bin/env bash
#
# Nightly model catalogue sync for the VM (docs/models/SYNC.md).
#
# Runs `npm run models:sync` in its OWN clone, never in the deployed release,
# and never deploys. By default it only writes the report. With
# MODEL_SYNC_BRANCH=1 it also applies the changes on a fresh branch
# `model-sync/<date>`, runs the catalogue gates, and pushes that branch for a
# person to review and merge. Nothing here touches main or PM2.
#
# Crontab (04:30 UTC every day):
#   30 4 * * * MODEL_SYNC_DIR=/home/ubuntu/juno-model-sync bash /home/ubuntu/juno-model-sync/scripts/model-sync/cron.sh >> /home/ubuntu/logs/model-sync.log 2>&1
#
# Lab model-list APIs are read with whichever provider keys are in this
# process's environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...). The script
# never prints them; export them from a file only the cron user can read.
set -euo pipefail

DIR="${MODEL_SYNC_DIR:-$HOME/juno-model-sync}"
REPORTS="${MODEL_SYNC_REPORTS:-$HOME/model-sync-reports}"
DAY="$(date -u +%F)"
mkdir -p "$REPORTS"

if [ ! -d "$DIR/.git" ]; then
  echo "[model-sync] $DIR is not a clone; create it once with: git clone <repo> $DIR" >&2
  exit 1
fi
cd "$DIR"
git fetch --quiet origin main
git checkout --quiet --detach origin/main
npm ci --silent --no-audit --no-fund >/dev/null

if [ "${MODEL_SYNC_BRANCH:-0}" != "1" ]; then
  npm run --silent models:sync -- --today "$DAY" --out "$REPORTS/$DAY.md" >/dev/null
  echo "[model-sync] $DAY dry run: $REPORTS/$DAY.md"
  exit 0
fi

BRANCH="model-sync/$DAY"
git checkout --quiet -B "$BRANCH" origin/main
npm run --silent models:sync -- --apply --today "$DAY" --out "docs/models/sync-reports/$DAY.md" >/dev/null
cp "docs/models/sync-reports/$DAY.md" "$REPORTS/$DAY.md"
if git diff --quiet -- src/lib native scripts; then
  echo "[model-sync] $DAY: nothing changed"
  exit 0
fi
# The gates a reviewer would run first. A failure leaves the branch local.
npm run --silent validate:models
npm run --silent models:capabilities:audit
npx tsx --test tests/model-*.test.ts tests/code-v2-picker-catalogue.test.ts tests/code-v2-context-tiers.test.ts >/dev/null
git add -A src/lib native scripts docs/models/sync-reports
git commit --quiet -m "models:sync $DAY (see docs/models/sync-reports/$DAY.md)"
git push --quiet origin "$BRANCH"
echo "[model-sync] $DAY: pushed $BRANCH for review (not merged, not deployed)"
