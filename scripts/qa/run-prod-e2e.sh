#!/usr/bin/env bash
# The only way to run e2e, servers or QA scripts in wave 2 (spec §14, P0 (2)).
#
#   bash scripts/qa/run-prod-e2e.sh [options] [--] [playwright test args...]
#   npm run test:e2e -- [options] [--] [playwright test args...]
#
# Options:
#   --package <id>           Database alevr_<id>_test (default: p0, or $ALEVR_QA_PACKAGE).
#   --reuse-build            Skip `next build` when .next matches HEAD and the working tree exactly.
#   --update-baselines       Write visual baselines instead of comparing against them.
#   --chromium-channel <c>   Run Chromium projects on an installed browser (e.g. chrome) instead
#                            of Playwright's download. Local use; CI uses the bundled browsers.
#   --report-dir <dir>       Where gate reports go (default: test-results/design-gates).
#   --no-seed                Skip the E2E account, research and QA fixture seeds.
#
# What it guarantees, in order:
#   1. Refuses to start unless DATABASE_URL and DIRECT_URL are both
#      postgresql://postgres@127.0.0.1:55439/<name>_test (default
#      alevr_<package>_test), no .env, .env.local, .env.production or
#      .env.production.local is present, and E2E_BASE_URL (if set) is local.
#   2. Creates and migrates that database (ensure-test-db.mjs), then seeds it.
#   3. Runs Playwright with an allowlisted environment only: PATH, HOME,
#      TMPDIR, CI, NODE_ENV=production, PORT, DATABASE_URL, DIRECT_URL,
#      JUNO_E2E_SMOKE_PROVIDER=1, the keys in scripts/qa/test.env, and the
#      runner's own ALEVR_QA_* / E2E_PORT controls. playwright.config.ts throws
#      without ALEVR_QA_RUNNER=1 and starts the server with serve-prod.mjs
#      (next build + next start on a random free port; never next dev).
#   4. On EXIT, INT and TERM: kills every process group the run started, drops
#      the database, and fails if a ps check finds any node, next or postgres
#      process from the run still alive.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVOKED_FROM="$PWD"
NODE24_BIN="/Users/liammagnier/.npm/_npx/387698761821791d/node_modules/node/bin"
if [ -d "$NODE24_BIN" ]; then export PATH="$NODE24_BIN:$PATH"; fi
cd "$ROOT"

log() { printf '[qa] %s\n' "$*" >&2; }

PKG="${ALEVR_QA_PACKAGE:-p0}"
REUSE_BUILD=""
UPDATE_BASELINES=""
CHROMIUM_CHANNEL=""
REPORT_DIR="$ROOT/test-results/design-gates"
SEED=1
PW_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --package) PKG="${2:-}"; shift 2 ;;
    --reuse-build) REUSE_BUILD=1; shift ;;
    --update-baselines) UPDATE_BASELINES=1; shift ;;
    --chromium-channel) CHROMIUM_CHANNEL="${2:-}"; shift 2 ;;
    --report-dir) REPORT_DIR="${2:-}"; shift 2 ;;
    --no-seed) SEED=0; shift ;;
    --) shift; while [ $# -gt 0 ]; do PW_ARGS+=("$1"); shift; done ;;
    *) PW_ARGS+=("$1"); shift ;;
  esac
done

case "$PKG" in
  ''|*[!a-z0-9_]*) log "Refusing: --package must be lower-case letters, digits or _ (got \"$PKG\")."; exit 2 ;;
esac
case "$CHROMIUM_CHANNEL" in
  ''|chrome|chrome-beta|msedge|chromium) ;;
  *) log "Refusing: unknown --chromium-channel \"$CHROMIUM_CHANNEL\"."; exit 2 ;;
