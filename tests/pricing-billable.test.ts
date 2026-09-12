import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBillableTokens,
  estimateGenerationCostUsd,
  recomputeCostMicroUsd,
  estimateCostUsd,
  toolFeesUsd,
  tokenRate,
  normalizeUsage,
  compatPromptCacheTokens,
} from "@/lib/pricing";
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

const sonnet5 = {
  id: "anthropic:claude-sonnet-5",
  provider: "anthropic",
  providerModel: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  family: "sonnet",
  status: "current",
  minPlan: "FREE",
  cost: 2,
  reasoning: true,
  vision: true,
  contextWindow: 1_000_000,
  description: "test",
} as ModelInfo;

const grok = {
  id: "xai:grok-4.5",
  provider: "xai",
  providerModel: "grok-4.5",
  name: "Grok 4.5",
  family: "grok",
  status: "current",
  minPlan: "PRO",
  cost: 2,
  reasoning: true,
  vision: true,
  contextWindow: 256_000,
  description: "test",
} as ModelInfo;

const gpt56 = {
  id: "openai:gpt-5.6",
  provider: "openai",
  providerModel: "gpt-5.6",
  name: "GPT-5.6",
  family: "gpt",
  status: "current",
  minPlan: "PRO",
  cost: 3,
  reasoning: true,
  vision: true,
  contextWindow: 1_050_000,
  description: "test",
} as ModelInfo;

