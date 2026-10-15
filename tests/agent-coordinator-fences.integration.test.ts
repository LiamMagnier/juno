/** Real-Postgres team attempt exhaustion and stale goal-advance fencing.
 * ORBIT_TEST_DATABASE_URL=…/juno_orbit_test NODE_OPTIONS=--conditions=react-server
 * npx tsx --test tests/agent-coordinator-fences.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const url = process.env.ORBIT_TEST_DATABASE_URL;

test("an exhausted team lead ends the team and cancels live members", { skip: !url }, async () => {
  assert.match(url!, /\/juno_[a-z_]*test$/);
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "coordinator-fence-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const store = await import("../src/lib/work/store");
  const teams = await import("../src/lib/agents/team-store");
  const userId = `team_limit_${randomUUID()}`;
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    const lead = await db.workSession.create({ data: { userId, title: "Team", goal: "Compare two approaches", teamRole: "lead", status: "interrupted" } });
    await teams.createTeamForLead({ userId, lead, request: lead.goal, specialists: ["researcher"] });
    await db.workRun.create({ data: { userId, sessionId: lead.id, attempt: 5, status: "interrupted", terminalReason: "interrupted" } });
    const members = await db.workSession.findMany({ where: { userId, parentSessionId: lead.id } });
    const active = await store.createRun({ userId, sessionId: members[0].id, requestedTarget: "cloud", spendReservation: false });
    assert.deepEqual(await teams.advanceTeam({ userId, leadId: lead.id, executorId: "coordinator" }), { kind: "skipped", reason: "lead_attempts_exhausted" });
    assert.equal((await db.workSession.findUniqueOrThrow({ where: { id: lead.id } })).status, "failed");
    assert.equal((await db.workRun.findUniqueOrThrow({ where: { id: active.run.id } })).terminalReason, "cancelled");
    const ended = await db.workSession.findMany({ where: { userId, parentSessionId: lead.id } });
    assert.ok(ended.every((member) => member.status === "failed" || member.status === "cancelled"));
    assert.equal(await db.workRun.count({ where: { userId, sessionId: lead.id } }), 1, "exhaustion never creates another lead attempt");
  } finally {
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    await db.$disconnect();
  }
});

test("a stale goal advance cannot overwrite or release its replacement's lease", { skip: !url, timeout: 10_000 }, async () => {
  assert.match(url!, /\/juno_[a-z_]*test$/);
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "coordinator-fence-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const { advanceGoal } = await import("../src/lib/agents/goal-runner");
  const userId = `goal_fence_${randomUUID()}`;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let advance: ReturnType<typeof advanceGoal> | undefined;
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    const agent = await db.agent.create({ data: { userId, name: "Goal", role: "Tester" } });
    const goal = await db.agentGoal.create({ data: { userId, agentId: agent.id, title: "Test fence", milestones: [{ id: "one", title: "First" }], maxRuns: 4 } });
    advance = advanceGoal({ user: { id: userId }, goalId: goal.id, deps: {
      async startStep() { entered(); await held; return { ok: false, message: "Old worker returned late" }; },
      async retryStep() { throw new Error("unexpected retry"); },
    } });
    await started;
    const replacementLease = new Date(Date.now() + 600_000);
    await db.agentGoal.update({ where: { id: goal.id }, data: { advanceLeaseUntil: replacementLease, nextAction: "Replacement is working", runsUsed: 3 } });
    release();
    assert.equal((await advance).kind, "busy");
    const current = await db.agentGoal.findUniqueOrThrow({ where: { id: goal.id } });
    assert.equal(current.advanceLeaseUntil?.getTime(), replacementLease.getTime());
    assert.equal(current.nextAction, "Replacement is working");
    assert.equal(current.runsUsed, 3);
  } finally {
    release();
    await advance?.catch(() => undefined);
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    await db.$disconnect();
  }
});
