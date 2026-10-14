/**
 * An agent's later restrictions reach the routines it already has
 * (src/lib/agents/store.ts updateAgentForUser). Opt-in, like the other DB tests:
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_orbit_test \
 *     NODE_OPTIONS=--conditions=react-server npx tsx --test tests/agent-routine-follows-agent.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ORBIT_TEST_DATABASE_URL;

test("tightening an agent's approvals and apps reaches its existing routines", { skip: !url }, async () => {
  assert.match(url!, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "agent-routine-follows-agent-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const store = await import("../src/lib/agents/store");
  const { agentApprovalMode } = await import("../src/lib/agents/domain");

  const owner = `routine-${randomUUID()}`;
  try {
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
    await db.subscription.create({ data: { userId: owner, plan: "PRO", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
    const created = await db.agent.create({
      data: { userId: owner, name: "Night owl", role: "Assistant", instructions: "Summarise the day.", approvalMode: "permissive" },
    });
    const agent = (await store.findAgent(owner, created.id))!;
    const routine = await store.createAgentRoutine({ id: owner }, agent, {
      name: "Nightly summary",
      instructions: "Summarise today's mail.",
      cadence: "daily",
      hour: 22,
      minute: 0,
      timezone: "UTC",
    });
    assert.ok(routine.status < 300, JSON.stringify(routine.body));
    const schedule = await db.workSchedule.findFirstOrThrow({ where: { userId: owner, session: { agentId: agent.id } } });
    const before = await db.workSession.findFirstOrThrow({ where: { id: schedule.sessionId } });
    assert.deepEqual(before.permissionPolicy, agentApprovalMode("permissive"));

    const updated = await store.updateAgentForUser({ id: owner }, agent.id, { approvalMode: "conservative", connectorIds: [] });
    assert.ok(updated.status < 300, JSON.stringify(updated.body));
    const after = await db.workSession.findFirstOrThrow({ where: { id: schedule.sessionId } });
    assert.deepEqual(after.permissionPolicy, agentApprovalMode("conservative"), "the routine runs under the tightened approvals");
    assert.equal(await db.workSessionConnector.count({ where: { sessionId: schedule.sessionId } }), 0, "and with the apps the agent still has");

    // Paused for days, then resumed: the next run starts from now, not the missed slot.
    const fresh = (await store.findAgent(owner, agent.id))!;
    assert.ok((await store.updateAgentRoutine({ id: owner }, fresh, schedule.id, false)).status < 300);
    await db.workSchedule.update({ where: { id: schedule.id }, data: { nextRunAt: new Date(Date.now() - 3 * 86_400_000) } });
    assert.ok((await store.updateAgentRoutine({ id: owner }, fresh, schedule.id, true)).status < 300);
    const resumed = await db.workSchedule.findFirstOrThrow({ where: { id: schedule.id } });
    assert.equal(resumed.enabled, true);
    assert.ok(resumed.nextRunAt && resumed.nextRunAt.getTime() > Date.now(), `next run ${resumed.nextRunAt?.toISOString()} is in the future`);
  } finally {
    await db.user.delete({ where: { id: owner } }).catch(() => undefined);
    await db.$disconnect();
  }
});
