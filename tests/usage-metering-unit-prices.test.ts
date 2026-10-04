import test from "node:test";
import assert from "node:assert/strict";
import {
  admissionVerdict,
  affordableOutputTokens,
  createUnattributedSpendMeter,
  embeddingCostMicroUsd,
  estimateAudioSeconds,
  mediaBillMicroUsd,
  openAIImageUsageCostMicroUsd,
  sttCostMicroUsd,
  ttsCostMicroUsd,
  unattributedDailyCeilingMicroUsd,
  wavSeconds,
} from "@/lib/metering/unit-prices";
import { capOutputTokens } from "@/lib/agent-proxy";
import { workRunPricing } from "@/lib/metering/work-pricing";
import { resolveModel } from "@/lib/models";
import { tokenRate } from "@/lib/pricing";
import { WorkBudgetGuard } from "../runner/agent-core/src/work/budget";
import { geminiDelegateCostUsd } from "../relay/src/providers/gemini-delegate";
import { gptLiveDelegationEstimateUsd, gptLiveDelegationUsageUsd } from "../relay/src/providers/delegate-pricing";

/*
 * The prices behind every paid call that is not a chat token
 * (docs/pricing/USAGE_METERING_AUDIT.md). Each of these paths used to reach no
 * ledger at all; what is pinned here is that the figure they now bill is the
 * provider's published price or ABOVE it — never below.
 */

// ── TTS ────────────────────────────────────────────────────────────────────

test("TTS: Gemini priced from the WAV's real length at $18/M audio tokens (25/s)", () => {
  // One minute of 24 kHz mono 16-bit PCM plus the 44-byte header.
  const bytes = 44 + 60 * 48_000;
  assert.equal(wavSeconds(bytes), 60);
  // 60 s × 25 tok × $18/M = $0.027, plus 100 chars of text in at $1/M.
  assert.equal(ttsCostMicroUsd("google", { chars: 100, audioSeconds: 60 }), 27_000 + 25);
});

test("TTS: without audio, the text is read at 12 chars/s — more seconds, never fewer", () => {
  // 1,200 chars → 100 s. OpenAI at $0.015/min = 250 µ$/s.
  assert.ok(ttsCostMicroUsd("openai", { chars: 1_200 }) >= 100 * 250);
  // ElevenLabs at the top of its overage range, $0.30 per 1k characters.
  assert.equal(ttsCostMicroUsd("elevenlabs", { chars: 1_000 }), 300_000);
});

// ── STT ────────────────────────────────────────────────────────────────────

test("STT: clip length estimated high from its size", () => {
  assert.equal(estimateAudioSeconds(32_000 * 10, "audio/wav"), 10);
  // A 16 kbps assumption: a real 32 kbps opus clip reads twice as long.
  assert.equal(estimateAudioSeconds(4_000 * 10, "audio/webm;codecs=opus"), 20);
});

test("STT: duration floor at $0.006/min, provider tokens win when dearer", () => {
  assert.equal(sttCostMicroUsd("openai", { audioSeconds: 60 }), 6_000);
  assert.equal(sttCostMicroUsd("deepgram", { audioSeconds: 60 }), 6_000);
  // gpt-4o-transcribe tokens: 10k in at $2.50/M + 500 out at $10/M = $0.03.
  assert.equal(sttCostMicroUsd("openai", { audioSeconds: 60, inputTokens: 10_000, outputTokens: 500 }), 30_000);
  // Gemini Flash-Lite: 32 audio tokens/s at $0.50/M.
  assert.ok(sttCostMicroUsd("gemini", { audioSeconds: 60, outputChars: 400 }) >= 60 * 32 * 0.5);
  // A zero-length clip still costs the provider's minimum second.
  assert.ok(sttCostMicroUsd("openai", { audioSeconds: 0 }) > 0);
});

// ── Embeddings ─────────────────────────────────────────────────────────────

test("embeddings: listed rates, an unlisted model billed at the dearest", () => {
  assert.equal(embeddingCostMicroUsd("openai:text-embedding-3-small", { tokens: 1_000_000, chars: 0 }), 20_000);
  assert.equal(embeddingCostMicroUsd("openai:text-embedding-3-large", { tokens: 1_000_000, chars: 0 }), 130_000);
  assert.equal(embeddingCostMicroUsd("mistral:mistral-embed", { tokens: 1_000_000, chars: 0 }), 200_000);
  // No usage: chars/3, which over-counts English (≈4 chars a token).
  assert.equal(embeddingCostMicroUsd("openai:text-embedding-3-small", { chars: 3_000_000 }), 20_000);
});

