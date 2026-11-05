import test from "node:test";
import assert from "node:assert/strict";
import { getModel, type ModelInfo } from "@/lib/models";
import { estimateGenerationCostUsd, type GenerationCostOpts } from "@/lib/pricing";
import { estimateTurnCostUsd } from "@/lib/turn-pricing";
import { buildUsage } from "@/lib/chat-usage";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { createRequestMeter } from "@/lib/llm/request-meter";

function model(id: string): ModelInfo {
  const value = getModel(id);
  assert.ok(value, `${id} is in the catalog`);
  return value;
}
const grok = model("grok-4.7");
const near = (actual: number, expected: number) => assert.ok(
  Math.abs(actual - expected) < 1e-10, `${actual} equals ${expected}`
);
const sumCost = (m: ModelInfo, requests: GenerationCostOpts[]) =>
  requests.reduce((sum, request) => sum + estimateGenerationCostUsd(m, request).costUsd, 0);

test("two ordinary tool requests do not become one long-context request", () => {
  const requests = [
    { promptTokens: 150_000, completionTokens: 1_000 },
    { promptTokens: 150_000, completionTokens: 1_000 },
  ];
  const total = { promptTokens: 300_000, completionTokens: 2_000 };
  const billed = estimateTurnCostUsd(grok, total, requests);
  near(billed.costUsd, sumCost(grok, requests));
  near(estimateGenerationCostUsd(grok, total).costUsd, billed.costUsd * 2);
  assert.equal(billed.promptTokens, 300_000);
  assert.equal(billed.completionTokens, 2_000);
});

test("a genuinely long request retains its surcharge without raising a short sibling", () => {
  const requests = [
    { promptTokens: 250_000, completionTokens: 500 },
    { promptTokens: 50_000, completionTokens: 1_500 },
  ];
  const total = { promptTokens: 300_000, completionTokens: 2_000 };
  near(estimateTurnCostUsd(grok, total, requests).costUsd, sumCost(grok, requests));
  assert.ok(estimateTurnCostUsd(grok, total, requests).costUsd < estimateGenerationCostUsd(grok, total).costUsd);
});

test("the inclusive Grok boundary applies to each request, including exactly 200K", () => {
  const request = { promptTokens: 200_000, completionTokens: 100 };
  assert.deepEqual(estimateTurnCostUsd(grok, request, [request]), estimateGenerationCostUsd(grok, request));
  const below = { promptTokens: 100_000, completionTokens: 50 };
  near(estimateTurnCostUsd(grok, request, [below, below]).costUsd * 2, estimateGenerationCostUsd(grok, request).costUsd);
});

test("cache buckets and provider searches stay on the request that consumed them", () => {
  const requests = [
    { promptTokens: 140_000, completionTokens: 100, cacheRead: 100_000, webSearchRequests: 2 },
    { promptTokens: 150_000, completionTokens: 200, cacheRead: 140_000, xSearchRequests: 1 },
  ];
  const total = { promptTokens: 290_000, completionTokens: 300, cacheRead: 240_000, webSearchRequests: 2, xSearchRequests: 1 };
  const billed = estimateTurnCostUsd(grok, total, requests);
  near(billed.costUsd, sumCost(grok, requests));
  assert.equal(billed.cacheRead, 240_000);
  near(billed.toolFeesUsd, estimateGenerationCostUsd(grok, total).toolFeesUsd);
});

test("fully cached Anthropic requests preserve zero fresh input and both write lifetimes", () => {
  const claude = model("claude-sonnet-5-5");
  const requests = [
    { promptTokens: 0, completionTokens: 100, cacheRead: 90_000, cacheWrite5m: 3_000, cacheWrite1h: 1_000 },
    { promptTokens: 0, completionTokens: 200, cacheRead: 94_000, cacheWrite5m: 1_000 },
  ];
  const total = { promptTokens: 0, completionTokens: 300, cacheRead: 184_000, cacheWrite5m: 4_000, cacheWrite1h: 1_000 };
  const billed = estimateTurnCostUsd(claude, total, requests);
  assert.equal(billed.promptTokens, 0);
  near(billed.costUsd, sumCost(claude, requests));
});

test("a fast-to-standard fallback prices each served tier instead of repricing the entire turn", () => {
  const claude = model("claude-opus-5-5");
  const requests = [
    { promptTokens: 1_000, completionTokens: 100, fastMode: true },
    { promptTokens: 1_000, completionTokens: 100, fastMode: false },
  ];
  const total = { promptTokens: 2_000, completionTokens: 200, fastMode: false };
  near(estimateTurnCostUsd(claude, total, requests).costUsd, sumCost(claude, requests));
});

test("an interrupted standard round cannot erase a completed fast request's premium", () => {
  const claude = model("claude-opus-5-5");
  const completed = { promptTokens: 1_000, completionTokens: 100, fastMode: true };
  const interrupted = { promptTokens: 500, completionTokens: 50, fastMode: false };
  const total = { promptTokens: 1_500, completionTokens: 150, fastMode: false };
  const billed = estimateTurnCostUsd(claude, total, [completed]);
  near(billed.costUsd, sumCost(claude, [completed, interrupted]));
  assert.ok(billed.costUsd > estimateGenerationCostUsd(claude, completed).costUsd);
  assert.ok(billed.costUsd > estimateGenerationCostUsd(claude, total).costUsd);
  for (const badInput of [Number.NaN, -1]) {
    const withInvalidReceipt = estimateTurnCostUsd(claude, total, [
      completed,
      { ...interrupted, promptTokens: badInput },
    ]);
    near(withInvalidReceipt.costUsd, billed.costUsd);
  }
});

