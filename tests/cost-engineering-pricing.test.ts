import test from "node:test";
import assert from "node:assert/strict";
import { batchPriceMultiplier, estimateGenerationCostUsd, tokenRate } from "@/lib/pricing";
import { getModel, type ModelInfo } from "@/lib/models";

function model(id: string): ModelInfo {
  const found = getModel(id);
  assert.ok(found, `catalogue has ${id}`);
  return found!;
}

const ratio = (id: string) => {
  const rate = tokenRate(model(id));
  return rate.cacheRead / rate.input;
};

test("every Gemini model bills a cache hit at Google's 10%, not the 0.25x fallback", () => {
  for (const id of ["gemini-3.1-pro-preview", "gemini-3.5-flash-lite", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-3.8-flash"]) {
    assert.ok(Math.abs(ratio(id) - 0.1) < 1e-9, `${id} cache ratio ${ratio(id)}`);
  }
});

test("DeepSeek cache hits bill at DeepSeek's published 2% / 3.3%", () => {
  assert.ok(Math.abs(ratio("deepseek-flash") - 0.02) < 1e-9);
  // The page's own figure, $0.022 on $0.66 (models:sync), not a rounded ratio.
  assert.ok(Math.abs(tokenRate(model("deepseek-v4-pro")).cacheRead - 0.022) < 1e-9);
  assert.ok(Math.abs(ratio("deepseek-v4-pro") - 0.0333) < 1e-3);
  // $0.003 per MTok on Flash: within a hair of the published price.
  assert.ok(Math.abs(tokenRate(model("deepseek-flash")).cacheRead - 0.003) < 1e-9);
});

test("Kimi cache hits follow Moonshot's per-model column", () => {
  assert.ok(Math.abs(ratio("kimi-k3") - 0.1) < 1e-9);
  assert.ok(Math.abs(ratio("kimi-k2.7-code") - 0.2) < 1e-9);
  assert.ok(Math.abs(tokenRate(model("kimi-k2.6")).cacheRead - 0.16) < 0.001);
});

test("batch pricing halves tokens on the three batch providers and nothing else", () => {
  assert.equal(batchPriceMultiplier("anthropic"), 0.5);
  assert.equal(batchPriceMultiplier("openai"), 0.5);
  assert.equal(batchPriceMultiplier("google"), 0.5);
  assert.equal(batchPriceMultiplier("deepseek"), null);

  const claude = model("claude-opus-5-5");
  const usage = { promptTokens: 10_000, completionTokens: 1_000 };
  const interactive = estimateGenerationCostUsd(claude, usage).costUsd;
  const batched = estimateGenerationCostUsd(claude, { ...usage, batch: true }).costUsd;
  assert.ok(interactive > 0);
  assert.ok(Math.abs(batched - interactive / 2) < 1e-12);

  // A provider with no batch API: the flag cannot invent a discount.
  const ds = model("deepseek-flash");
  assert.equal(
    estimateGenerationCostUsd(ds, { ...usage, batch: true }).costUsd,
    estimateGenerationCostUsd(ds, usage).costUsd
  );
});

test("the batch discount never applies to per-call tool fees", () => {
  const claude = model("claude-opus-5-5");
  const usage = { promptTokens: 1_000, completionTokens: 100, webSearchRequests: 10 };
  const interactive = estimateGenerationCostUsd(claude, usage);
  const batched = estimateGenerationCostUsd(claude, { ...usage, batch: true });
  const fees = interactive.toolFeesUsd;
  assert.ok(fees > 0);
  assert.ok(Math.abs(batched.costUsd - ((interactive.costUsd - fees) / 2 + fees)) < 1e-12);
});
