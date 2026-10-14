/**
 * The sweeper's conditional writes on the real AgentComputer table
 * (src/lib/computer/store.ts, prisma persistence). Opt-in, like the other DB tests:
 *
 *   COMPUTER_TEST_DATABASE_URL=postgresql://…/juno_computer_test \
 *     npx tsx --test tests/agent-computer-sweep.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.COMPUTER_TEST_DATABASE_URL;

test("sweeper writes on Postgres: a renewed lease and a changed row are left alone", { skip: !url }, async () => {
  assert.match(url!, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const { getComputerStorePersistence } = await import("../src/lib/computer/store");
  const store = getComputerStorePersistence();

  const userId = `computer_${randomUUID()}`;
  await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
  try {
    const agent = await db.agent.create({ data: { userId, name: "Sweep", role: "Tester", instructions: "Tests the sweep." } });
    const t0 = new Date("2026-10-14T12:00:00Z");
    const expired = new Date(t0.getTime() - 1_000);
    await db.agentComputer.create({
      data: { userId, agentId: agent.id, provider: "fake", status: "awake", leaseRunId: "run_a", leaseExpiresAt: expired },
    });

    // The run renews between the sweep's read and its clear: the clear must not apply.
    await store.renewLeaseCas(userId, agent.id, "run_a", t0, new Date(t0.getTime() + 120_000));
    assert.equal(await store.clearExpiredLeaseCas(userId, agent.id, "run_a", t0), false);
    assert.equal((await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } })).leaseRunId, "run_a");
    // Another run's id never clears this lease, and a truly expired one is cleared once.
    const later = new Date(t0.getTime() + 121_000);
    assert.equal(await store.clearExpiredLeaseCas(userId, agent.id, "run_b", later), false);
    assert.equal(await store.clearExpiredLeaseCas(userId, agent.id, "run_a", later), true);
    assert.equal(await store.clearExpiredLeaseCas(userId, agent.id, "run_a", later), false);

    // Reconcile applies only to the row as read.
    const read = await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } });
    await store.acquireLeaseCas(userId, agent.id, "run_c", later, new Date(later.getTime() + 120_000));
    assert.equal(await store.reconcileStoppedCas(userId, agent.id, { status: "awake", updatedAt: read.updatedAt }), false);
    const now = await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } });
    assert.equal(now.leaseRunId, "run_c", "a wake that raced the sweep keeps its lease");
    assert.equal(await store.reconcileStoppedCas(userId, agent.id, { status: "awake", updatedAt: now.updatedAt }), true);
    assert.equal((await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } })).status, "asleep");
    // The orphan check sees every row, whatever its status.
    assert.ok((await store.listAgentIdsUnguarded()).has(agent.id));
    // Another account cannot act on this computer.
    assert.equal(await store.clearExpiredLeaseCas("someone_else", agent.id, "run_c", later), false);
  } finally {
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    await db.$disconnect();
  }
});