test("cheaper known requests never discount incomplete final-tier coverage", () => {
  const claude = model("claude-opus-5-5");
  for (const [completed, total] of [
    [
      { promptTokens: 1_000, completionTokens: 100, fastMode: false },
      { promptTokens: 1_500, completionTokens: 150, fastMode: true },
    ],
    [
      { promptTokens: 1_000, completionTokens: 100, batch: true },
      { promptTokens: 1_500, completionTokens: 150, batch: false },
    ],
  ]) {
    assert.deepEqual(estimateTurnCostUsd(claude, total, [completed]), estimateGenerationCostUsd(claude, total));
  }
});

test("a partial batch receipt retains a completed non-batch request's verified cost", () => {
  const claude = model("claude-opus-5-5");
  const completed = { promptTokens: 1_000, completionTokens: 100, batch: false };
  const remainder = { promptTokens: 500, completionTokens: 50, batch: true };
  const total = { promptTokens: 1_500, completionTokens: 150, batch: true };
  near(estimateTurnCostUsd(claude, total, [completed]).costUsd, sumCost(claude, [completed, remainder]));
});

test("Gemini total tokens preserve answer plus thought tokens for each request", () => {
  const gemini = model("gemini-2.5-pro");
  const requests = [
    { promptTokens: 1_000, completionTokens: 100, reasoningTokens: 200, totalTokens: 1_300 },
    { promptTokens: 1_200, completionTokens: 200, reasoningTokens: 300, totalTokens: 1_700 },
  ];
  const total = { promptTokens: 2_200, completionTokens: 300, reasoningTokens: 500, totalTokens: 3_000 };
  const billed = estimateTurnCostUsd(gemini, total, requests);
  assert.equal(billed.completionTokens, 800);
  near(billed.costUsd, sumCost(gemini, requests));
});

test("missing request, cache, tool, or streamed-output coverage keeps the conservative estimate", () => {
  const total = { promptTokens: 300_000, completionTokens: 2_000, cacheRead: 100_000, webSearchRequests: 2 };
  const complete = [
    { promptTokens: 150_000, completionTokens: 1_000, cacheRead: 50_000, webSearchRequests: 1 },
    { promptTokens: 150_000, completionTokens: 1_000, cacheRead: 50_000, webSearchRequests: 1 },
  ];
  for (const requests of [
    [],
    complete.slice(0, 1),
    complete.map((request) => ({ ...request, cacheRead: 0 })),
    complete.map((request) => ({ ...request, webSearchRequests: 0 })),
    complete.map((request) => ({ ...request, completionTokens: 1 })),
    [complete[0], { ...complete[1], cacheRead: Number.NaN }],
    [complete[0], { ...complete[1], promptTokens: -1 }],
  ]) assert.deepEqual(estimateTurnCostUsd(grok, total, requests), estimateGenerationCostUsd(grok, total));
  const interrupted = { ...total, completionChars: 40_000 };
  assert.deepEqual(estimateTurnCostUsd(grok, interrupted, complete), estimateGenerationCostUsd(grok, interrupted));
});

test("request meter delivers one receipt per completed request even if telemetry fails", () => {
  const receipts: GenerationCostOpts[] = [];
  const meter = createRequestMeter({ model: grok, role: "chat", fastMode: true }, {
    sink: () => { throw new Error("telemetry unavailable"); },
    onUsage: (usage) => receipts.push(usage),
  });
  const first = meter.begin({ wire: "responses", round: 0, body: { model: grok.providerModel, input: [] } });
  first.end({ input: 100, output: 10, total: 110 }, { fastMode: false });
  first.end({ input: 100, output: 10, total: 110 });
  meter.begin({ wire: "responses", round: 1, body: {} }).end(null, { ok: false });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].totalTokens, 110);
  assert.equal(receipts[0].fastMode, false);
});

test("the accumulator and displayed chat receipt use the provider request boundaries", () => {
  const acc = new GenerationAccumulator();
  const meter = createRequestMeter({ model: grok, role: "chat" }, {
    sink: () => undefined,
    onUsage: (usage) => acc.recordRequestUsage(usage),
  });
  for (let round = 0; round < 2; round += 1) {
    meter.begin({ wire: "responses", round, body: {} }).end({ input: 150_000, output: 1_000 });
    acc.apply({ type: "usage", input: 150_000 * (round + 1), output: 1_000 * (round + 1) });
  }
  const usage = buildUsage(grok, acc.rawUsage({ promptChars: 0 }));
  near(usage.cost, 2 * estimateGenerationCostUsd(grok, { promptTokens: 150_000, completionTokens: 1_000 }).costUsd);
  assert.equal(usage.totalInput, 300_000);
  assert.equal(usage.output, 2_000);
  assert.equal(usage.basis, "reported");
});
