import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

/**
 * The macOS app CI gate must leave its unit tests room to finish (ledger P1-4).
 *
 * One "macOS app" job used to run Debug build → Stable build → unit tests under
 * a 40-minute cap. Main run 39143961783 spent 7m28s on Debug and 30m42s on
 * Stable, then the cap cancelled "Unit tests" 27s in: on main the macOS unit
 * tests did not run, and the check said "cancelled" rather than "failed". The
 * Stable build now has a job of its own. This holds the structure and the
 * headroom: each job's cap must clear the slowest run observed for what it
 * does by at least ten minutes.
 */

// js-yaml ships with ESLint (a devDependency); required rather than imported
// so the typecheck needs no @types package for a test-only parser.
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };

type Step = { name?: string; run?: string; uses?: string };
type Job = { name?: string; needs?: string | string[]; if?: string; "runs-on"?: string; "timeout-minutes"?: number; steps?: Step[] };

const workflow = yaml.load(readFileSync(new URL("../.github/workflows/native.yml", import.meta.url), "utf8")) as { jobs: Record<string, Job> };
const jobs = workflow.jobs;

/** Slowest runs observed for each job's work, in minutes, with where they were read. */
const OBSERVED_MAX_MINUTES = {
  // Run 39143961783: set-up ~1m, Debug build 7m28s; run 39143955698: unit tests 6m16s.
  debugAndTests: 1 + 7.5 + 6.3,
  // Run 39143961783: set-up ~1m, env server bundle 52s, Stable build 30m42s.
  stable: 1 + 0.9 + 30.7,
};
const REQUIRED_HEADROOM_MINUTES = 10;

const runs = (job: Job) => (job.steps ?? []).map((step) => step.run ?? "").join("\n");
const buildsStable = (job: Job) => /-configuration Stable\b/.test(runs(job));
const runsUnitTests = (job: Job) => /-only-testing:JunoDesktopTests[\s\S]*\btest\b/.test(runs(job));

test("the Debug build and the macOS unit tests have their own job, without the Stable build", () => {
  const job = jobs["macos-app"];
  assert.ok(job, "native.yml keeps a macos-app job");
  assert.equal(job.name, "macOS app", "the check name branch protection and the base gate read is unchanged");
  assert.match(runs(job), /-configuration Debug[\s\S]*SWIFT_TREAT_WARNINGS_AS_ERRORS=YES[\s\S]*\bbuild\b/);
  assert.ok(runsUnitTests(job), "macos-app runs JunoDesktopTests");
  assert.equal(buildsStable(job), false, "the Stable build must not share the unit tests' job and cap");
});

test("the Stable build runs in its own job with the env server bundle it requires", () => {
  const job = jobs["macos-app-stable"];
  assert.ok(job, "native.yml has a macos-app-stable job");
  assert.ok(buildsStable(job));
  assert.equal(runsUnitTests(job), false);
  const names = (job.steps ?? []).map((step) => step.name ?? step.uses ?? "");
  const bundle = names.indexOf("Bundle the env server");
  const stable = names.indexOf("Build JunoDesktop (Stable, strict)");
  assert.ok(bundle >= 0 && stable > bundle, "the sidecar bundle is built before the Stable build that refuses to ship without it");
  assert.ok(names.indexOf("Generate projects") >= 0 && names.indexOf("Generate projects") < stable, "projects are generated first");
  assert.match(runs(job), /SWIFT_TREAT_WARNINGS_AS_ERRORS=YES/);
});

test("both macOS app jobs are gated on native changes like the rest of the macOS jobs", () => {
  for (const id of ["macos-app", "macos-app-stable"]) {
    const job = jobs[id];
    assert.equal(job.needs, "changes", `${id} needs the changes job`);
    assert.equal(job.if, "needs.changes.outputs.native == 'true'", `${id} skips web-only pushes`);
    assert.equal(job["runs-on"], "macos-26", `${id} builds and runs on the same OS as its SDK`);
  }
});

test("each macOS app job's cap clears the slowest observed run by at least ten minutes", () => {
  const debugCap = jobs["macos-app"]["timeout-minutes"];
  const stableCap = jobs["macos-app-stable"]["timeout-minutes"];
  assert.equal(typeof debugCap, "number");
  assert.equal(typeof stableCap, "number");
  assert.ok(
    debugCap! - OBSERVED_MAX_MINUTES.debugAndTests >= REQUIRED_HEADROOM_MINUTES,
    `macos-app: cap ${debugCap}m vs observed ${OBSERVED_MAX_MINUTES.debugAndTests}m`
  );
  assert.ok(
    stableCap! - OBSERVED_MAX_MINUTES.stable >= REQUIRED_HEADROOM_MINUTES,
    `macos-app-stable: cap ${stableCap}m vs observed ${OBSERVED_MAX_MINUTES.stable}m`
  );
});

test("no macOS job runs the Stable build and the unit tests together again", () => {
  for (const [id, job] of Object.entries(jobs)) {
    assert.ok(!(buildsStable(job) && runsUnitTests(job)), `${id} builds Stable and runs the unit tests in one job`);
  }
});
