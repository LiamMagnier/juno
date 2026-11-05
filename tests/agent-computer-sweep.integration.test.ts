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

test("Postgres creation claim: concurrent enables share credentials and stale creators cannot publish", { skip: !url }, async () => {
  assert.match(url!, /\/juno_[a-z_]*test$/);
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "computer-creation-integration-test-key";
  process.env.AGENT_COMPUTER_PROVIDER = "fake";
  // Computers for every plan that includes them (src/lib/computer/access.ts);
  // the account below is an owner's (OWNER_EMAILS), so its plan includes one.
  process.env.AGENT_COMPUTER_ROLLOUT = "plans";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const computer = await import("../src/lib/computer/store");
  const { resetComputerProviderCache } = await import("../src/lib/computer/provider");
  const { fakeComputerProvider } = await import("../src/lib/computer/fake");
  resetComputerProviderCache();
  fakeComputerProvider.reset();
  const userId = `creation_${randomUUID()}`;
  const savedOwners = process.env.OWNER_EMAILS;
  process.env.OWNER_EMAILS = `${userId}@example.invalid`;
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
    const agent = await db.agent.create({ data: { userId, name: "Creation", role: "Tester", instructions: "Tests creation." } });
    const results = await Promise.all(Array.from({ length: 4 }, () => computer.enableComputer(userId, agent.id)));
    assert.equal(fakeComputerProvider.calls.filter((call) => call.method === "create").length, 1);
    assert.equal(new Set(results.map((row) => computer.decodeSecrets(row.secrets).cdpToken)).size, 1);
    const persistence = computer.getComputerStorePersistence();
    const now = new Date();
    const later = new Date(now.getTime() + 1000);
    assert.equal(await persistence.claimCreation(userId, agent.id, "old", now, later), true);
    assert.equal(await persistence.claimCreation(userId, agent.id, "other", now, later), false);
    assert.equal(await persistence.claimCreation("wrong-owner", agent.id, "other", later, later), false);
    assert.equal(await persistence.claimCreation(userId, agent.id, "replacement", new Date(later.getTime() + 1), new Date(later.getTime() + 1000)), true);
    assert.equal(await persistence.finishCreation(userId, agent.id, "old", { secrets: "stale" }), false);
    assert.equal(await persistence.finishCreation(userId, agent.id, "replacement", {}), true);
    assert.equal((await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } })).secrets, results[0].secrets);
  } finally {
    delete process.env.AGENT_COMPUTER_PROVIDER;
    if (savedOwners === undefined) delete process.env.OWNER_EMAILS;
    else process.env.OWNER_EMAILS = savedOwners;
    resetComputerProviderCache();
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    await db.$disconnect();
  }
});

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

    // A held sleep is claimed once, and only while it still holds the end and interval that were read
    // (S3: the sweep and a wake both finish held sleeps).
    const end = new Date(t0.getTime() - 60_000);
    const resumed = new Date(t0.getTime() - 360_000);
    await db.agentComputer.update({
      where: { agentId: agent.id },
      data: { status: "stopping", billingStoppedAt: end, lastResumedAt: resumed, activeSeconds: 10 },
    });
    assert.equal(await store.claimHeldSleepCas(userId, agent.id, { billingStoppedAt: end, lastResumedAt: null }, 310), false);
    assert.equal(await store.claimHeldSleepCas("someone_else", agent.id, { billingStoppedAt: end, lastResumedAt: resumed }, 310), false);
    assert.equal(await store.claimHeldSleepCas(userId, agent.id, { billingStoppedAt: end, lastResumedAt: resumed }, 310), true);
    const claimed = await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } });
    assert.deepEqual(
      [claimed.status, claimed.billingStoppedAt, claimed.lastResumedAt, claimed.activeSeconds],
      ["stopping", null, null, 310],
    );
    assert.equal(await store.claimHeldSleepCas(userId, agent.id, { billingStoppedAt: end, lastResumedAt: resumed }, 310), false, "once");
    // An interval already closed (lastResumedAt null) is claimed on the end alone.
    await db.agentComputer.update({ where: { agentId: agent.id }, data: { billingStoppedAt: end } });
    assert.equal(await store.claimHeldSleepCas(userId, agent.id, { billingStoppedAt: end, lastResumedAt: null }, 310), true);
  } finally {
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    await db.$disconnect();
  }
});

test("awake caps on Postgres: two wakes at once cannot both take the last slot", { skip: !url }, async () => {
  assert.match(url!, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const { getComputerStorePersistence } = await import("../src/lib/computer/store");
  const store = getComputerStorePersistence();
  const userId = `computer_caps_${randomUUID()}`;
  await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
  try {
    const agents = await Promise.all(
      ["on", "b", "c"].map((name) => db.agent.create({ data: { userId, name, role: "Tester", instructions: "Tests caps." } })),
    );
    await db.agentComputer.createMany({
      data: agents.map((agent, i) => ({ userId, agentId: agent.id, provider: "fake", status: i === 0 ? "awake" : "asleep" })),
    });
    // Separate connection pools stand in for two backend processes.
    const { PrismaClient } = await import("@prisma/client");
    const other = new PrismaClient({ datasourceUrl: url });
    try {
      const caps = { user: 2, host: 100 };
      const verdicts = await Promise.all([
        store.claimAwakeSlot(userId, agents[1].id, caps),
        store.claimAwakeSlot(userId, agents[2].id, caps),
        // A third racer straight through another pool, the same statement shape.
        other.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('juno.agent-computer.awake-caps'))::text`);
          return tx.agentComputer.count({ where: { userId, status: { in: ["awake", "starting", "resting", "stopping"] } } });
        }),
      ]);
      assert.deepEqual([verdicts[0], verdicts[1]].sort(), ["ok", "user"]);
      assert.equal(await db.agentComputer.count({ where: { userId, status: { in: ["awake", "starting"] } } }), 2);
    } finally {
      await other.$disconnect();
    }
  } finally {
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    await db.$disconnect();
  }
});
