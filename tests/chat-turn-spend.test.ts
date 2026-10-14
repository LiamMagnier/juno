import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { buildUsage } from "@/lib/chat-usage";
import { MODELS } from "@/lib/models";
import { estimateGenerationCostUsd } from "@/lib/pricing";
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
