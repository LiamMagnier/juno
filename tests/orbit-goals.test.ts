import test from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_NEXT_STEP_KEY,
  MAX_GOAL_MILESTONES,
  goalProgress,
  goalSummarySentence,
  markMilestoneDone,
  parseCriteria,
  parseMilestones,
  planGoalStep,
  type GoalTaskView,
  type GoalView,
} from "../src/lib/agents/goals";
import { boardStateForWorkStatus, boardStateSentence, projectTaskBoard, validateDependencies, MAX_TASK_DEPENDENCIES } from "../src/lib/work/board";
import { WORK_STATUSES } from "../src/lib/work/domain";

const now = new Date("2026-10-04T12:00:00Z");

function goal(partial: Partial<GoalView> = {}): GoalView {
  return {
    id: "g1",
    title: "Weekly briefing",
    detail: "Prepare the weekly AI briefing",
    status: "active",
    milestones: parseMilestones([{ id: "a", title: "Collect" }, { id: "b", title: "Write" }]),
    successCriteria: ["Five primary sources"],
    budgetMicroUsd: null,
    spentMicroUsd: 0,
    maxRuns: 6,
    runsUsed: 0,
    maxAttemptsPerStep: 2,
    dueAt: null,
    cadence: "weekly",
    ...partial,
  };
}

function task(partial: Partial<GoalTaskView>): GoalTaskView {
  return { sessionId: "s1", stepKey: "a", status: "completed", attempt: 1, acted: true, costMicroUsd: 0, createdAt: new Date("2026-10-04T10:00:00Z"), ...partial };
}

test("milestones and criteria are parsed, clipped and bounded", () => {
  const parsed = parseMilestones(["Collect", { id: "a", title: "x" }, { id: "a", title: "dup id" }, { title: "" }, { id: "next", title: "reserved" }]);
  assert.deepEqual(parsed.map((m) => m.id), ["m1", "a", "a_", "next_"]);
  assert.equal(parseMilestones(Array.from({ length: 40 }, (_, i) => `M${i}`)).length, MAX_GOAL_MILESTONES);
  assert.deepEqual(parseMilestones("nope"), []);
  assert.deepEqual(parseCriteria([" a ", 3, ""]), ["a"]);
});

test("progress is derived from milestones", () => {
  const ms = parseMilestones(["a", "b", "c", "d"]);
  assert.equal(goalProgress(ms, "active"), 0);
  assert.equal(goalProgress(markMilestoneDone(ms, "m1", "s"), "active"), 25);
  assert.equal(goalProgress([], "achieved"), 100);
});

test("a fresh goal starts its first milestone with a stable idempotency key", () => {
  const step = planGoalStep(goal(), [], now);
  assert.equal(step.kind, "start");
  assert.ok(step.kind === "start");
  assert.equal(step.stepKey, "a");
  assert.equal(step.idempotencyKey, "g1:a:1".replace(/^/, "goal:"));
  assert.match(step.prompt, /one milestone of it: Collect/);
  assert.match(step.prompt, /Five primary sources/);
  assert.deepEqual(planGoalStep(goal(), [], now), step, "the same state plans the same step");
});

test("one task at a time: a live task means idle", () => {
  for (const status of ["queued", "running", "waiting_approval", "paused"]) {
    const step = planGoalStep(goal(), [task({ status })], now);
    assert.equal(step.kind, "idle", status);
  }
  const waiting = planGoalStep(goal(), [task({ status: "waiting_input" })], now);
  assert.match(waiting.nextAction ?? "", /Waiting for your answer/);
});

test("a completed step is marked before the next starts; all done is achieved", () => {
  const step = planGoalStep(goal(), [task({ status: "completed" })], now);
  assert.deepEqual(step.kind === "complete_step" && [step.sessionId, step.stepKey], ["s1", "a"]);
  const allDone = goal({ milestones: markMilestoneDone(markMilestoneDone(goal().milestones, "a", "s1"), "b", "s2") });
  assert.equal(planGoalStep(allDone, [], now).kind, "achieved");
});

