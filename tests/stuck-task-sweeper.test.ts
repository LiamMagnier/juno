import test from "node:test";
import assert from "node:assert/strict";
import {
  ABSOLUTE_RUN_LIMIT_MS,
  SILENCE_LIMIT_MS,
  assessTask,
  selectStuckTasks,
  sweepCutoff,
  type SweepCandidate,
} from "@/lib/stuck-task-sweeper";

/*
 * A cloud run posts its own terminal status. When the runner is hard-killed
 * first the post never happens and the task stays `running` forever — the
 * workflow said so in a comment and nothing ever moved it. These pin the rule
 * that moves it, and the conservatism that stops it moving a live one.
 */

const NOW = new Date("2026-08-04T12:00:00Z");
const minutes = (n: number) => n * 60_000;

function task(overrides: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    id: "task-1",
    status: "running",
    createdAt: new Date(NOW.getTime() - minutes(30)),
    updatedAt: new Date(NOW.getTime() - minutes(1)),
    runnerClaimedAt: new Date(NOW.getTime() - minutes(29)),
    target: "cloud",
    ...overrides,
  };
}

test("a task that spoke recently is left alone", () => {
  assert.equal(assessTask(task(), NOW).sweep, false);
});

test("a long-running task that is still streaming is not swept", () => {
  // The conservatism that matters: a slow compile or an overloaded provider
  // makes a run take hours. Age alone must never be the trigger.
  const slow = task({
    createdAt: new Date(NOW.getTime() - minutes(200)),
    updatedAt: new Date(NOW.getTime() - minutes(2)),
  });
  assert.equal(assessTask(slow, NOW).sweep, false);
});

test("a silent running task is presumed to have lost its runner", () => {
  const silent = task({
    updatedAt: new Date(NOW.getTime() - SILENCE_LIMIT_MS.running - minutes(1)),
  });
  const verdict = assessTask(silent, NOW);
  assert.equal(verdict.sweep, true);
  assert.equal(verdict.reason, "runner_lost");
  assert.match(String(verdict.message), /did not post a final status/);
});

test("a queued task nobody claimed is a dispatch failure, named as one", () => {
  // Distinct from a runner that started and died: the fixes are different, and
  // collapsing them hides a systemic dispatch outage inside ordinary failures.
  const orphan = task({
    status: "queued",
    runnerClaimedAt: null,
    updatedAt: new Date(NOW.getTime() - SILENCE_LIMIT_MS.queued - minutes(1)),
  });
  const verdict = assessTask(orphan, NOW);
  assert.equal(verdict.sweep, true);
  assert.equal(verdict.reason, "never_claimed");
});

test("a claimed task that went silent is 'runner lost', not 'never claimed'", () => {
  const died = task({
    runnerClaimedAt: new Date(NOW.getTime() - minutes(90)),
    updatedAt: new Date(NOW.getTime() - SILENCE_LIMIT_MS.running - minutes(1)),
  });
  assert.equal(assessTask(died, NOW).reason, "runner_lost");
});

test("past the absolute ceiling the runner cannot still exist, however recently it spoke", () => {
  // GitHub cancels a job at six hours. A task older than that plus a margin has
  // definitively lost its runner even if a late event just landed.
  const ancient = task({
    createdAt: new Date(NOW.getTime() - ABSOLUTE_RUN_LIMIT_MS - minutes(1)),
    updatedAt: new Date(NOW.getTime() - minutes(1)),
  });
  const verdict = assessTask(ancient, NOW);
  assert.equal(verdict.sweep, true);
  assert.equal(verdict.reason, "exceeded_time_limit");
});

test("terminal tasks are never touched", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const finished = task({
      status,
      updatedAt: new Date(NOW.getTime() - minutes(10_000)),
    });
    assert.equal(assessTask(finished, NOW).sweep, false, `${status} must be left alone`);
  }
});

test("a queued task gets a shorter grace period than a running one", () => {
  // A queued task is not doing anything; a running one may legitimately be
  // quiet mid-build.
  assert.ok(SILENCE_LIMIT_MS.queued < SILENCE_LIMIT_MS.running);

  const quiet = { updatedAt: new Date(NOW.getTime() - SILENCE_LIMIT_MS.queued - minutes(1)) };
  assert.equal(assessTask(task({ status: "queued", ...quiet }), NOW).sweep, true);
  assert.equal(assessTask(task({ status: "running", ...quiet }), NOW).sweep, false);
});

test("selection filters a batch to only the dead", () => {
  const batch = [
    task({ id: "alive", updatedAt: new Date(NOW.getTime() - minutes(1)) }),
    task({ id: "dead", updatedAt: new Date(NOW.getTime() - minutes(120)) }),
    task({ id: "finished", status: "completed", updatedAt: new Date(NOW.getTime() - minutes(500)) }),
  ];
  const stuck = selectStuckTasks(batch, NOW);
  assert.deepEqual(stuck.map((entry) => entry.task.id), ["dead"]);
});

test("the query cutoff cannot exclude a task the policy would sweep", () => {
  // If the cutoff were tighter than the longest silence window, the sweeper
  // would never load the rows it is supposed to act on.
  const cutoff = sweepCutoff(NOW);
  const longest = Math.max(...Object.values(SILENCE_LIMIT_MS));
  assert.ok(cutoff.getTime() <= NOW.getTime() - longest);
});
