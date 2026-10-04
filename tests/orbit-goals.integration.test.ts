/**
 * Durable goals on the Work ledger, against a real Postgres: a goal advances
 * through its milestones as ordinary Work tasks, survives its executor dying
 * mid-step (the process restart case), never starts two tasks for one step,
 * never retries a step that already acted, and stops at its run bound.
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_orbit_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test tests/orbit-goals.integration.test.ts
 *
 * The goal driver's two side effects (start a task, retry a task) are given
 * the real ledger functions here (`createWorkSession`, `createRun`) instead of
 * the full dispatch route, which needs a provider and a spend plan; everything
 * the test asserts about leases, attempts, reclaim and idempotency is the
 * production code.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ORBIT_TEST_DATABASE_URL;

test("a durable goal advances, recovers from a dead executor, stays single-flight and bounded", { skip: !url }, async () => {
  assert.match(url!, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "orbit-goals-isolated-integration-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const store = await import("../src/lib/work/store");
  const runner = await import("../src/lib/agents/goal-runner");
  const { RUN_LEASE_MS } = await import("../src/lib/work/domain");
  const { projectTaskBoard } = await import("../src/lib/work/board");

  const owner = `goals-${randomUUID()}`;
  const stranger = `goals-${randomUUID()}`;
  const starts: string[] = [];
  const deps: import("../src/lib/agents/goal-runner").GoalRunnerDeps = {
    async startStep({ user, agent, title, prompt, idempotencyKey }) {
      starts.push(idempotencyKey);
      // Idempotent like startAgentTask: the run's key finds the task again.
      const existing = await db.workRun.findFirst({ where: { userId: user.id, idempotencyKey } });
      if (existing) return { ok: true, sessionId: existing.sessionId };
      const session = await store.createWorkSession({ userId: user.id, title, goal: prompt, agentId: agent.id, requestedTarget: "cloud" });
      await store.createRun({ sessionId: session.id, userId: user.id, requestedTarget: "cloud", idempotencyKey, spendReservation: false });
      await db.workSession.updateMany({ where: { id: session.id, userId: user.id }, data: { status: "queued" } });
      return { ok: true, sessionId: session.id };
    },
    async retryStep({ user, sessionId, idempotencyKey }) {
      await store.createRun({ sessionId, userId: user.id, origin: "retry", requestedTarget: "cloud", idempotencyKey, spendReservation: false });
      await db.workSession.updateMany({ where: { id: sessionId, userId: user.id }, data: { status: "queued" } });
      return { ok: true };
    },
  };
  const latestRun = (sessionId: string) => db.workRun.findFirstOrThrow({ where: { sessionId }, orderBy: { attempt: "desc" } });
  const goalTasks = (goalId: string) => db.workSession.findMany({ where: { userId: owner, goalId }, orderBy: { createdAt: "asc" } });

  try {
    for (const id of [owner, stranger]) await db.user.create({ data: { id, email: `${id}@example.invalid` } });
    const agent = await db.agent.create({ data: { userId: owner, name: "Scout", role: "Research analyst" } });
    const goal = await db.agentGoal.create({
      data: {
        userId: owner,
        agentId: agent.id,
        title: "Weekly AI model briefing",
        detail: "Track model releases and benchmarks and prepare a briefing.",
        milestones: [{ id: "collect", title: "Collect this week's releases" }, { id: "brief", title: "Write the briefing" }],
        successCriteria: ["Cites at least five primary sources"],
        maxRuns: 4,
        maxAttemptsPerStep: 2,
      },
    });
    const user = { id: owner };
    let now = new Date("2026-10-04T09:00:00Z");

    // 1. First advance starts milestone one as a Work task linked to the goal.
    const first = await runner.advanceGoal({ user, goalId: goal.id, now, deps });
    assert.equal(first.kind, "advanced");
    assert.deepEqual(first.kind === "advanced" && first.steps, ["start"]);
    let tasks = await goalTasks(goal.id);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.goalStepKey, "collect");
    assert.equal(tasks[0]!.completionCriteria, "Cites at least five primary sources");
    assert.equal(tasks[0]!.agentId, agent.id);

    // 2. Concurrent advances while the task is queued: single-flight, no second task.
    const racing = await Promise.all([1, 2, 3, 4].map(() => runner.advanceGoal({ user, goalId: goal.id, now, deps })));
    assert.ok(racing.every((r) => r.kind === "busy" || (r.kind === "advanced" && r.steps.every((s) => s === "idle"))));
    assert.equal((await goalTasks(goal.id)).length, 1);
    // Another account cannot advance it.
    assert.equal((await runner.advanceGoal({ user: { id: stranger }, goalId: goal.id, now, deps })).kind, "missing");

    // 3. Executor A claims and heartbeats, then the process dies (no more renewals).
    const run1 = await latestRun(tasks[0]!.id);
    assert.equal((await store.claimRun({ runId: run1.id, userId: owner, executorId: "executor-A", now })).claimed, true);
    assert.equal(await store.renewRunLease({ runId: run1.id, userId: owner, executorId: "executor-A", now: new Date(now.getTime() + RUN_LEASE_MS / 2) }), true);
    assert.equal(await store.renewRunLease({ runId: run1.id, userId: owner, executorId: "executor-B", now }), false, "only the holder heartbeats");
    // A sweep before the lease lapses touches nothing.
    assert.deepEqual((await store.reclaimStalledRuns({ userId: owner, now: new Date(now.getTime() + RUN_LEASE_MS) })).reclaimed, []);
    let board = projectTaskBoard([{ id: tasks[0]!.id, status: (await db.workSession.findFirstOrThrow({ where: { id: tasks[0]!.id } })).status, leaseExpiresAt: (await latestRun(tasks[0]!.id)).leaseExpiresAt }], now);
    assert.equal(board[0]!.state, "claimed");

    // ...restart: well past the lease, the sweep ends the run as interrupted.
    now = new Date(now.getTime() + 3 * RUN_LEASE_MS);
    assert.deepEqual((await store.reclaimStalledRuns({ userId: owner, now })).reclaimed, [run1.id]);
    assert.equal(await store.renewRunLease({ runId: run1.id, userId: owner, executorId: "executor-A", now }), false, "a dead executor cannot revive its run");
    board = projectTaskBoard([{ id: tasks[0]!.id, status: "interrupted" }], now);
    assert.equal(board[0]!.state, "blocked");

    // 4. The goal remembers what it was doing: it never acted, so it retries the same task.
    const recovered = await runner.advanceGoal({ user, goalId: goal.id, now, deps });
    assert.deepEqual(recovered.kind === "advanced" && recovered.steps, ["retry"]);
    tasks = await goalTasks(goal.id);
    assert.equal(tasks.length, 1, "the retry is a new attempt of the same task, not a new task");
    const run2 = await latestRun(tasks[0]!.id);
    assert.equal(run2.attempt, 2);
    assert.equal(run2.origin, "retry");
    // A second advance replays nothing.
    await runner.advanceGoal({ user, goalId: goal.id, now, deps });
    assert.equal(await db.workRun.count({ where: { sessionId: tasks[0]!.id } }), 2);

    // 5. Executor B finishes milestone one; the next advance marks it and starts milestone two.
    assert.equal((await store.claimRun({ runId: run2.id, userId: owner, executorId: "executor-B", now })).claimed, true);
    await store.appendEvents({ runId: run2.id, userId: owner, events: [{ kind: "tool_started", payload: { tool: "web_search" } }] });
    await store.finishRun({ runId: run2.id, userId: owner, reason: "completed", executorId: "executor-B", now, usage: { costMicroUsd: 120_000, inputTokens: 10, outputTokens: 10 } });
    const second = await runner.advanceGoal({ user, goalId: goal.id, now, deps });
    assert.deepEqual(second.kind === "advanced" && second.steps, ["complete_step", "start"]);
    const afterSecond = await db.agentGoal.findFirstOrThrow({ where: { id: goal.id } });
    assert.equal(afterSecond.progress, 50);
    assert.equal(afterSecond.spentMicroUsd, 120_000);
    assert.equal(afterSecond.runsUsed, 3, "start, retry, start: a retry spends a run too");
    tasks = await goalTasks(goal.id);
    assert.deepEqual(tasks.map((t) => t.goalStepKey), ["collect", "brief"]);

    // 6. Milestone two's executor dies AFTER acting: no automatic retry; the goal asks.
    const run3 = await latestRun(tasks[1]!.id);
    await store.claimRun({ runId: run3.id, userId: owner, executorId: "executor-C", now });
    await store.appendEvents({ runId: run3.id, userId: owner, events: [{ kind: "files_changed", payload: { count: 1 } }] });
    now = new Date(now.getTime() + 3 * RUN_LEASE_MS);
    await store.reclaimStalledRuns({ userId: owner, now });
    const asked = await runner.advanceGoal({ user, goalId: goal.id, now, deps });
    assert.deepEqual(asked.kind === "advanced" && asked.steps, ["ask"]);
    const blocked = await db.agentGoal.findFirstOrThrow({ where: { id: goal.id } });
    assert.equal(blocked.status, "active");
    assert.match(String((blocked.blockers as { text: string }[])[0]?.text), /may already have changed something/);
    assert.equal(await db.workRun.count({ where: { sessionId: tasks[1]!.id } }), 1, "nothing was re-run on its own");
    assert.equal(await db.agentEvent.count({ where: { userId: owner, kind: "goal_blocked" } }), 1);
    // Asking again does not repeat the event.
    await runner.advanceGoal({ user, goalId: goal.id, now, deps });
    assert.equal(await db.agentEvent.count({ where: { userId: owner, kind: "goal_blocked" } }), 1);

    // 7. The person retries it by hand and it completes: the goal is met.
    const manual = await store.createRun({ sessionId: tasks[1]!.id, userId: owner, origin: "retry", requestedTarget: "cloud", spendReservation: false });
    await store.claimRun({ runId: manual.run.id, userId: owner, executorId: "executor-D", now });
    await store.finishRun({ runId: manual.run.id, userId: owner, reason: "completed", executorId: "executor-D", now });
    const done = await runner.advanceGoal({ user, goalId: goal.id, now, deps });
    assert.deepEqual(done.kind === "advanced" && done.steps, ["complete_step", "achieved"]);
    const achieved = await db.agentGoal.findFirstOrThrow({ where: { id: goal.id } });
    assert.equal(achieved.status, "achieved");
    assert.equal(achieved.progress, 100);
    assert.equal(achieved.advanceLeaseUntil, null, "the driver's lease is always released");

    // 8. Bounded: a goal with a one-run limit pauses instead of looping.
    const bounded = await db.agentGoal.create({ data: { userId: owner, agentId: agent.id, title: "Keep an eye on pricing", cadence: "daily", maxRuns: 1 } });
    await runner.advanceGoal({ user, goalId: bounded.id, now, deps });
    const [only] = await goalTasks(bounded.id);
    const onlyRun = await latestRun(only!.id);
    await store.claimRun({ runId: onlyRun.id, userId: owner, executorId: "executor-E", now });
    await store.finishRun({ runId: onlyRun.id, userId: owner, reason: "completed", executorId: "executor-E", now });
    // Same day: the next step waits for its cadence; nothing new starts.
    await runner.advanceGoal({ user, goalId: bounded.id, now, deps });
    assert.equal((await goalTasks(bounded.id)).length, 1);
    // A day later the run bound stops it and it pauses with a reason.
    const later = new Date(Math.max(now.getTime(), Date.now()) + 25 * 60 * 60_000);
    const stopped = await runner.advanceGoal({ user, goalId: bounded.id, now: later, deps });
    assert.deepEqual(stopped.kind === "advanced" && stopped.steps, ["ask"]);
    const paused = await db.agentGoal.findFirstOrThrow({ where: { id: bounded.id } });
    assert.equal(paused.status, "paused");
    assert.match(String((paused.blockers as { text: string }[])[0]?.text), /Used 1 of 1 runs/);
    assert.equal((await goalTasks(bounded.id)).length, 1);

    // 9. The sweep only drives goals whose owner turned driving on (maxRuns > 0).
    const topic = await db.agentGoal.create({ data: { userId: owner, agentId: agent.id, title: "A reflection topic" } });
    starts.length = 0;
    await runner.sweepGoals(later, deps);
    assert.ok(!starts.some((key) => key.startsWith(`goal:${topic.id}:`)), "an undriven goal never starts work");
  } finally {
    await db.workSession.deleteMany({ where: { userId: { in: [owner, stranger] } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: [owner, stranger] } } }).catch(() => {});
    await db.$disconnect();
  }
});
