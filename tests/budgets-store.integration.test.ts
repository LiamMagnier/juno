/**
 * The budget lines' database reads (src/lib/budgets-store.ts) against a real
 * database: a routine's spend this billing period, and an agent's weekly line.
 *
 *   JUNO_ROUTER_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/juno_router_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test tests/budgets-store.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const URL = process.env.JUNO_ROUTER_TEST_DATABASE_URL;

if (!URL) {
  test("budgets store database suite is skipped without JUNO_ROUTER_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(URL, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/juno_router_test$/, "only a local throwaway database");
  process.env.DATABASE_URL = URL;
  process.env.DIRECT_URL = URL;

  const owner = `budget-test-${randomUUID()}`;

  test("routine spend sums its runs in the billing period; agent line counts its tasks this week", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { routineSpendThisPeriod, agentBudgetLineFor } = await import("@/lib/budgets-store");
    const { describeBudgetLine } = await import("@/lib/budgets");
    await prisma.user.create({ data: { id: owner, email: `${owner}@example.invalid`, emailVerified: new Date() } });
    try {
      const conversation = await prisma.conversation.create({ data: { userId: owner, title: "Scout", kind: "chat" } });
      const agent = await prisma.agent.create({
        data: { userId: owner, name: "Scout", conversationId: conversation.id, approvalMode: "balanced", budgetMicroUsd: 5_000_000 },
      });
      const session = await prisma.workSession.create({
        data: { userId: owner, agentId: agent.id, title: "Brief", goal: "Do it.", status: "completed", permissionPolicy: "permissive" },
      });
      const schedule = await prisma.workSchedule.create({
        data: { userId: owner, sessionId: session.id, name: "Morning brief", instructions: "Brief me." },
      });
      const other = await prisma.workSchedule.create({
        data: { userId: owner, sessionId: session.id, name: "Unused", instructions: "-" },
      });
      for (const [cost, attempt] of [[1_250_000, 1], [750_000, 2]] as const) {
        await prisma.workRun.create({
          data: { sessionId: session.id, userId: owner, scheduleId: schedule.id, status: "completed", costMicroUsd: cost, attempt },
        });
      }
      const spent = await routineSpendThisPeriod(owner, [schedule.id, other.id]);
      assert.equal(spent.get(schedule.id), 2_000_000);
      assert.equal(spent.get(other.id), 0);

      const line = await agentBudgetLineFor(owner, { id: agent.id, name: "Scout", budgetMicroUsd: 5_000_000 });
      assert.equal(line.scope, "agent");
      assert.equal(line.spentMicroUsd, 2_000_000);
      assert.equal(describeBudgetLine(line), "$2.00 of $5.00 this week");
    } finally {
      await prisma.user.deleteMany({ where: { id: owner } });
      await prisma.$disconnect();
    }
  });
}
