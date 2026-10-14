/**
 * Code starts are admitted like Work runs (src/lib/code-admission.ts): the
 * usage window, then the owning agent's budget. Opt-in, like the other DB tests:
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_orbit_test \
 *     NODE_OPTIONS=--conditions=react-server npx tsx --test tests/code-admission.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ORBIT_TEST_DATABASE_URL;

test("a Code routine of an agent over its budget is refused before anything is created", { skip: !url }, async () => {
  assert.match(url!, /\/[a-z_]*test$/, "only a throwaway *test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "code-admission-integration-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const store = await import("../src/lib/work/store");
  const { startCodeRoutineRun } = await import("../src/lib/work/code-dispatch");

  const owner = `code-admit-${randomUUID()}`;
  try {
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
    await db.subscription.create({ data: { userId: owner, plan: "PRO", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
    // An agent with a $0.0001 weekly cap that has already spent $1 this week.
    const agent = await db.agent.create({
      data: { userId: owner, name: "Fixer", role: "Engineer", instructions: "Fix CI.", budgetMicroUsd: 100 },
    });
    const session = await store.createWorkSession({ userId: owner, title: "Fix CI", goal: "Fix CI", requestedTarget: "cloud" });
    await db.workSession.update({ where: { id: session.id }, data: { agentId: agent.id } });
    const spent = await store.createRun({
      sessionId: session.id, userId: owner, requestedTarget: "cloud", effectiveTarget: "cloud", effectiveModel: "test-model",
      budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false,
    });
    await db.workRun.update({ where: { id: spent.run.id }, data: { costMicroUsd: 1_000_000 } });
    const schedule = await db.workSchedule.create({
      data: { userId: owner, sessionId: session.id, name: "Nightly fix", instructions: "Fix CI", runKind: "code", codeConfig: { repo: { owner: "juno", name: "juno" } } },
    });

    const outcome = await startCodeRoutineRun({
      scheduleId: schedule.id,
      userId: owner,
      name: schedule.name,
      instructions: schedule.instructions,
      timezone: "UTC",
      codeConfig: { repo: { owner: "juno", name: "juno" } },
      fireAt: new Date(),
      fireText: null,
      idempotencyKey: `test:${randomUUID()}`,
    });
    assert.equal(outcome.outcome, "refused");
    assert.equal(outcome.outcome === "refused" && outcome.reason, "member_budget_exhausted");
    assert.equal(await db.codeTask.count({ where: { userId: owner } }), 0, "no task row");
    assert.equal(await db.conversation.count({ where: { userId: owner, kind: "code" } }), 0, "no Code session");

    // Without the agent's cap in the way, admission passes and the next check speaks.
    await db.workSession.update({ where: { id: session.id }, data: { agentId: null } });
    const next = await startCodeRoutineRun({
      scheduleId: schedule.id, userId: owner, name: schedule.name, instructions: schedule.instructions, timezone: "UTC",
      codeConfig: { repo: { owner: "juno", name: "juno" } }, fireAt: new Date(), fireText: null, idempotencyKey: `test:${randomUUID()}`,
    });
    assert.equal(next.outcome === "refused" && next.reason, "github_not_connected");
  } finally {
    await db.user.delete({ where: { id: owner } }).catch(() => undefined);
    await db.$disconnect();
  }
});
