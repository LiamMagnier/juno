/** Real spend/member ledgers and reflection admission, with no provider calls.
 * ORBIT_TEST_DATABASE_URL=…/juno_reflection_test NODE_OPTIONS=--conditions=react-server
 * npx tsx --test --experimental-test-module-mocks tests/agent-reflection-budget.integration.test.ts
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ORBIT_TEST_DATABASE_URL;
if (!url) {
  test("reflection budget requires a throwaway database", { skip: true }, () => {});
} else {
  assert.match(url, /\/juno_[a-z_]*test$/);
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "reflection-budget-test-key";
  mock.module("@/lib/usage", { namedExports: { getUserPlan: async () => "PRO" } });

  test("reflection utility spend belongs to the member; every origin checks its cap before claiming", async () => {
    const actualSpend = await import("../src/lib/spend");
    let inWindow = true;
    const now = new Date();
    const since = new Date(now.getTime() - 86_400_000);
    mock.module("@/lib/spend", { namedExports: { ...actualSpend,
      checkUsageWindows: async () => ({ allowed: inWindow, weekly: { startMs: since.getTime(), resetsAtMs: now.getTime() + 86_400_000 } }),
    } });
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const { reflectAgent } = await import("../src/lib/agents/reflect");
    const { memberSpendMicroUsd } = await import("../src/lib/agents/budget-store");
    const owner = `reflection_${randomUUID()}`;
    try {
      await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
      const agent = await db.agent.create({ data: { userId: owner, name: "Reflection", role: "Tester", instructions: "Tests reflections.", budgetMicroUsd: 1000, proactive: true } });
      const session = await db.workSession.create({ data: { userId: owner, agentId: agent.id, title: "Work", goal: "Test" } });
      const run = await db.workRun.create({ data: { userId: owner, sessionId: session.id, costMicroUsd: 400 } });
      const charge = { userId: owner, agentId: agent.id, model: "test-utility", kind: "utility" as const, costUsd: 0.0006, idempotencyKey: "reflection-test" };
      assert.equal(await actualSpend.recordSpend(charge), true);
      assert.equal(await actualSpend.recordSpend(charge), true);
      await db.apiSpend.create({ data: { userId: owner, model: "test", kind: "utility", costMicroUsd: 9000 } });
      await db.apiSpend.create({ data: { userId: owner, agentId: "another-agent", model: "test", kind: "utility", costMicroUsd: 9000 } });
      assert.equal(await memberSpendMicroUsd({ userId: owner, agentId: agent.id, since }), 1000);
      assert.equal(await memberSpendMicroUsd({ userId: owner, agentId: agent.id, since, excludeRunId: run.id }), 600);

      let calls = 0;
      let owningAgentId: string | undefined;
      const llm: import("../src/lib/memory").UtilityLlm = async (options) => {
        calls++;
        owningAgentId = options.agentId;
        return '{"ideas":[],"checkIns":[],"notes":[]}';
      };
      for (const origin of ["page", "button", "sweep"] as const) {
        assert.deepEqual(await reflectAgent({ id: owner }, agent.id, { force: true, origin, llm, now }), { kind: "skipped", reason: "budget" });
        assert.equal((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).lastReflectedAt, null);
      }
      assert.equal(calls, 0);
      await db.agent.update({ where: { id: agent.id }, data: { budgetMicroUsd: 2000 } });
      inWindow = false;
      assert.deepEqual(await reflectAgent({ id: owner }, agent.id, { force: true, llm, now }), { kind: "skipped", reason: "budget" });
      inWindow = true;
      assert.equal((await reflectAgent({ id: owner }, agent.id, { force: true, llm, now })).kind, "reflected");
      assert.equal(calls, 1);
      assert.equal(owningAgentId, agent.id, "utility billing retains the owning agent");
    } finally {
      await db.user.delete({ where: { id: owner } }).catch(() => undefined);
      await db.$disconnect();
    }
  });
}
