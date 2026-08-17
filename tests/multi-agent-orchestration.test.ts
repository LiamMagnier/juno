import test from "node:test";
import assert from "node:assert/strict";
import { AgentSwarmCoordinator } from "../src/lib/agent/swarm.js";
import type { AgentRuntimeEvent } from "../src/lib/agent/types.js";

test("AgentSwarmCoordinator executes DAG with dependencies and specialist roles", async () => {
  const swarm = new AgentSwarmCoordinator("swarm-dag-1", "Build and verify authentication module", 3);

  // 1. Planner task
  const planner = swarm.addTask("planner", "Decompose auth requirements");

  // 2. Parallel researcher & architect tasks depending on planner
  const researcher = swarm.addTask("researcher", "Research OAuth2 PKCE RFC specs", {
    dependencies: [planner.id],
  });
  const architect = swarm.addTask("coder", "Design database schema for tokens", {
    dependencies: [planner.id],
  });

  // 3. Tester depends on coder
  const tester = swarm.addTask("tester", "Write unit tests for token storage", {
    dependencies: [architect.id],
  });

  // 4. Synthesizer depends on researcher and tester
  const synth = swarm.addTask("synthesizer", "Synthesize findings and verification report", {
    dependencies: [researcher.id, tester.id],
  });

  const executedOrder: string[] = [];
  const events: AgentRuntimeEvent[] = [];

  const plan = await swarm.executeSwarm(
    async (task) => {
      executedOrder.push(task.id);
      return {
        success: true,
        output: `Output for ${task.role}: ${task.prompt}`,
      };
    },
    {
      userId: "user-1",
      sessionId: "session-1",
      mode: "work",
      environment: "server_sandbox",
      onEvent: (e) => {
        events.push(e);
      },
    }
  );

  assert.equal(plan.status, "completed");
  assert.equal(plan.completedCount, 5);
  assert.equal(plan.totalCount, 5);

  // Assert topological ordering: planner first, synth last
  assert.equal(executedOrder[0], planner.id);
  assert.equal(executedOrder[executedOrder.length - 1], synth.id);
  assert.ok(events.length >= 10); // Start and finish events for each
  assert.ok(plan.synthesizedOutput?.includes("Synthesize findings"));
});

test("AgentSwarmCoordinator detects and rejects circular dependencies", () => {
  const swarm = new AgentSwarmCoordinator("cycle-check", "Invalid cyclic workflow");

  const taskA = swarm.addTask("coder", "Task A");
  const taskB = swarm.addTask("tester", "Task B", { dependencies: [taskA.id] });

  assert.throws(
    () => {
      // Adding task C that depends on B, and A depends on C creates a cycle
      swarm.addTask("researcher", "Task C", { id: taskA.id, dependencies: [taskB.id] });
    },
    /Circular dependency/
  );
});

test("AgentSwarmCoordinator skips dependent tasks when upstream task fails", async () => {
  const swarm = new AgentSwarmCoordinator("fail-test", "Handle task failure gracefully");

  const taskA = swarm.addTask("coder", "Task that fails");
  const taskB = swarm.addTask("tester", "Task dependent on failure", {
    dependencies: [taskA.id],
  });

  const plan = await swarm.executeSwarm(async (task) => {
    if (task.id === taskA.id) {
      return { success: false, output: "", error: "Compilation error in code task" };
    }
    return { success: true, output: "OK" };
  });

  assert.equal(plan.status, "failed");
  assert.equal(plan.tasks[0].status, "failed");
  assert.equal(plan.tasks.find((t) => t.id === taskB.id)?.status, "skipped");
  assert.ok(plan.tasks.find((t) => t.id === taskB.id)?.error?.includes("upstream dependency failure"));
});

test("AgentSwarmCoordinator respects per-task timeouts", async () => {
  const swarm = new AgentSwarmCoordinator("timeout-test", "Timeout enforcement", 1);

  swarm.addTask("researcher", "Slow research task", { timeoutMs: 50 });

  const plan = await swarm.executeSwarm(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { success: true, output: "Done" };
  });

  assert.equal(plan.status, "failed");
  assert.equal(plan.tasks[0].status, "failed");
  assert.ok(plan.tasks[0].error?.includes("timed out"));
});
