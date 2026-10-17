#!/usr/bin/env bash
# Native performance and snapshot suites on Release builds (spec §9, §14, P0 (6) and (7)).
#
#   bash scripts/qa/native-perf.sh [--platform macos|ios|all] [--suite perf|snapshots|all]
#
# Heavy native runs belong in CI (.github/workflows/design-gates.yml). This
# refuses to run on a developer machine unless ALEVR_ALLOW_LOCAL_NATIVE=1, and
# then only inside the machine's heavy-command slot if you wrap it yourself.
#
# Dedicated Wave2 schemes compile these suites in Release without the legacy
# Debug-only preview fixture clients in the general app test bundle.
#
# Which tests run: every XCTestCase class or Swift Testing suite whose name
# ends in PerformanceTests (perf) or SnapshotTests (snapshots), found under
# Tests/Performance, Tests/Snapshots/Support and Tests/Wave2 of each app (the
# wave-2 locations; the older snapshot suites keep their own scripts). The
# helper regression suites run too: clock, report, environment and text-scale
# bugs must fail the same CI that relies on those helpers. Packages
# add suites there by naming them; nobody edits this script to register one.
#
# Reports: xcresult bundles, snapshot PNGs and the JSON the Wave2 helpers write
# (memory and signpost samples, geometry exports) land under
# $ALEVR_QA_REPORT_DIR (default test-results/native).
#
# Teardown: on EXIT, INT and TERM, every simulator that was booted during the
# run (by this script or by xcodebuild) is shut down; simulators that were
# already booted are left alone.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
log() { printf '[qa:native] %s\n' "$*" >&2; }

PLATFORM="all"
SUITE="all"
while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --suite) SUITE="${2:-}"; shift 2 ;;
    *) log "unknown argument $1"; exit 64 ;;
  esac
done
case "$PLATFORM" in macos|ios|all) ;; *) log "--platform must be macos, ios or all"; exit 64 ;; esac
case "$SUITE" in perf|snapshots|all) ;; *) log "--suite must be perf, snapshots or all"; exit 64 ;; esac

if [ -z "${CI:-}" ] && [ "${ALEVR_ALLOW_LOCAL_NATIVE:-}" != "1" ]; then
  log "Refusing to run native performance suites locally: they build Release apps and may boot a simulator."
  log "They run in CI (design-gates.yml). To run here anyway: ALEVR_ALLOW_LOCAL_NATIVE=1 bash scripts/qa/native-perf.sh"
  exit 2
fi

REPORT_DIR="${ALEVR_QA_REPORT_DIR:-$ROOT/test-results/native}"
DERIVED="${ALEVR_NATIVE_DERIVED_DATA:-${TMPDIR:-/tmp}/alevr-native-perf}"
mkdir -p "$REPORT_DIR"

booted_simulators() {
  xcrun simctl list devices booted --json 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for devices in data.get("devices", {}).values():
    for device in devices:
        if device.get("state") == "Booted":
            print(device["udid"])
' || true
}

BOOTED_BEFORE="$(booted_simulators)"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  local after udid
  after="$(booted_simulators)"
  for udid in $after; do
    if ! printf '%s\n' "$BOOTED_BEFORE" | grep -qx "$udid"; then
      log "Shutting down simulator $udid (booted during this run)."
      xcrun simctl shutdown "$udid"
    fi
  done
  exit "$status"
}
trap cleanup EXIT
trap 'log "Interrupted."; exit 130' INT
trap 'log "Terminated."; exit 143' TERM

# Test identifiers for one app: "<Target>/<Type>" for every matching type.
tests_for() {
  local app_dir="$1" target="$2" suffix="$3" dir
  for dir in "$app_dir/Tests/Performance" "$app_dir/Tests/Snapshots/Support" "$app_dir/Tests/Wave2"; do
    [ -d "$dir" ] || continue
    # `|| true`: a directory with no match is normal, and under `set -e` and
    # pipefail it would otherwise end the listing before the next directory.
    { grep -rhoE "(class|struct) [A-Za-z0-9_]+${suffix}([^A-Za-z0-9_]|$)" --include='*.swift' "$dir" 2>/dev/null || true; } \
      | sed -E "s/[^A-Za-z0-9_]$//" | awk '{print $NF}'
  done | sort -u | sed "s#^#-only-testing:${target}/#"
}

SUFFIXES=()
case "$SUITE" in
  perf) SUFFIXES=(PerformanceTests PerformanceSupportTests) ;;
  snapshots) SUFFIXES=(SnapshotTests SnapshotSupportTests TextScaleTests) ;;
  all) SUFFIXES=(PerformanceTests PerformanceSupportTests SnapshotTests SnapshotSupportTests TextScaleTests) ;;
esac

run_app() {
  local name="$1" project="$2" scheme="$3" target="$4" app_dir="$5" destination="$6"
  local only=() suffix line
  for suffix in "${SUFFIXES[@]}"; do
    while IFS= read -r line; do [ -n "$line" ] && only+=("$line"); done < <(tests_for "$app_dir" "$target" "$suffix")
  done
  if [ "${#only[@]}" -eq 0 ]; then
    log "$name: no ${SUFFIXES[*]} suites found; nothing to run."
    return 0
  fi
  log "$name: ${#only[@]} suite(s) on a Release (Stable) build."
  rm -rf "$REPORT_DIR/$name.xcresult"
  # xcodebuild strips the TEST_RUNNER_ prefix before the tests see a variable.
  TEST_RUNNER_ALEVR_PERF_REPORT_DIR="$REPORT_DIR/$name/perf" \
  TEST_RUNNER_JUNO_SNAPSHOT_DIR="$REPORT_DIR/$name/snapshots" \
  TEST_RUNNER_ALEVR_NATIVE_GEOMETRY_DIR="$REPORT_DIR/native-geometry" \
  xcodebuild test \
    -project "$project" \
    -scheme "$scheme" \
    -configuration Stable \
    -destination "$destination" \
    -derivedDataPath "$DERIVED/$name" \
    -resultBundlePath "$REPORT_DIR/$name.xcresult" \
    "${only[@]}" \
    ENABLE_TESTABILITY=YES \
    CODE_SIGNING_ALLOWED=NO
}

if [ "$PLATFORM" = macos ] || [ "$PLATFORM" = all ]; then
  run_app macos native/macOS/JunoDesktop/JunoDesktop.xcodeproj JunoDesktop-Wave2 JunoDesktopWave2Tests native/macOS/JunoDesktop 'platform=macOS'
fi

if [ "$PLATFORM" = ios ] || [ "$PLATFORM" = all ]; then
  DEVICE="$(xcrun simctl list devices available --json | python3 -c '
import json, sys
data = json.load(sys.stdin)["devices"]
for runtime in sorted(data, reverse=True):
    if "iOS" not in runtime:
        continue
    for device in data[runtime]:
        if device.get("name", "").startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
')"
  if [ -z "$DEVICE" ]; then log "No available iPhone simulator."; exit 1; fi
  if ! printf '%s\n' "$BOOTED_BEFORE" | grep -qx "$DEVICE"; then
    log "Booting simulator $DEVICE for the iOS suites."
    xcrun simctl boot "$DEVICE"
  fi
  run_app ios native/iOS/JunoMobile/JunoMobile.xcodeproj JunoMobile-Wave2 JunoMobileWave2Tests native/iOS/JunoMobile "platform=iOS Simulator,id=$DEVICE"
fi

log "Reports in $REPORT_DIR"