test("an interrupted step that never acted is retried within its attempts; one that acted asks", () => {
  const retry = planGoalStep(goal(), [task({ status: "interrupted", acted: false, attempt: 1 })], now);
  assert.deepEqual(retry.kind === "retry" && [retry.sessionId, retry.attempt], ["s1", 2]);
  const exhausted = planGoalStep(goal(), [task({ status: "interrupted", acted: false, attempt: 2 })], now);
  assert.equal(exhausted.kind, "ask");
  const acted = planGoalStep(goal(), [task({ status: "interrupted", acted: true })], now);
  assert.ok(acted.kind === "ask" && acted.blocker.kind === "needs_decision" && /may already have changed/.test(acted.blocker.text));
  assert.ok(acted.kind === "ask" && !acted.pause, "a decision is asked for without pausing the goal");
});

test("a failed step never loops: it asks", () => {
  for (const status of ["failed", "timed_out", "budget_exceeded"]) {
    const step = planGoalStep(goal(), [task({ status })], now);
    assert.ok(step.kind === "ask" && step.blocker.kind === "step_failed", status);
  }
});

test("bounds: run limit, budget and due date pause the goal with a reason", () => {
  const runs = planGoalStep(goal({ runsUsed: 6 }), [], now);
  assert.ok(runs.kind === "ask" && runs.pause && runs.blocker.kind === "run_budget" && /Used 6 of 6 runs/.test(runs.blocker.text));
  const money = planGoalStep(goal({ budgetMicroUsd: 1_000, spentMicroUsd: 1_000 }), [], now);
  assert.ok(money.kind === "ask" && money.blocker.kind === "spend_budget");
  const late = planGoalStep(goal({ dueAt: new Date("2026-10-01T00:00:00Z") }), [], now);
  assert.ok(late.kind === "ask" && late.blocker.kind === "overdue");
  assert.equal(planGoalStep(goal({ status: "paused" }), [], now).kind, "idle");
});

test("a goal without milestones takes one step per cadence, never back to back", () => {
  const open = goal({ milestones: [], cadence: "daily" });
  const first = planGoalStep(open, [], now);
  assert.ok(first.kind === "start" && first.stepKey === GOAL_NEXT_STEP_KEY);
  const doneRecently = [task({ stepKey: GOAL_NEXT_STEP_KEY, createdAt: new Date(now.getTime() - 60 * 60_000) })];
  assert.equal(planGoalStep(open, doneRecently, now).kind, "idle");
  const doneYesterday = [task({ stepKey: GOAL_NEXT_STEP_KEY, createdAt: new Date(now.getTime() - 25 * 60 * 60_000) })];
  assert.equal(planGoalStep(open, doneYesterday, now).kind, "start");
  assert.equal(planGoalStep(goal({ milestones: [], cadence: "none" }), doneYesterday, now).kind, "idle");
});

test("an unbounded loop is impossible: repeatedly applying the plan stops within maxRuns", () => {
  let view = goal({ milestones: [], cadence: "daily", maxRuns: 5 });
  const tasks: GoalTaskView[] = [];
  let clock = now.getTime();
  let started = 0;
  for (let i = 0; i < 100; i++) {
    clock += 25 * 60 * 60_000;
    const step = planGoalStep(view, tasks, new Date(clock));
    if (step.kind === "start") {
      started += 1;
      tasks.push(task({ sessionId: `s${i}`, stepKey: step.stepKey, status: "completed", createdAt: new Date(clock) }));
      view = { ...view, runsUsed: view.runsUsed + 1 };
    } else if (step.kind === "ask" && step.pause) {
      view = { ...view, status: "paused" };
    }
  }
  assert.equal(started, 5);
  assert.equal(view.status, "paused");
});

