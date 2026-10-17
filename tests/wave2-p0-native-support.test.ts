import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * P0's native test support (spec appendix P0 (7) and "Acceptance. Native").
 *
 * - The helpers shared by the macOS and iOS test targets are byte-identical
 *   copies, so a fix to one cannot silently miss the other.
 * - scripts/qa/native-perf.sh boots no simulator and builds nothing locally
 *   unless ALEVR_ALLOW_LOCAL_NATIVE=1, and its trap shuts down every simulator
 *   booted during the run (by the script or by xcodebuild) while leaving ones
 *   that were already running. xcrun and xcodebuild are fakes on PATH that
 *   record their calls, so nothing real is built or booted here.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "qa", "native-perf.sh");
const MAC = path.join(ROOT, "native", "macOS", "JunoDesktop", "Tests");
const IOS = path.join(ROOT, "native", "iOS", "JunoMobile", "Tests");

const SHARED = [
  "Performance/Wave2PerfReport.swift",
  "Performance/Wave2TestClock.swift",
  "Performance/Wave2OcclusionMock.swift",
  "Performance/Wave2MetricSupport.swift",
  "Performance/Wave2PerformanceSupportTests.swift",
  "Performance/Wave2SamplePerformanceTests.swift",
  "Snapshots/Support/Wave2GeometryExport.swift",
];

for (const file of SHARED) {
  test(`${file} is identical in the macOS and iOS test targets`, () => {
    const mac = readFileSync(path.join(MAC, file), "utf8");
    const ios = readFileSync(path.join(IOS, file), "utf8");
    assert.equal(ios, mac, `${file} drifted between native/macOS and native/iOS; copy the fixed one over the other`);
    assert.match(mac, /byte-identical/);
  });
}