// ── OpenAI image tokens ────────────────────────────────────────────────────

test("GPT Image: a 'high' render is billed from its usage, not the flat $0.04", () => {
  // gpt-image-1 high 1024²: ~4,160 output tokens at $40/M ≈ $0.166.
  const cost = openAIImageUsageCostMicroUsd("openai:gpt-image-1", {
    input_tokens: 50,
    output_tokens: 4_160,
    input_tokens_details: { text_tokens: 50, image_tokens: 0 },
  });
  assert.equal(cost, 50 * 5 + 4_160 * 40);
  const bill = mediaBillMicroUsd({ perOutputMicroUsd: 40_000, outputs: 1, providerCostMicroUsd: cost });
  assert.equal(bill.totalMicroUsd, cost);
  // gpt-image-1-mini is matched before gpt-image-1.
  assert.equal(openAIImageUsageCostMicroUsd("openai:gpt-image-1-mini", { output_tokens: 1_000 }), 8_000);
  // An unknown GPT Image id is priced as the dearest.
  assert.equal(openAIImageUsageCostMicroUsd("openai:gpt-image-9", { output_tokens: 1_000 }), 40_000);
  assert.equal(openAIImageUsageCostMicroUsd("openai:gpt-image-1", null), null);
});

test("media bill: the flat price is a floor the provider's figure can only raise", () => {
  assert.deepEqual(mediaBillMicroUsd({ perOutputMicroUsd: 40_000, outputs: 2, providerCostMicroUsd: 10_000 }), {
    perOutputMicroUsd: 40_000,
    totalMicroUsd: 80_000,
  });
  assert.equal(mediaBillMicroUsd({ perOutputMicroUsd: 40_000, outputs: 2, providerCostMicroUsd: 200_001 }).totalMicroUsd >= 200_001, true);
});

// ── Admission ──────────────────────────────────────────────────────────────

test("admission: month, window and the call's own estimate", () => {
  const open = { allowed: true, remainingMicroUsd: 100_000 };
  assert.deepEqual(admissionVerdict({ budget: open, estimateMicroUsd: 1 }), { allowed: true });
  assert.deepEqual(admissionVerdict({ budget: { allowed: false, remainingMicroUsd: 0 }, estimateMicroUsd: 0 }), {
    allowed: false,
    reason: "budget",
  });
  assert.deepEqual(
    admissionVerdict({ budget: open, windows: { allowed: false, bound: "session", remainingMicroUsd: 0 }, estimateMicroUsd: 0 }),
    { allowed: false, reason: "window" }
  );
  // The window's remainder binds when it is the tighter one.
  assert.deepEqual(
    admissionVerdict({ budget: open, windows: { allowed: true, bound: "session", remainingMicroUsd: 5_000 }, estimateMicroUsd: 6_000 }),
    { allowed: false, reason: "estimate" }
  );
  // An uncapped account (null remainders) is admitted whatever the estimate.
  assert.deepEqual(
    admissionVerdict({ budget: { allowed: true, remainingMicroUsd: null }, windows: { allowed: true, bound: null, remainingMicroUsd: null }, estimateMicroUsd: 9e9 }),
    { allowed: true }
  );
});

// ── Unattributed spend ─────────────────────────────────────────────────────

test("unattributed utility spend stops at its daily ceiling and resets the next UTC day", () => {
  let now = Date.UTC(2026, 9, 4, 10);
  const meter = createUnattributedSpendMeter({ ceilingMicroUsd: () => 1_000, now: () => now });
  assert.equal(meter.allows(), true);
  meter.add(999);
  assert.equal(meter.allows(), true);
  meter.add(1);
  assert.equal(meter.allows(), false);
  now = Date.UTC(2026, 9, 5, 0, 0, 1);
  assert.equal(meter.allows(), true);
  assert.equal(unattributedDailyCeilingMicroUsd(undefined), 5_000_000);
  assert.equal(unattributedDailyCeilingMicroUsd("0"), 0);
});

// ── Proxy output cap ───────────────────────────────────────────────────────