test("summary sentence reads as progress, not status codes", () => {
  assert.equal(goalSummarySentence({ milestones: markMilestoneDone(goal().milestones, "a", "s"), status: "active", nextAction: 'Starting "Write"', runsUsed: 2, maxRuns: 6 }), '1 of 2 milestones · Starting "Write" · 2 of 6 runs used');
});

// ---------------------------------------------------------------------------
// The task board
// ---------------------------------------------------------------------------

test("every Work status maps onto one board state", () => {
  for (const status of WORK_STATUSES) assert.ok(boardStateForWorkStatus(status));
  assert.equal(boardStateForWorkStatus("queued"), "pending");
  assert.equal(boardStateForWorkStatus("preparing"), "claimed");
  assert.equal(boardStateForWorkStatus("waiting_approval"), "waiting_for_user");
  assert.equal(boardStateForWorkStatus("interrupted"), "blocked");
  assert.equal(boardStateForWorkStatus("timed_out"), "failed");
});

test("dependencies: waiting until done, blocked when one fails, overdue and stale flagged", () => {
  const board = projectTaskBoard(
    [
      { id: "a", status: "running", leaseExpiresAt: new Date(now.getTime() - 1) },
      { id: "b", status: "queued", dependsOnSessionIds: ["a"] },
      { id: "c", status: "completed" },
      { id: "d", status: "queued", dependsOnSessionIds: ["c"] },
      { id: "e", status: "failed" },
      { id: "f", status: "queued", dependsOnSessionIds: ["c", "e"], deadlineAt: "2026-10-01T00:00:00Z" },
    ],
    now
  );
  const by = new Map(board.map((t) => [t.id, t]));
  assert.equal(by.get("a")!.stale, true);
  assert.equal(by.get("b")!.state, "waiting_for_dependency");
  assert.deepEqual(by.get("b")!.waitingOn, ["a"]);
  assert.equal(by.get("d")!.state, "pending");
  assert.equal(by.get("f")!.state, "blocked");
  assert.equal(by.get("f")!.overdue, true);
  assert.equal(boardStateSentence(by.get("b")!), "Waiting for another task to finish");
  assert.equal(boardStateSentence(by.get("f")!), "Stopped, needs a decision · past its deadline");
});

test("dependency writes refuse cycles, self, unknown ids and too many", () => {
  const existing = new Map<string, string[]>([["a", []], ["b", ["a"]], ["c", ["b"]]]);
  assert.deepEqual(validateDependencies({ taskId: "a", dependsOn: ["c"], existing }), { ok: false, reason: "cycle" });
  assert.deepEqual(validateDependencies({ taskId: "a", dependsOn: ["a"], existing }), { ok: false, reason: "self" });
  assert.deepEqual(validateDependencies({ taskId: "x", dependsOn: ["zz"], existing }), { ok: false, reason: "unknown" });
  const many = new Map(Array.from({ length: 20 }, (_, i) => [`t${i}`, [] as string[]]));
  assert.deepEqual(validateDependencies({ taskId: "x", dependsOn: [...many.keys()].slice(0, MAX_TASK_DEPENDENCIES + 1), existing: many }), { ok: false, reason: "too_many" });
  assert.deepEqual(validateDependencies({ taskId: "d", dependsOn: ["c", "c"], existing }), { ok: true, dependsOn: ["c"] });
});

test("Continue on a stopped step retries it once, still inside the run bound", () => {
  const acted = [task({ status: "interrupted", acted: true, attempt: 1 })];
  const step = planGoalStep(goal(), acted, now, { retryApproved: true });
  assert.deepEqual(step.kind === "retry" && step.attempt, 2);
  assert.equal(planGoalStep(goal({ runsUsed: 6 }), acted, now, { retryApproved: true }).kind, "ask");
  assert.equal(planGoalStep(goal(), [task({ status: "failed" })], now, { retryApproved: true }).kind, "retry");
});
