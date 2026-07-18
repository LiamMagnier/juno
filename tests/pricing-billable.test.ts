import test from "node:test";
import assert from "node:assert/strict";
import { resolveBillableTokens, estimateGenerationCostUsd, recomputeCostMicroUsd } from "@/lib/pricing";
import type { ModelInfo } from "@/lib/models";

const kimi = {
  id: "kimi-k2.6",
  provider: "moonshot",
  providerModel: "kimi-k2.6",
  name: "Kimi K2.6",
  family: "kimi",
  status: "current",
  minPlan: "PRO",
  cost: 2,
  reasoning: true,
  vision: true,
  contextWindow: 262_144,
  description: "test",
} as ModelInfo;

test("resolveBillableTokens floors on answer+reasoning chars when usage is missing", () => {
  const t = resolveBillableTokens({
    completionChars: 400,
    reasoningChars: 4_000,
    promptChars: 1_200,
  });
  assert.equal(t.promptTokens, 300);
  assert.equal(t.completionTokens, 1_100); // (400+4000)/4
});

test("resolveBillableTokens lifts completion when reasoning exceeds reported output", () => {
  const t = resolveBillableTokens({
    promptTokens: 1_000,
    completionTokens: 200,
    reasoningTokens: 8_000,
  });
  assert.equal(t.promptTokens, 1_000);
  assert.equal(t.completionTokens, 8_000);
});

test("resolveBillableTokens uses total_tokens as a cross-check", () => {
  const t = resolveBillableTokens({
    promptTokens: 500,
    completionTokens: 100,
    totalTokens: 9_000,
  });
  assert.equal(t.completionTokens, 8_500);
});

test("estimateGenerationCostUsd prices Kimi thinking output at output rates", () => {
  // 1M input @ $0.95 + 1M output @ $4.00 = $4.95
  const billed = estimateGenerationCostUsd(kimi, {
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  });
  assert.ok(billed.costUsd > 4.9 && billed.costUsd < 5.0, `got ${billed.costUsd}`);
});

test("recomputeCostMicroUsd prefers model rates over zero ledger rows", () => {
  const micro = recomputeCostMicroUsd("kimi-k2.6", 1_000_000, 0, () => kimi);
  // $0.95 → 950_000 micro-USD
  assert.equal(micro, 950_000);
});
