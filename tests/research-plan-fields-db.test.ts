/**
 * The research driver records billed queries without rewriting the whole plan
 * (src/lib/research/run.ts saveIssuedQueries). Opt-in, like the other DB tests:
 *
 *   RESEARCH_TEST_DATABASE_URL=postgresql://…/juno_research_test \
 *     NODE_OPTIONS=--conditions=react-server npx tsx --test tests/research-plan-fields-db.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.RESEARCH_TEST_DATABASE_URL;

test("recording issued queries keeps steering a person saved in between", { skip: !url }, async () => {
  assert.match(url!, /\/[a-z_]*test$/, "only a throwaway *test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "research-plan-fields-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const { createPrismaResearchStore } = await import("../src/lib/research/run");
  const store = createPrismaResearchStore();
  const ownerId = `research-${randomUUID()}`;
  try {
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@example.invalid` } });
    const run = await db.researchRun.create({ data: { userId: ownerId, goal: "Compare two tools", state: "investigating", plan: { objectives: [], issuedQueries: ["first"] } } });
    // The driver loaded the plan, then the person queued guidance...
    const loaded = (await store.loadRun(run.id, ownerId))!;
    const plan = loaded.plan as Record<string, unknown>;
    await store.savePlan({ runId: run.id, userId: ownerId, plan: { ...(plan as never), steering: [{ id: "s1", text: "Focus on pricing" }] } as never });
    // ...and the driver records its next billed query.
    await store.saveIssuedQueries!({ runId: run.id, userId: ownerId, issuedQueries: ["first", "second"] });
    const saved = (await db.researchRun.findUniqueOrThrow({ where: { id: run.id } })).plan as Record<string, unknown>;
    assert.deepEqual(saved.issuedQueries, ["first", "second"]);
    assert.deepEqual(saved.steering, [{ id: "s1", text: "Focus on pricing" }], "the person's steering survives");
    // Another account's run is never written.
    await store.saveIssuedQueries!({ runId: run.id, userId: "someone-else", issuedQueries: [] });
    assert.deepEqual(((await db.researchRun.findUniqueOrThrow({ where: { id: run.id } })).plan as Record<string, unknown>).issuedQueries, ["first", "second"]);
  } finally {
    await db.user.delete({ where: { id: ownerId } }).catch(() => undefined);
    await db.$disconnect();
  }
});
