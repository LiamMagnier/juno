import test, { mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The goal runner (src/lib/agents/goal-runner.ts), driven for real with the
 * database and the agent store stood in.
 *
 * Its sweep acts with nobody watching (scripts/agent-reflector.ts). It used to
 * start steps through the interactive dispatch, which reads a failed heartbeat
 * read as "no cloud worker", so a database hiccup put a needs_decision blocker
 * and a task_refused line on the goal for the person to clear. The sweep now
 * asks for the three-way answer, and "unknown" is retry-later: no blocker,
 * nothing on the member, the same step tried on the next pass.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *     tests/orbit-unattended-dispatch.test.ts
 *
 * The pure rule and the wiring are pinned without module mocks in
 * tests/orbit-goals.test.ts and tests/work-executor-presence.test.ts, which
 * `npm test` runs.
 */

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the suite skips there rather than failing.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

type Row = Record<string, unknown>;

interface World {
  goal: Row;
  agentEvents: Row[];
  startCalls: Row[];
  startOutcome: Row;
}

let world: World;

function reset(): void {
  world = {
    goal: {
      id: "goal_1",
      userId: "user_1",
      agentId: "agent_1",
      title: "Weekly briefing",
      detail: "",
      status: "active",
      milestones: [{ id: "collect", title: "Collect this week's releases" }],
      successCriteria: [],
      budgetMicroUsd: null,
      spentMicroUsd: 0,
      maxRuns: 4,
      runsUsed: 0,
      maxAttemptsPerStep: 2,
      dueAt: null,
      cadence: "none",
      blockers: [{ kind: "overdue", text: "An older note the person has not cleared.", at: "2026-10-01T00:00:00.000Z" }],
      nextAction: null,
      progress: 0,
      advanceLeaseUntil: null,
      lastAdvancedAt: null,
    },
    agentEvents: [],
    startCalls: [],
    startOutcome: { kind: "started", sessionId: "wsi_1", conversationId: "conv_1", replay: false },
  };
}
reset();

/** `{ increment: n }` and plain values, as Prisma applies them. */
function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !Array.isArray(value) && "increment" in value) {
      row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
    } else {
      row[key] = value;
    }
  }
}

const agent = { id: "agent_1", userId: "user_1", name: "Scout", status: "active", executionTarget: "cloud", deletedAt: null };

const db = {
  agentGoal: {
    async updateMany(args: { where: Row; data: Row }) {
      const goal = world.goal;
      if (args.where.OR) {
        // The claim: free, or its lease ran out before `now`.
        const now = ((args.where.OR as Row[])[1]?.advanceLeaseUntil as { lt: Date }).lt;
        if (goal.advanceLeaseUntil instanceof Date && goal.advanceLeaseUntil >= now) return { count: 0 };
        apply(goal, args.data);
        return { count: 1 };
      }
      if (args.where.advanceLeaseUntil !== undefined && args.where.advanceLeaseUntil !== goal.advanceLeaseUntil) return { count: 0 };
      apply(goal, args.data);
      return { count: 1 };
    },
    async findFirst() {
      return structuredClone(world.goal);
    },
    async count() {
      return 1;
    },
  },
  agent: {
    async findFirst() {
      return agent;
    },
  },
  workSession: {
    async findMany() {
      return [];
    },
    async updateMany() {
      return { count: 1 };
    },
  },
  workEvent: {
    async findMany() {
      return [];
    },
  },
};