test("the sample XCTMemoryMetric test is a *PerformanceTests suite, so native-perf.sh runs it", () => {
  const sample = readFileSync(path.join(MAC, "Performance", "Wave2SamplePerformanceTests.swift"), "utf8");
  assert.match(sample, /final class Wave2SamplePerformanceTests: XCTestCase/);
  assert.match(sample, /wave2MeasureMemory\(/);
  const metric = readFileSync(path.join(MAC, "Performance", "Wave2MetricSupport.swift"), "utf8");
  assert.match(metric, /measure\(metrics: \[XCTMemoryMetric\(\)\]/);
  assert.match(metric, /XCTOSSignpostMetric\(/);
});

interface Sim {
  dir: string;
  log: string;
  state: string;
  cleanup: () => void;
}

/** Fake xcrun and xcodebuild, with the booted set kept in a file. */
function fakeTools(initiallyBooted: string[], xcodebuild: string): Sim {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-native-"));
  const log = path.join(dir, "calls.log");
  const state = path.join(dir, "booted");
  writeFileSync(log, "");
  writeFileSync(state, initiallyBooted.map((u) => `${u}\n`).join(""));
  const xcrun = `#!/bin/bash
echo "xcrun $*" >> "${log}"
booted_json() {
  printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-0":['
  first=1
  while read -r udid; do
    [ -z "$udid" ] && continue
    [ $first -eq 1 ] || printf ','
    printf '{"udid":"%s","name":"iPhone 17","state":"Booted"}' "$udid"
    first=0
  done < "${state}"
  printf ']}}'
}
case "$*" in
  "simctl list devices booted --json") booted_json ;;
  "simctl list devices available --json") printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-0":[{"udid":"SIM-NEW","name":"iPhone 17","state":"Shutdown"}]}}' ;;
  "simctl boot "*) echo "$3" >> "${state}" ;;
  "simctl shutdown "*) grep -vx "$3" "${state}" > "${state}.tmp"; mv "${state}.tmp" "${state}" ;;
  *) echo "unexpected xcrun $*" >&2; exit 3 ;;
esac
`;
  writeFileSync(path.join(dir, "xcrun"), xcrun);
  writeFileSync(path.join(dir, "xcodebuild"), `#!/bin/bash\necho "xcodebuild $*" >> "${log}"\n${xcodebuild.replaceAll("STATE", state)}\n`);
  chmodSync(path.join(dir, "xcrun"), 0o755);
  chmodSync(path.join(dir, "xcodebuild"), 0o755);
  return { dir, log, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runNative(sim: Sim, args: string[], extra: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: ROOT,
    env: {
      PATH: `${sim.dir}:/usr/bin:/bin`,
      HOME: sim.dir,
      ALEVR_QA_REPORT_DIR: path.join(sim.dir, "reports"),
      ALEVR_NATIVE_DERIVED_DATA: path.join(sim.dir, "dd"),
      ...extra,
    } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("native-perf.sh refuses to run locally without ALEVR_ALLOW_LOCAL_NATIVE=1, and touches nothing", () => {
  const sim = fakeTools([], "exit 0");
  try {
    const run = runNative(sim, ["--platform", "ios"]);
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /Refusing to run native performance suites locally/);
    assert.equal(readFileSync(sim.log, "utf8"), "", "no xcrun or xcodebuild call before the refusal");
    assert.ok(!existsSync(path.join(sim.dir, "reports")));
  } finally {
    sim.cleanup();
  }
});

test("with ALEVR_ALLOW_LOCAL_NATIVE=1 it boots a simulator for iOS and shuts it down even when the tests fail", () => {
  const sim = fakeTools(["SIM-ALREADY"], "exit 65");
  try {
    const run = runNative(sim, ["--platform", "ios", "--suite", "perf"], { ALEVR_ALLOW_LOCAL_NATIVE: "1" });
    assert.equal(run.status, 65, run.stderr);
    const log = readFileSync(sim.log, "utf8");
    assert.match(log, /xcrun simctl boot SIM-NEW/);
    assert.match(log, /xcrun simctl shutdown SIM-NEW/);
    assert.doesNotMatch(log, /simctl shutdown SIM-ALREADY/, "a simulator that was already booted is left alone");
    const build = log.split("\n").find((line) => line.startsWith("xcodebuild")) ?? "";
    assert.match(build, /-configuration Stable/);
    assert.match(build, /-only-testing:JunoMobileWave2Tests\/Wave2SamplePerformanceTests/);
    assert.match(build, /-only-testing:JunoMobileWave2Tests\/Wave2PerformanceSupportTests/, "the clock and report regressions run alongside the sample");
    assert.match(build, /ENABLE_TESTABILITY=YES/);
    assert.equal(readFileSync(sim.state, "utf8").trim(), "SIM-ALREADY");
  } finally {
    sim.cleanup();
  }
});

test("a simulator xcodebuild boots on its own is shut down too", () => {
  const sim = fakeTools([], 'echo "SIM-BY-XCODEBUILD" >> "STATE"\nexit 0');
  try {
    const run = runNative(sim, ["--platform", "macos", "--suite", "perf"], { CI: "true" });
    assert.equal(run.status, 0, run.stderr);
    const log = readFileSync(sim.log, "utf8");
    assert.match(log, /xcodebuild test -project native\/macOS\/JunoDesktop\/JunoDesktop\.xcodeproj/);
    assert.match(log, /-only-testing:JunoDesktopWave2Tests\/Wave2SamplePerformanceTests/);
    assert.match(log, /xcrun simctl shutdown SIM-BY-XCODEBUILD/);
    assert.equal(readFileSync(sim.state, "utf8").trim(), "");
  } finally {
    sim.cleanup();
  }
});

test("the snapshot suite picks up the wave-2 support snapshot suites by name", () => {
  const sim = fakeTools([], "exit 0");
  try {
    const run = runNative(sim, ["--platform", "macos", "--suite", "snapshots"], { CI: "true" });
    assert.equal(run.status, 0, run.stderr);
    const build = readFileSync(sim.log, "utf8").split("\n").find((line) => line.startsWith("xcodebuild")) ?? "";
    assert.match(build, /-only-testing:JunoDesktopWave2Tests\/Wave2SupportSnapshotTests/);
    assert.match(build, /-only-testing:JunoDesktopWave2Tests\/Wave2SnapshotSupportTests/);
    assert.match(build, /-only-testing:JunoDesktopWave2Tests\/Wave2TextScaleTests/);
    assert.doesNotMatch(build, /Wave2SamplePerformanceTests/);
  } finally {
    sim.cleanup();
  }
});