const astra = {
  ...gpt56,
  id: "openai:gpt-6-astra",
  providerModel: "gpt-6-astra",
  name: "GPT-6 Astra",
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

test("Anthropic 1h cache write bills at 2× input rate (not 1.25×)", () => {
  const r = tokenRate(sonnet5);
  // Sonnet 5 intro: $2/MTok input → 1h write $4/MTok
  assert.equal(r.input, 2);
  assert.equal(r.cacheWrite1h, 4);
  assert.equal(r.cacheWrite5m, 2.5);
  assert.equal(r.cacheWrite, 4); // default = 1h (what Juno writes)

  // 1M tokens written at 1h TTL = $4
  const cost = estimateCostUsd(sonnet5, {
    input: 0,
    output: 0,
    cacheWrite1h: 1_000_000,
  });
  assert.ok(Math.abs(cost - 4) < 0.001, `got ${cost}`);

  // Unspecified cacheWrite also uses 1h rate for Anthropic
  const costAgg = estimateCostUsd(sonnet5, {
    input: 0,
    output: 0,
    cacheWrite: 1_000_000,
  });
  assert.ok(Math.abs(costAgg - 4) < 0.001, `got ${costAgg}`);
});

test("Anthropic web search adds $0.01 per request on top of tokens", () => {
  const fees = toolFeesUsd("anthropic", { webSearchRequests: 5 });
  assert.equal(fees, 0.05);

  // 1M output @ $10 + 3 searches @ $0.01 = $10.03
  const billed = estimateGenerationCostUsd(sonnet5, {
    promptTokens: 0,
    completionTokens: 1_000_000,
    webSearchRequests: 3,
  });
  assert.ok(Math.abs(billed.costUsd - 10.03) < 0.001, `got ${billed.costUsd}`);
  assert.equal(billed.toolFeesUsd, 0.03);
});

test("Anthropic cumulative input (search results) is additive with cache", () => {
  // Fresh 10k + cache read 50k + 1h write 20k + out 8k + 2 searches
  // = 10k*$2 + 50k*$0.2 + 20k*$4 + 8k*$10 all /1e6 + $0.02
  // = 0.02 + 0.01 + 0.08 + 0.08 + 0.02 = 0.21
  const billed = estimateGenerationCostUsd(sonnet5, {
    promptTokens: 10_000,
    completionTokens: 8_000,
    cacheRead: 50_000,
    cacheWrite1h: 20_000,
    webSearchRequests: 2,
  });
  assert.ok(Math.abs(billed.costUsd - 0.21) < 0.001, `got ${billed.costUsd}`);
});

test("normalizeUsage Anthropic treats input + cache as separate additive counters", () => {
  const n = normalizeUsage("anthropic", {
    input: 100,
    cacheRead: 900,
    cacheWrite: 50,
    output: 200,
  });
  assert.equal(n.freshInput, 100);
  assert.equal(n.totalInput, 1050);
  assert.equal(n.output, 200);
});

test("xAI web + X search fees are $5/1k each", () => {
  assert.equal(toolFeesUsd("xai", { webSearchRequests: 10 }), 0.05);
  assert.equal(toolFeesUsd("xai", { xSearchRequests: 10 }), 0.05);
  assert.equal(toolFeesUsd("xai", { webSearchRequests: 2, xSearchRequests: 2 }), 0.02);

  const billed = estimateGenerationCostUsd(grok, {
    promptTokens: 0,
    completionTokens: 0,
    webSearchRequests: 4,
  });
  assert.equal(billed.toolFeesUsd, 0.02);
  assert.equal(billed.costUsd, 0.02);
});

test("OpenAI web search fee is $10/1k", () => {
  assert.equal(toolFeesUsd("openai", { webSearchRequests: 10 }), 0.1);
});

test("Google grounding has no per-call tool fee", () => {
  assert.equal(toolFeesUsd("google", { webSearchRequests: 100 }), 0);
});

test("fast mode multiplies token rates but not tool fees", () => {
  // Opus 4.8 fast is 2× tokens; tool fees unchanged.
  const opus = {
    ...sonnet5,
    id: "anthropic:claude-opus-4-8",
    providerModel: "claude-opus-4-8",
    name: "Claude Opus 4.8",
  } as ModelInfo;
  // base $5/$25 → fast $10/$50
  const normal = estimateGenerationCostUsd(opus, {
    promptTokens: 0,
    completionTokens: 1_000_000,
    webSearchRequests: 2,
  });
  const fast = estimateGenerationCostUsd(opus, {
    promptTokens: 0,
    completionTokens: 1_000_000,
    webSearchRequests: 2,
    fastMode: true,
  });
  // normal: $25 + $0.02; fast: $50 + $0.02
  assert.ok(Math.abs(normal.costUsd - 25.02) < 0.001, `normal ${normal.costUsd}`);
  assert.ok(Math.abs(fast.costUsd - 50.02) < 0.001, `fast ${fast.costUsd}`);
  assert.equal(normal.toolFeesUsd, 0.02);
  assert.equal(fast.toolFeesUsd, 0.02);
});

test("GPT-5.6 cache read is 0.1× input", () => {
  const r = tokenRate(gpt56);
  assert.equal(r.input, 5);
  assert.equal(r.cacheRead, 0.5);
  assert.equal(r.cacheWrite, 6.25); // 1.25×
});

test("GPT-6 Astra uses official standard, cache, fast and long-context rates", () => {
  const standard = tokenRate(astra);
  assert.deepEqual(
    { input: standard.input, output: standard.output, cacheRead: standard.cacheRead, cacheWrite: standard.cacheWrite },
    { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }
  );
  const fast = tokenRate(astra, true);
  assert.equal(fast.input, 20);
  assert.equal(fast.output, 100);

  const short = estimateCostUsd(astra, { input: 272_000, output: 100_000 });
  assert.ok(Math.abs(short - 7.72) < 0.000001, `short-context cost ${short}`);
  const long = estimateCostUsd(astra, { input: 272_001, output: 100_000 });
  assert.ok(Math.abs(long - 12.94002) < 0.000001, `long-context cost ${long}`);
});

test("reasoning lift does not double-count when already inside output", () => {
  // completion already includes reasoning
  const t = resolveBillableTokens({
    promptTokens: 100,
    completionTokens: 5_000,
    reasoningTokens: 3_000, // subset
  });
  assert.equal(t.completionTokens, 5_000);
});

const deepseekFlash = {
  id: "deepseek:deepseek-v4-flash",
  provider: "deepseek",
  providerModel: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  family: "v4-flash",
  status: "current",
  minPlan: "FREE",
  cost: 1,
  reasoning: false,
  vision: false,
  contextWindow: 1_000_000,
  description: "test",
} as ModelInfo;

test("DeepSeek cache misses are uncached input, never a cache write (no double bill)", () => {
  // DeepSeek reports prompt_tokens = hit + miss. The compat adapter used to
  // take the miss count as a cache WRITE for every non-OpenAI provider, so the
  // 600 uncached tokens were billed once as fresh input by normalizeUsage and
  // again as a write at the input rate: uncached input cost double.
  const cache = compatPromptCacheTokens({
    prompt_cache_hit_tokens: 400,
    prompt_cache_miss_tokens: 600,
  });
  assert.equal(cache.cacheRead, 400);
  assert.equal(cache.cacheWrite, 0);

  const rate = tokenRate(deepseekFlash);
  const usage = { input: 1000, cacheRead: cache.cacheRead, cacheWrite: cache.cacheWrite, output: 0 };
  const expected = (600 * rate.input + 400 * rate.cacheRead) / 1_000_000;
  const cost = estimateCostUsd(deepseekFlash, usage);
  assert.ok(Math.abs(cost - expected) < 1e-12, `expected ${expected}, got ${cost}`);

  // The old arithmetic, for the record: 600 more input-rate tokens.
  const doubleBilled = estimateCostUsd(deepseekFlash, { ...usage, cacheWrite: 600 });
  assert.ok(doubleBilled > cost, "the regression this pins would charge the misses twice");
  assert.ok(Math.abs(doubleBilled - expected - (600 * rate.cacheWrite) / 1_000_000) < 1e-12);
});

test("an explicit cache_write_tokens is still a write, and an absent read is undefined", () => {
  const written = compatPromptCacheTokens({ prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 50 } });
  assert.deepEqual(written, { cacheRead: 100, cacheWrite: 50 });
  // Kimi's top-level field, and a chunk that says nothing about the cache.
  assert.equal(compatPromptCacheTokens({ cached_tokens: 7 }).cacheRead, 7);
  assert.equal(compatPromptCacheTokens({}).cacheRead, undefined);
});