if (!canMockModules) {
  test("unattended Orbit dispatch suite needs --experimental-test-module-mocks", { skip: true }, () => {});
} else {
  mock.module("@/lib/db", { namedExports: { prisma: db, prismaUnguarded: { ...db, agentGoal: { ...db.agentGoal, findMany: async () => [{ id: "goal_1", userId: "user_1" }] } } } });
  mock.module("@/lib/agents/store", {
    namedExports: {
      recordAgentEvent: async (event: Row) => {
        world.agentEvents.push(event);
      },
      startAgentTask: async (_user: unknown, _agent: unknown, input: Row) => {
        world.startCalls.push(input);
        return world.startOutcome;
      },
    },
  });
  // Loaded after the mocks above, inside a test (no top-level await in CJS).
  const load = async () => ({
    runner: await import("@/lib/agents/goal-runner"),
    goals: await import("@/lib/agents/goals"),
    presence: await import("@/lib/work/executor-presence"),
  });
  const now = new Date("2026-10-26T09:00:00Z");
  const user = { id: "user_1" };

  test("a step the sweep could not start for an unreadable heartbeat waits, with no blocker and nothing on the member", async () => {
    const { runner, goals, presence } = await load();
    reset();
    const before = structuredClone(world.goal.blockers);
    const deps: import("@/lib/agents/goal-runner").GoalRunnerDeps = {
      startStep: async () => ({ ok: false, message: presence.EXECUTOR_UNKNOWN_EXPLANATION, retryLater: true }),
      retryStep: async () => ({ ok: true }),
    };
    const outcome = await runner.advanceGoal({ user, goalId: "goal_1", now, deps });
    assert.equal(outcome.kind, "advanced");
    assert.deepEqual(world.goal.blockers, before, "the goal's blockers are left as they were");
    assert.equal(world.goal.nextAction, goals.GOAL_WAITING_ON_EXECUTOR_CHECK);
    assert.equal(world.goal.runsUsed, 0, "no run was used");
    assert.equal(world.goal.status, "active");
    assert.equal(world.goal.advanceLeaseUntil, null, "the lease is released for the next pass");
    assert.deepEqual(world.agentEvents, [], "no task_refused, no goal_blocked");
  });

  test("a real refusal still becomes a decision for the person, said once on the member", async () => {
    const { runner } = await load();
    reset();
    const message = "No cloud worker is running, so nothing was started.";
    const deps: import("@/lib/agents/goal-runner").GoalRunnerDeps = {
      startStep: async () => ({ ok: false, message }),
      retryStep: async () => ({ ok: true }),
    };
    await runner.advanceGoal({ user, goalId: "goal_1", now, deps });
    const blockers = world.goal.blockers as Row[];
    assert.equal(blockers[0]?.kind, "needs_decision");
    assert.equal(blockers[0]?.text, message);
    assert.equal(world.agentEvents.filter((e) => e.kind === "task_refused").length, 1);
    // The same refusal again is not said twice.
    await runner.advanceGoal({ user, goalId: "goal_1", now: new Date(now.getTime() + 60_000), deps });
    assert.equal(world.agentEvents.filter((e) => e.kind === "task_refused").length, 1);
  });

  test("the sweep starts steps unattended; a person's press does not", async () => {
    const { runner, goals, presence } = await load();
    reset();
    world.startOutcome = { kind: "refused", status: 503, body: presence.executorUnknownRefusal() };
    await runner.sweepGoals(now);
    assert.equal(world.startCalls.length, 1);
    assert.equal(world.startCalls[0]?.unattended, true, "the sweep's default deps are unattended");
    assert.deepEqual(world.agentEvents, [], "retry-later from dispatch is not a refusal");
    assert.equal(world.goal.nextAction, goals.GOAL_WAITING_ON_EXECUTOR_CHECK);

    const unattended = await runner.unattendedGoalRunnerDeps.startStep({ user, agent: agent as never, title: "t", prompt: "p", idempotencyKey: "k" });
    assert.deepEqual(unattended, { ok: false, message: presence.EXECUTOR_UNKNOWN_EXPLANATION, retryLater: true });

    world.startOutcome = { kind: "refused", status: 409, body: { error: "no_executor_available", message: "No cloud worker is running." } };
    const pressed = await runner.defaultGoalRunnerDeps.startStep({ user, agent: agent as never, title: "t", prompt: "p", idempotencyKey: "k" });
    assert.equal(world.startCalls.at(-1)?.unattended, false);
    assert.deepEqual(pressed, { ok: false, message: "No cloud worker is running." });
  });
}
