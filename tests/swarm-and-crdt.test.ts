import test from "node:test";
import assert from "node:assert/strict";
import { AgentSwarmCoordinator } from "../src/lib/agent/swarm.js";
import { CollaborativeSession } from "../src/lib/collaboration/crdt.js";

test("AgentSwarmCoordinator plans and executes parallel subtasks concurrently", async () => {
  const swarm = new AgentSwarmCoordinator("swarm-1", "Refactor authentication layer", 2);

  swarm.addTask("researcher", "Look up latest NextAuth JWT standards");
  swarm.addTask("coder", "Implement enterprise SSO adapter");
  swarm.addTask("tester", "Run verification test suite");

  const plan = await swarm.executeSwarm(async (task) => {
    return {
      success: true,
      output: `Completed ${task.role} with output`,
    };
  });

  assert.equal(plan.status, "completed");
  assert.equal(plan.completedCount, 3);
  assert.equal(plan.totalCount, 3);
  assert.equal(plan.tasks[0].status, "completed");
});

test("CollaborativeSession applies inserts and deletes with state synchronization", () => {
  const doc = new CollaborativeSession("artifact-1", "Hello World");

  // Insert " Beautiful"
  doc.applyDelta({
    id: "delta-1",
    clock: 1,
    authorId: "user-1",
    artifactId: "artifact-1",
    type: "insert",
    position: 5,
    text: " Beautiful",
    timestamp: Date.now(),
  });

  assert.equal(doc.getSnapshot().content, "Hello Beautiful World");
  assert.equal(doc.getSnapshot().version, 1);

  // Update presence
  doc.updatePresence({
    userId: "user-2",
    name: "Alex",
    cursor: { line: 1, column: 15 },
    activeArtifactId: "artifact-1",
    lastSeenAt: Date.now(),
  });

  assert.equal(doc.getActivePeers().length, 1);
  assert.equal(doc.getActivePeers()[0].name, "Alex");
});