esac
case "$REPORT_DIR" in /*) ;; *) REPORT_DIR="$INVOKED_FROM/$REPORT_DIR" ;; esac

export DATABASE_URL="${DATABASE_URL:-postgresql://postgres@127.0.0.1:55439/alevr_${PKG}_test}"
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"

if ! command -v node >/dev/null 2>&1; then log "Refusing: node is not on PATH."; exit 2; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then log "Refusing: Node 24 or newer is required (found $(node -v))."; exit 2; fi

# 1. Safety first: nothing below runs unless this passes.
node scripts/qa/assert-safe-env.mjs --cwd "$INVOKED_FROM"

# Each run's gate results start from empty, so a stale file from an earlier
# run can never pass or fail this one. Only a directory this runner made (it
# carries the marker file) is ever cleared; anything else is refused.
if [ -d "$REPORT_DIR" ] && [ -n "$(ls -A "$REPORT_DIR" 2>/dev/null)" ]; then
  if [ -f "$REPORT_DIR/.alevr-qa-report" ]; then
    rm -rf "$REPORT_DIR"
  else
    log "Refusing: $REPORT_DIR is not empty and is not a QA report directory. Pick another --report-dir."
    exit 2
  fi
fi
mkdir -p "$REPORT_DIR"
: > "$REPORT_DIR/.alevr-qa-report"

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/alevr-qa.XXXXXX")"
DB_STARTED=0
export ALEVR_QA_RUNNER_PGID="$(ps -o pgid= -p $$ | tr -d ' ')"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  node scripts/qa/teardown.mjs --root-pid $$ --run-dir "$RUN_DIR" --kill-only
  local drop_status=0
  if [ "$DB_STARTED" = 1 ]; then
    node scripts/qa/ensure-test-db.mjs --drop || drop_status=$?
  fi
  node scripts/qa/teardown.mjs --root-pid $$ --run-dir "$RUN_DIR" --check-only
  local ps_status=$?
  rm -rf "$RUN_DIR"
  if [ "$drop_status" -ne 0 ]; then log "The test database could not be dropped."; fi
  if [ "$status" -eq 0 ] && { [ "$ps_status" -ne 0 ] || [ "$drop_status" -ne 0 ]; }; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'log "Interrupted."; exit 130' INT
trap 'log "Terminated."; exit 143' TERM

PORT="$(node --input-type=module -e 'import { freePort } from "./scripts/qa/lib/proc.mjs"; console.log(await freePort());')"
CONTROL=(--control "ALEVR_QA_RUNNER=1" --control "ALEVR_QA_RUN_DIR=$RUN_DIR" --control "ALEVR_QA_REPORT_DIR=$REPORT_DIR"
  --control "ALEVR_QA_PACKAGE=$PKG" --control "E2E_PORT=$PORT")
if [ -n "${E2E_BASE_URL:-}" ]; then CONTROL+=(--control "E2E_BASE_URL=$E2E_BASE_URL"); fi
if [ -n "$CHROMIUM_CHANNEL" ]; then CONTROL+=(--control "ALEVR_QA_CHROMIUM_CHANNEL=$CHROMIUM_CHANNEL"); fi
if [ -n "$REUSE_BUILD" ]; then CONTROL+=(--control "ALEVR_QA_REUSE_BUILD=1"); fi
if [ -n "$UPDATE_BASELINES" ]; then CONTROL+=(--control "ALEVR_QA_UPDATE_BASELINES=1"); fi

CHILD_ENV=()
while IFS= read -r -d '' pair; do CHILD_ENV+=("$pair"); done < <(node scripts/qa/assert-safe-env.mjs --cwd "$INVOKED_FROM" --print-child-env --port "$PORT" "${CONTROL[@]}")
if [ "${#CHILD_ENV[@]}" -eq 0 ]; then log "Could not build the child environment."; exit 2; fi

# 2. The disposable database.
DB_STARTED=1
node scripts/qa/ensure-test-db.mjs

if [ "$SEED" = 1 ]; then
  log "Seeding the E2E account and QA fixtures..."
  env -i "${CHILD_ENV[@]}" NODE_OPTIONS=--conditions=react-server "$ROOT/node_modules/.bin/tsx" scripts/seed-e2e-user.ts
  env -i "${CHILD_ENV[@]}" NODE_OPTIONS=--conditions=react-server RESEARCH_E2E_SEED=1 "$ROOT/node_modules/.bin/tsx" scripts/seed-research-e2e.ts
  env -i "${CHILD_ENV[@]}" NODE_OPTIONS=--conditions=react-server "$ROOT/node_modules/.bin/tsx" scripts/qa/seed-qa-fixtures.ts
fi

# 3. Playwright, in a process group of its own so teardown can stop all of it.
log "Running Playwright against a production build on 127.0.0.1:$PORT (database ${DATABASE_URL##*/})."
set -m
env -i "${CHILD_ENV[@]}" "$ROOT/node_modules/.bin/playwright" test "${PW_ARGS[@]+"${PW_ARGS[@]}"}" &
PW_PID=$!
set +m
printf '%s\n' "$PW_PID" > "$RUN_DIR/playwright.pgid"
PW_STATUS=0
wait "$PW_PID" || PW_STATUS=$?

GATES_STATUS=0
if [ -f "$ROOT/scripts/qa/gates.ts" ] && [ -d "$REPORT_DIR" ]; then
  env -i "${CHILD_ENV[@]}" "$ROOT/node_modules/.bin/tsx" scripts/qa/gates.ts evaluate "$REPORT_DIR" || GATES_STATUS=$?
fi

if [ "$PW_STATUS" -ne 0 ]; then exit "$PW_STATUS"; fi
exit "$GATES_STATUS"