test("proxy: a request cannot ask for more output than the remainder buys", () => {
  // $0.10 left, prompt 4,000 chars at 2 µ$/token, output 10 µ$/token.
  const cap = affordableOutputTokens({
    remainingMicroUsd: 100_000,
    promptChars: 4_000,
    inputMicroUsdPerToken: 2,
    outputMicroUsdPerToken: 10,
    floor: 2_048,
  });
  assert.equal(cap, Math.floor((100_000 - 1_000 * 2) / 10));
  assert.equal(affordableOutputTokens({ remainingMicroUsd: 0, promptChars: 0, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1, floor: 2_048 }), 2_048);
  assert.equal(affordableOutputTokens({ remainingMicroUsd: null, promptChars: 0, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 1 }), null);

  const anthropic = JSON.parse(
    capOutputTokens("anthropic", JSON.stringify({ model: "m", max_tokens: 64_000, thinking: { type: "enabled", budget_tokens: 32_000 } }), 4_096)
  );
  assert.equal(anthropic.max_tokens, 4_096);
  assert.equal(anthropic.thinking.budget_tokens, 3_072);

  const chat = JSON.parse(capOutputTokens("openai-chat", JSON.stringify({ model: "m" }), 4_096, "max_completion_tokens"));
  assert.equal(chat.max_completion_tokens, 4_096);
  const legacy = JSON.parse(capOutputTokens("openai-chat", JSON.stringify({ model: "m", max_tokens: 100_000 }), 4_096));
  assert.equal(legacy.max_tokens, 4_096);
  const responses = JSON.parse(capOutputTokens("openai-responses", JSON.stringify({ model: "m" }), 4_096));
  assert.equal(responses.max_output_tokens, 4_096);

  // Below the cap, or no cap: the client's exact bytes go through.
  const small = JSON.stringify({ model: "m", max_tokens: 1_000 });
  assert.equal(capOutputTokens("anthropic", small, 4_096), small);
  assert.equal(capOutputTokens("anthropic", small, null), small);
});

// ── Work runner pricing ────────────────────────────────────────────────────

test("Work: an uncatalogued model is priced at its lab's dearest rate, never $0", () => {
  const unknown = workRunPricing(null, "openai");
  assert.ok(unknown.inputMicroUsdPerMillion > 0 && unknown.outputMicroUsdPerMillion > 0);
  const sol = resolveModel("openai:gpt-6.1-sol")!;
  const known = workRunPricing(sol, "openai");
  assert.equal(known.outputMicroUsdPerMillion, Math.round(tokenRate(sol).output * 1_000_000));
  assert.ok(unknown.outputMicroUsdPerMillion >= known.outputMicroUsdPerMillion);
  // A lab with no catalog entry falls back to the whole catalog's dearest.
  assert.ok(workRunPricing(null, "no-such-lab").outputMicroUsdPerMillion >= unknown.outputMicroUsdPerMillion);
});

test("Work: Anthropic cache writes carry their 1.25x premium in the run's cost", () => {
  const model = resolveModel("anthropic:claude-sonnet-5-5")!;
  const pricing = workRunPricing(model, "anthropic");
  assert.ok(pricing.cacheWriteMicroUsdPerMillion > pricing.inputMicroUsdPerMillion);
  const guard = new WorkBudgetGuard({ budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, pricing });
  guard.record({ inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 });
  assert.equal(guard.usage.costMicroUsd, pricing.cacheWriteMicroUsdPerMillion);
  const plain = new WorkBudgetGuard({
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
    pricing: { inputMicroUsdPerMillion: 3_000_000, outputMicroUsdPerMillion: 15_000_000 },
  });
  plain.record({ inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 1_000_000 });
  assert.equal(plain.usage.costMicroUsd, 3_000_000, "no write rate means the input rate, as before");
});

// ── Voice relay delegates ──────────────────────────────────────────────────

test("voice: the Gemini Live backend delegate is priced from its usage", () => {
  // 10k in at $1.50/M + 1k out + 2k thoughts at $7.50/M + one grounded search.
  const usd = geminiDelegateCostUsd({ promptTokens: 10_000, outputTokens: 1_000, thoughtsTokens: 2_000, grounded: true });
  assert.ok(Math.abs(usd - (0.015 + 0.0225 + 0.014)) < 1e-9);
  // No usage: the character floor, never zero for a request that was sent.
  assert.ok(geminiDelegateCostUsd({ promptChars: 4_000, answerChars: 0 }) > 0);
});

test("voice: a GPT-Live delegation is charged an effort-scaled estimate, topped up by usage", () => {
  const low = gptLiveDelegationEstimateUsd("low", true);
  const xhigh = gptLiveDelegationEstimateUsd("xhigh", true);
  assert.ok(low > 0.01 && xhigh > low);
  assert.equal(gptLiveDelegationUsageUsd(null), null);
  assert.ok(Math.abs(gptLiveDelegationUsageUsd({ input_tokens: 1_000_000, output_tokens: 0 }, 1)! - 2.01) < 1e-9);
});
