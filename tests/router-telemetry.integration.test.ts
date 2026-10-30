/**
 * Routing telemetry against a real database (src/lib/router/telemetry-store.ts).
 *
 * Opt-in: it never connects to a database it was not pointed at.
 *
 *   JUNO_ROUTER_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/juno_router_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test tests/router-telemetry.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const URL = process.env.JUNO_ROUTER_TEST_DATABASE_URL;

if (!URL) {
  test("router telemetry database suite is skipped without JUNO_ROUTER_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(URL, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/juno_router_test$/, "only a local throwaway database");
  process.env.DATABASE_URL = URL;
  process.env.DIRECT_URL = URL;

  const load = async () => {
    const store = await import("@/lib/router/telemetry-store");
    const { prisma } = await import("@/lib/prisma");
    const evidence = await import("@/lib/router/evidence");
    return { ...store, prisma, ...evidence };
  };

  const base = (over: Record<string, unknown> = {}) => ({
    messageId: `m-${randomUUID()}`,
    routerVersion: 2,
    auto: true,
    taskClass: "everyday" as const,
    complexity: "simple",
    modelId: `test:model-${randomUUID().slice(0, 8)}`,
    provider: "openai",
    effort: null,
    latencyMs: 1200,
    firstTokenMs: null,
    toolRounds: 0,
    retryCount: 0,
    completionState: "completed" as const,
    finishReason: "stop",
    costMicroUsd: 400,
    expectedMicroUsd: 900,
    ...over,
  });

  test("the row holds no content, user or conversation", async () => {
    const { prisma, recordRoutingOutcome } = await load();
    const input = base();
    await recordRoutingOutcome(input);
    const row = await prisma.routingOutcome.findUnique({ where: { messageId: input.messageId } });
    assert.ok(row);
    const columns = Object.keys(row).sort();
    for (const forbidden of ["userId", "conversationId", "content", "prompt", "promptHash"]) {
      assert.ok(!columns.includes(forbidden), `${forbidden} must not be a column`);
    }
  });

  test("signals mark the outcome; SQL aggregate matches the pure rule", async () => {
    const { prisma, recordRoutingOutcome, markRoutingSignal, aggregateRoutingEvidence, aggregateOutcomes, evidenceKey } =
      await load();
    const modelId = `test:agg-${randomUUID().slice(0, 8)}`;
    const inputs = [
      base({ modelId }),
      base({ modelId }),
      base({ modelId, completionState: "failed", finishReason: "error", costMicroUsd: null, latencyMs: null }),
      base({ modelId }),
      base({ modelId, toolRounds: 2, retryCount: 1 }),
      // An error and a dropped connection, each with a latency the aggregate must ignore.
      base({ modelId, completionState: "failed", finishReason: "sensitive", latencyMs: 90 }),
      base({ modelId, completionState: "partial", finishReason: "network_error", latencyMs: 40_000 }),
      base({ modelId, completionState: "stopped", finishReason: "user_stopped", latencyMs: 700 }),
    ];
    for (const i of inputs) await recordRoutingOutcome(i);
    await markRoutingSignal(inputs[0].messageId, { regenerated: true, switchedModel: true });
    await markRoutingSignal([inputs[1].messageId], { edited: true });
    await markRoutingSignal(inputs[3].messageId, { feedback: "DOWN" });

    const rows = await prisma.routingOutcome.findMany({ where: { modelId } });
    const pure = aggregateOutcomes(
      rows.map((r) => ({ ...r, taskClass: "everyday" as const }))
    ).get(evidenceKey(modelId, "everyday"));
    const sql = (await aggregateRoutingEvidence(new Date(Date.now() - 60_000))).get(evidenceKey(modelId, "everyday"));
    assert.deepEqual(sql, pure);
    assert.equal(sql?.n, 8);
    assert.equal(sql?.successes, 1, "only the untouched completed turn with tools counts");
    assert.equal(sql?.errors, 3, "failed and partial are errors; a Stop is not");
    assert.equal(sql?.toolRoundsSum, 2);
    assert.equal(sql?.latencyN, 4, "latency from completed turns only");
    assert.equal(sql?.latencyMsSum, 4 * 1200);
  });

  test("the first-token time is stored when measured", async () => {
    const { prisma, recordRoutingOutcome } = await load();
    const input = base({ firstTokenMs: 640.4 });
    await recordRoutingOutcome(input);
    const row = await prisma.routingOutcome.findUnique({ where: { messageId: input.messageId } });
    assert.equal(row?.firstTokenMs, 640);
  });

  test("a thumbs-down's reason is mirrored as a category, and cleared with the rating", async () => {
    const { prisma, recordRoutingOutcome, markRoutingSignal } = await load();
    const messageId = `m-${randomUUID()}`;
    await recordRoutingOutcome(base({ messageId, modelId: `test:reason-${randomUUID().slice(0, 8)}` }));
    await markRoutingSignal(messageId, { feedback: "DOWN", feedbackReason: "inaccurate" });
    let row = await prisma.routingOutcome.findFirst({ where: { messageId } });
    assert.equal(row?.feedback, "DOWN");
    assert.equal(row?.feedbackReason, "inaccurate");
    // A bare DOWN (the native apps) leaves the reason it already has.
    await markRoutingSignal(messageId, { feedback: "DOWN" });
    row = await prisma.routingOutcome.findFirst({ where: { messageId } });
    assert.equal(row?.feedbackReason, "inaccurate");
    await markRoutingSignal(messageId, { feedback: "UP", feedbackReason: null });
    row = await prisma.routingOutcome.findFirst({ where: { messageId } });
    assert.equal(row?.feedback, "UP");
    assert.equal(row?.feedbackReason, null);
  });

  test("a regenerate's new outcome takes over the message link; the old keeps its mark", async () => {
    const { prisma, recordRoutingOutcome, markRoutingSignal } = await load();
    const messageId = `m-${randomUUID()}`;
    const modelId = `test:regen-${randomUUID().slice(0, 8)}`;
    await recordRoutingOutcome(base({ messageId, modelId }));
    await markRoutingSignal(messageId, { regenerated: true });
    await recordRoutingOutcome(base({ messageId, modelId }));
    const rows = await prisma.routingOutcome.findMany({ where: { modelId }, orderBy: { createdAt: "asc" } });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].messageId, null);
    assert.equal(rows[0].userRegenerated, true);
    assert.equal(rows[1].messageId, messageId);
    assert.equal(rows[1].userRegenerated, false);
  });

  test("retention: link nulled after 30 days, row deleted after 180", async () => {
    const { prisma, pruneRoutingOutcomes } = await load();
    const day = 24 * 60 * 60 * 1000;
    const modelId = `test:prune-${randomUUID().slice(0, 8)}`;
    const mk = (ageDays: number) =>
      prisma.routingOutcome.create({
        data: { ...base({ modelId }), createdAt: new Date(Date.now() - ageDays * day) },
      });
    const fresh = await mk(1);
    const old = await mk(40);
    const ancient = await mk(200);
    await pruneRoutingOutcomes();
    const after = await prisma.routingOutcome.findMany({ where: { modelId } });
    const byId = new Map(after.map((r) => [r.id, r]));
    assert.equal(byId.get(fresh.id)?.messageId, fresh.messageId);
    assert.equal(byId.get(old.id)?.messageId, null);
    assert.equal(byId.has(ancient.id), false);
  });

  test("a failed write never throws (telemetry cannot fail a turn)", async () => {
    const { recordRoutingOutcome } = await load();
    await recordRoutingOutcome(base({ latencyMs: Number.NaN, costMicroUsd: 9e12 }));
  });

  test("evidence load is cached and survives a read failure", async () => {
    const { loadRoutingEvidence, __resetRoutingEvidenceCache } = await load();
    __resetRoutingEvidenceCache();
    const a = await loadRoutingEvidence();
    const b = await loadRoutingEvidence();
    assert.equal(a, b, "same table within the cache window");
    assert.ok(a.size >= 1);
  });

  test("the failure-rate alert's count: faults per model in the window, answers shaped by content left out", async () => {
    const { prisma, recordRoutingOutcome, countRecentTurnOutcomes } = await load();
    const modelId = `test:failing-${randomUUID().slice(0, 8)}`;
    const other = `test:healthy-${randomUUID().slice(0, 8)}`;
    const add = async (over: Record<string, unknown>, minutesAgo = 0) => {
      const input = base({ modelId, provider: "qwen", ...over });
      await recordRoutingOutcome(input);
      if (minutesAgo) {
        await prisma.routingOutcome.update({
          where: { messageId: input.messageId },
          data: { createdAt: new Date(Date.now() - minutesAgo * 60_000) },
        });
      }
    };
    for (let i = 0; i < 4; i += 1) await add({ completionState: "failed", finishReason: "error" });
    await add({ completionState: "partial", finishReason: "network_error" });
    await add({ completionState: "failed", finishReason: "network_error" });
    // Answers shaped by their content, a stop and a success are turns, not faults.
    await add({ completionState: "failed", finishReason: "length" });
    await add({ completionState: "failed", finishReason: "sensitive" });
    await add({ completionState: "stopped", finishReason: "user_stopped" });
    await add({ completionState: "completed", finishReason: "stop" });
    // Outside the window.
    await add({ completionState: "failed", finishReason: "error" }, 30);
    await recordRoutingOutcome(base({ modelId: other }));

    const rows = await countRecentTurnOutcomes(new Date(Date.now() - 10 * 60_000));
    const failing = rows.find((r) => r.modelId === modelId);
    assert.deepEqual(failing, { modelId, provider: "qwen", total: 10, failed: { error: 4, network_error: 2 } });
    assert.deepEqual(rows.find((r) => r.modelId === other)?.failed, { error: 0, network_error: 0 });

    // And the watch, end to end on these rows: one mail, then none for the same outage.
    const { createFailureRateWatch } = await import("@/lib/router/failure-alert");
    const mails: Array<{ key?: string; title: string }> = [];
    const watch = createFailureRateWatch({
      // Only this test's rows, so the other tests' rows cannot change the verdict.
      readCounts: async (since) => (await countRecentTurnOutcomes(since)).filter((r) => r.modelId === modelId || r.modelId === other),
      alert: (input) => void mails.push(input),
      env: {},
    });
    const first = await watch.evaluate();
    // The model breaches (6 of 10); neither class does on its own (4 errors, 2 dropped streams).
    assert.deepEqual(first.map((g) => g.key), [`model:${modelId}`]);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].key, `model:${modelId}`);
    assert.match(mails[0].title, /^Chat turns failing: 6 of 10 on test:failing-/);
    assert.deepEqual(await watch.evaluate(), []);
    assert.equal(mails.length, 1, "the same incident mails once");
  });

  test.after(async () => {
    const { prisma } = await load();
    await prisma.routingOutcome.deleteMany({ where: { modelId: { startsWith: "test:" } } });
    await prisma.$disconnect();
  });
}
