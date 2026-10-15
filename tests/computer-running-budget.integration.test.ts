/** Real Postgres lifecycle; deterministic account-window and spend-write results.
 * COMPUTER_TEST_DATABASE_URL=…/juno_budget_test NODE_OPTIONS=--conditions=react-server
 * npx tsx --test --experimental-test-module-mocks tests/computer-running-budget.integration.test.ts
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.COMPUTER_TEST_DATABASE_URL;
if (!url) {
  test("running computer budget requires a throwaway database", { skip: true }, () => {});
} else {
  assert.match(url, /\/juno_[a-z_]*test$/);
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "computer-running-budget-integration-test";
  process.env.AGENT_COMPUTER_PROVIDER = "fake";
  process.env.AGENT_COMPUTER_COST_USD_PER_MIN = "0.06";
  let limit = Infinity;
  let recording = true;
  const charges: Array<{ costUsd: number; idempotencyKey: string }> = [];
  mock.module("@/lib/usage", { namedExports: { getUserPlan: async () => "PRO" } });
  mock.module("@/lib/spend", { namedExports: {
    checkUsageWindows: async (_user: string, _plan: unknown, _unused: unknown, _reserved: unknown, options?: { pendingMicroUsd?: number }) => ({
      allowed: (options?.pendingMicroUsd ?? 0) < limit, bound: "weekly", resetsAtMs: Date.now() + 60_000,
    }),
    recordSpend: async (charge: { costUsd: number; idempotencyKey: string }) => { charges.push(charge); return recording; },
  } });

  test("running and viewed computers stop at the window; failed spend retains a retryable interval", async () => {
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const store = await import("../src/lib/computer/store");
    const { sweepAgentComputers } = await import("../src/lib/computer/sweep");
    const { fakeComputerProvider: provider } = await import("../src/lib/computer/fake");
    const userId = `budget_${randomUUID()}`;
    try {
      await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
      const agent = await db.agent.create({ data: { userId, name: "Budget", role: "Tester", instructions: "Tests budgets." } });
      const awake = await store.ensureAwake(userId, agent.id, { autoEnable: true });
      const now = new Date();
      const since = new Date(now.getTime() - 60_000);
      await db.agentComputer.update({ where: { agentId: agent.id }, data: { lastResumedAt: since } });
      await store.acquireComputerLease(userId, agent.id, "new-run");
      limit = 1000;
      assert.equal(await store.renewComputerLease(userId, agent.id, "stale-run", 120_000, now), false);
      assert.equal(await provider.state(awake.handle), "running", "a stale run cannot stop the current owner");
      assert.equal(await store.renewComputerLease(userId, agent.id, "new-run", 120_000, now), false);
      let row = await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } });
      assert.equal(row.status, "asleep");
      assert.equal(row.leaseRunId, null);
      assert.equal(charges.at(-1)?.costUsd, 0.06);
      assert.match(row.lastError ?? "", /weekly/i);

      limit = Infinity;
      await store.ensureAwake(userId, agent.id);
      await db.agentComputer.update({ where: { agentId: agent.id }, data: { lastResumedAt: since } });
      recording = false;
      await assert.rejects(store.settleRunComputerBilling(userId, agent.id, "run", now), /could not be recorded/);
      assert.equal((await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } })).lastResumedAt?.getTime(), since.getTime());
      await assert.rejects(store.sleepComputer(userId, agent.id, { now }), /could not be recorded/);
      row = await db.agentComputer.findUniqueOrThrow({ where: { agentId: agent.id } });
      assert.equal(row.billingStoppedAt?.getTime(), now.getTime());
      const failedCharge = charges.at(-1);
      recording = true;
      await store.sleepComputer(userId, agent.id, { now: new Date(now.getTime() + 3_600_000) });
      assert.deepEqual(charges.at(-1), failedCharge, "retry neither loses the charge nor bills the stopped hour");

      await store.ensureAwake(userId, agent.id);
      await db.agentComputer.update({ where: { agentId: agent.id }, data: { lastResumedAt: since } });
      limit = 1000;
      assert.ok((await sweepAgentComputers({ now })).slept.includes(agent.id), "the sweep also covers computers with no run heartbeat");
    } finally {
      await db.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.$disconnect();
    }
  });
}
