/**
 * Local, synthetic CPU/call-count evidence for the 2026-10-29 chat audit.
 * No provider, database, credentials, or network calls. This is not a model
 * quality test or a browser/production latency benchmark.
 *
 * Run on an otherwise idle host: npx tsx scripts/bench-chat-audit.ts
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { getModel } from "../src/lib/models";
import { estimateGenerationCostUsd, tokenRate } from "../src/lib/pricing";
import { estimateTurnCostUsd } from "../src/lib/turn-pricing";
import { createStreamBudgetGuard } from "../src/lib/chat-budget-guard";
import { createFollowUpCache } from "../src/lib/chat/follow-up-cache";
import { searchConversation } from "../src/lib/conversation-search";

const catalogModel = getModel("grok-4.7");
assert.ok(catalogModel);
const model = catalogModel;
const requests = Array.from({ length: 6 }, () => ({ promptTokens: 50_000, completionTokens: 500, cacheRead: 40_000 }));
const total = { promptTokens: 300_000, completionTokens: 3_000, cacheRead: 240_000 };
let consumed = 0;

function measure(name: string, iterations: number, action: () => number) {
  for (let i = 0; i < 1_000; i += 1) consumed += action();
  const samples: number[] = [];
  for (let sample = 0; sample < 9; sample += 1) {
    const started = performance.now();
    for (let i = 0; i < iterations; i += 1) consumed += action();
    samples.push((performance.now() - started) * 1_000 / iterations);
  }
  samples.sort((a, b) => a - b);
  return {
    name, iterationsPerSample: iterations, samples: samples.length,
    unit: "microseconds per operation", median: +samples[4].toFixed(3),
    slowestSample: +samples[8].toFixed(3),
  };
}

const guard = createStreamBudgetGuard({
  ceilingMicroUsd: 1_000_000_000,
  rates: () => tokenRate(model),
  inputChars: 0,
  usage: () => ({
    promptTokens: total.promptTokens, completionTokens: total.completionTokens,
    cacheReadTokens: total.cacheRead, outputChars: 9_000, reasoningChars: 1_000,
  }),
  onHalt: () => { throw new Error("fixture budget should not halt"); },
});
const messages = Array.from({ length: 1_000 }, (_, index) => ({
  id: `message-${index}`, role: index % 2 ? "ASSISTANT" : "USER",
  content: `${"A representative paragraph about a project. ".repeat(25)}reference-${index}`,
}));
const measurements = [
  measure("previous aggregate estimator, six-request totals", 10_000,
    () => estimateGenerationCostUsd(model, total).costUsd),
  measure("reconciled per-request estimator, six requests", 10_000,
    () => estimateTurnCostUsd(model, total, requests).costUsd),
  measure("stream budget projection including canonical rate lookup", 20_000,
    () => guard.projectedMicroUsd()),
  measure("literal search, 1,000 messages, no match", 100,
    () => searchConversation(messages, "absentneedle").matches.length),
  measure("literal search, 1,000 messages, 500-result cap", 100,
    () => searchConversation(messages, "project").matches.length),
];

async function report() {
  const cache = createFollowUpCache();
  let providerCalls = 0;
  const suggestions = await Promise.all(Array.from({ length: 20 }, () => cache.getOrCreate("identical-fixture", async () => {
    providerCalls += 1;
    return ["Explore the result", "Explain the tradeoffs"];
  })));
  assert.equal(providerCalls, 1);
  assert.equal(suggestions.length, 20);
  const twoRequests = Array.from({ length: 2 }, () => ({ promptTokens: 150_000, completionTokens: 1_000 }));
  const twoTotal = { promptTokens: 300_000, completionTokens: 2_000 };

  console.log(JSON.stringify({
    evidence: "synthetic local CPU and deterministic call counts; not production latency or monthly savings",
    node: process.version,
    measurements,
    duplicatedFollowUps: { callers: 20, generatedCalls: providerCalls, avoidedCalls: 19 },
    contextTierReproduction: {
      model: model.id, requests: twoRequests,
      previousAggregateEstimateUsd: estimateGenerationCostUsd(model, twoTotal).costUsd,
      correctedRequestEstimateUsd: estimateTurnCostUsd(model, twoTotal, twoRequests).costUsd,
    },
    // Keep the arithmetic observable to the optimizer without printing chat data.
    arithmeticConsumed: Number.isFinite(consumed),
  }, null, 2));
}

void report().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
