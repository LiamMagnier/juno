import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { buildUsage } from "@/lib/chat-usage";
import { MODELS } from "@/lib/models";
import { estimateGenerationCostUsd } from "@/lib/pricing";
import { estimateTurnCostUsd } from "@/lib/turn-pricing";
import type { RecordSpendInput } from "@/lib/spend";

// Exercise the actual ledger boundary without loading Prisma or a provider.
// Run with --experimental-test-module-mocks and --conditions=react-server.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const boundaryTest = canMockModules ? test : test.skip;
const writes: RecordSpendInput[] = [];
if (canMockModules) {
  mock.module("@/lib/spend", {
    namedExports: {
      recordSpend: async (input: RecordSpendInput) => {
        writes.push(input);
        return true;
      },
    },
  });
}

boundaryTest("the chat ledger receives explicit zero fresh input and the same cache price as the receipt", async () => {
  writes.length = 0;
  const { recordTurnSpend } = await import("@/lib/chat/turn/spend");
  const model = MODELS["anthropic:claude-sonnet-5"];
  const acc = new GenerationAccumulator();
  acc.apply({ type: "usage", input: 0, output: 100, cacheRead: 90_000 });
  const usage = buildUsage(model, acc.rawUsage({ promptChars: 360_000 }));
  const written = await recordTurnSpend({
    userId: "account-test",
    modelId: model.id,
    source: "web",
    generationId: "generation-test",
    usage,
    acc,
    promptChars: 360_000,
    completionChars: 0,
  });
  assert.equal(written, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].promptTokens, 0, "the ledger must not turn an observed zero into missing usage");
  assert.equal(writes[0].cacheRead, 90_000);
  const ledger = estimateGenerationCostUsd(model, writes[0]);
  assert.equal(ledger.promptTokens, 0);
  assert.equal(ledger.costUsd, usage.cost);
  assert.equal(ledger.costUsd, 0.019);
});

boundaryTest("the ledger receives reconciled request boundaries, preserving the chat receipt's context tiers", async () => {
  writes.length = 0;
  const { recordTurnSpend } = await import("@/lib/chat/turn/spend");
  const model = MODELS["xai:grok-4.7"];
  assert.ok(model);
  const acc = new GenerationAccumulator();
  for (let i = 1; i <= 2; i += 1) {
    acc.recordRequestUsage({ promptTokens: 150_000, completionTokens: 1_000, fastMode: false });
    acc.apply({ type: "usage", input: i * 150_000, output: i * 1_000 });
  }
  const usage = buildUsage(model, acc.rawUsage({ promptChars: 600_000 }));
  await recordTurnSpend({
    userId: "account-test", modelId: model.id, source: "web",
    generationId: "generation-tool-loop", usage, acc,
    promptChars: 600_000, completionChars: 0,
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].requestUsages, acc.requestUsages);
  const ledger = estimateTurnCostUsd(model, writes[0], writes[0].requestUsages);
  assert.equal(ledger.costUsd, usage.cost);
  assert.equal(estimateGenerationCostUsd(model, writes[0]).costUsd, usage.cost * 2);
});

boundaryTest("interrupted mixed-tier usage retains its verified premium at both receipt and ledger", async () => {
  writes.length = 0;
  const { recordTurnSpend } = await import("@/lib/chat/turn/spend");
  const model = MODELS["anthropic:claude-opus-5-5"];
  assert.ok(model);
  const acc = new GenerationAccumulator();
  acc.recordRequestUsage({ promptTokens: 1_000, completionTokens: 100, fastMode: true });
  acc.apply({ type: "usage", input: 1_000, output: 100, fast: true });
  acc.apply({ type: "usage", input: 1_500, output: 150, fast: false });
  const usage = buildUsage(model, acc.rawUsage({ promptChars: 6_000 }), acc.servedFast);
  await recordTurnSpend({
    userId: "account-test", modelId: model.id, source: "web",
    generationId: "generation-interrupted-tier", usage, acc,
    promptChars: 6_000, completionChars: 0,
  });
  assert.equal(writes.length, 1);
  const ledger = estimateTurnCostUsd(model, writes[0], writes[0].requestUsages);
  assert.equal(ledger.costUsd, usage.cost);
  assert.ok(Math.abs(usage.cost - 0.015) < 1e-10);
});