/*
 * GEMINI'S USAGE SHAPE, billed.
 *
 * The native adapter yields `output` = candidatesTokenCount (the visible
 * answer), `reasoning` = thoughtsTokenCount and `total` = totalTokenCount.
 * Thinking is by far the larger half on a Gemini 3 turn, so which field is read
 * under which name is the difference between billing 5,200 output tokens and
 * billing 200.
 */
test("Gemini thinking tokens are billed as output, using total as the cross-check", () => {
  const gemini = resolveBillableTokens({
    promptTokens: 1_000,
    completionTokens: 200, // candidatesTokenCount — the visible answer only
    reasoningTokens: 5_000, // thoughtsTokenCount
    totalTokens: 6_200, // totalTokenCount
  });
  assert.equal(gemini.promptTokens, 1_000);
  assert.equal(gemini.completionTokens, 5_200);
});

test("without total_tokens Gemini bills the largest half it can prove, never zero", () => {
  // Google's own surfaces disagree about whether candidatesTokenCount already
  // includes thoughts, so with `total` absent the honest floor is the larger of
  // the two counters — adding them could double-bill the same thinking tokens.
  const noTotal = resolveBillableTokens({
    promptTokens: 1_000,
    completionTokens: 200,
    reasoningTokens: 5_000,
  });
  assert.equal(noTotal.completionTokens, 5_000);
});

test("an OpenAI-shaped report, where reasoning is already inside output, is not inflated", () => {
  const openai = resolveBillableTokens({
    promptTokens: 1_000,
    completionTokens: 5_200, // completion_tokens INCLUDES reasoning
    reasoningTokens: 5_000,
    totalTokens: 6_200,
  });
  assert.equal(openai.completionTokens, 5_200);
});
