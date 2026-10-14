import assert from "node:assert/strict";
import test from "node:test";

import { geminiThinkingConfig } from "@/lib/gemini-core";
import { getModelMetrics, reasoningCaps } from "@/lib/model-metrics";
import { MODEL_LIST } from "@/lib/models";
import { tokenRate } from "@/lib/pricing";
import { VOICE_PROVIDERS, VOICE_PROVIDER_MODELS, voiceModelLabel } from "@/lib/voice-relay-protocol";

/*
 * The models the owner asked for on 2026-10-14, each checked against the page
 * it was read from:
 *  - Gemini 4 Argon: ai.google.dev/gemini-api/docs/models/gemini-4-argon,
 *    /thinking and /pricing
 *  - Muse Wonder 1.0: dev.meta.ai/docs/models and /docs/pricing-rate-limits
 *  - Grok Voice 3.0 (voice relay): docs.x.ai voice-agent page and /models
 */

const BEFORE_DEC_1 = Date.UTC(2026, 10, 30, 23, 59);
const FROM_DEC_1 = Date.UTC(2026, 11, 1);

test("Gemini 4 Argon: its own current row, $2/$10 until Dec 1 then $4/$20, cache at 5%", () => {
  const argon = MODEL_LIST.find((m) => m.id === "google:gemini-4-argon");
  assert.ok(argon);
  assert.equal(argon.providerModel, "gemini-4-argon");
  assert.equal(argon.status, "current");
  assert.equal(argon.minPlan, "PRO", "not on Google's free tier");
  assert.equal(argon.contextWindow, 1_048_576);
  const intro = tokenRate(argon, false, BEFORE_DEC_1);
  assert.deepEqual([intro.input, intro.output, intro.cacheRead], [2, 10, 0.1]);
  const later = tokenRate(argon, false, FROM_DEC_1);
  assert.deepEqual([later.input, later.output, later.cacheRead], [4, 20, 0.2]);
  assert.equal(getModelMetrics(argon, BEFORE_DEC_1).inputUsdPerMTok, 2);
  assert.equal(getModelMetrics(argon, FROM_DEC_1).outputUsdPerMTok, 20);
});

test("Gemini 4 Argon thinks low|medium|high, default medium, sent as a thinking level", () => {
  const argon = MODEL_LIST.find((m) => m.id === "google:gemini-4-argon")!;
  const caps = reasoningCaps(argon);
  assert.deepEqual(caps.tiers, ["low", "medium", "high"]);
  assert.equal(caps.canDisable, false);
  assert.equal(caps.defaultLevel, "medium");
  assert.deepEqual(geminiThinkingConfig(argon, "high"), { includeThoughts: true, thinkingLevel: "HIGH" });
});

test("Muse Wonder 1.0: $4/$20 (cached $0.20), 1M, minimal..max, and Spark keeps its own price", () => {
  const wonder = MODEL_LIST.find((m) => m.id === "meta:muse-wonder-1.0");
  assert.ok(wonder);
  assert.equal(wonder.status, "current");
  assert.equal(wonder.contextWindow, 1_048_576);
  assert.notEqual(wonder.trainsOnPrompts, true, "Wonder has no contributor tier");
  const rate = tokenRate(wonder);
  assert.deepEqual([rate.input, rate.output], [4, 20]);
  assert.ok(Math.abs(rate.cacheRead - 0.2) < 1e-9);
  assert.deepEqual(reasoningCaps(wonder).tiers, ["minimal", "low", "medium", "high", "xhigh", "max"]);
  const spark = MODEL_LIST.find((m) => m.id === "meta:muse-spark-1.3")!;
  assert.deepEqual([tokenRate(spark).input, tokenRate(spark).output], [1.25, 4.25]);
});

test("Grok Voice 3.0 is offered in the voice switcher under its published name", () => {
  assert.ok(VOICE_PROVIDERS.includes("xai"));
  assert.equal(VOICE_PROVIDER_MODELS.xai, "grok-voice-3.0");
  assert.equal(voiceModelLabel(VOICE_PROVIDER_MODELS.xai), "Grok Voice 3.0");
});
