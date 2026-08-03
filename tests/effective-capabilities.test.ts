import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_MANIFEST_VERSION,
  degradationSummary,
  reasoningRank,
  resolveEffectiveCapabilities,
  wasDegraded,
  type ModelCapabilities,
} from "@/lib/effective-capabilities";

/*
 * Juno degrades a turn in several places — reasoning clamped, search dropped,
 * fast mode ignored, the model swapped under a budget ceiling — and every one
 * of them was invisible. The reply came back and nothing said it had been
 * answered by a different model, at a lower effort, with search off.
 */

const full: ModelCapabilities = {
  modelId: "claude-opus-5",
  provider: "anthropic",
  reasoning: true,
  maxReasoning: "max",
  webSearch: true,
  fastMode: true,
  vision: true,
  connectors: true,
};

const modest: ModelCapabilities = {
  modelId: "tiny-chat",
  provider: "deepseek",
  reasoning: false,
  maxReasoning: null,
  webSearch: false,
  fastMode: false,
  vision: false,
  connectors: false,
};

test("a request the model can satisfy reports no degradation", () => {
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: full.modelId, reasoning: "high", webSearch: true, fastMode: true },
    actual: full,
  });

  assert.equal(effective.reasoning, "high");
  assert.equal(effective.webSearch, true);
  assert.equal(effective.fastMode, true);
  assert.equal(wasDegraded(effective), false);
  assert.equal(degradationSummary(effective), null, "nothing to store when nothing changed");
});

test("reasoning above the model's ceiling is clamped and said so", () => {
  const capped: ModelCapabilities = { ...full, maxReasoning: "medium" };
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: capped.modelId, reasoning: "max" },
    actual: capped,
  });

  assert.equal(effective.reasoning, "medium");
  const degradation = effective.degradations.find((d) => d.kind === "reasoning_clamped");
  assert.equal(degradation?.requested, "max");
  assert.equal(degradation?.effective, "medium");
  assert.match(String(degradation?.reason), /accepts at most medium/);
});

test("reasoning below the ceiling is honoured exactly", () => {
  const capped: ModelCapabilities = { ...full, maxReasoning: "high" };
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: capped.modelId, reasoning: "low" },
    actual: capped,
  });
  assert.equal(effective.reasoning, "low");
  assert.equal(wasDegraded(effective), false);
});

test("asking a non-reasoning model to think is reported, not silently ignored", () => {
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: modest.modelId, reasoning: "high" },
    actual: modest,
  });
  assert.equal(effective.reasoning, null);
  assert.equal(effective.degradations[0].kind, "reasoning_unsupported");
});

test("web search off by model and off by plan are different sentences", () => {
  const byModel = resolveEffectiveCapabilities({
    requested: { modelId: modest.modelId, webSearch: true },
    actual: modest,
  });
  assert.match(String(byModel.degradations[0].reason), /cannot search the web/);

  const byPlan = resolveEffectiveCapabilities({
    requested: { modelId: full.modelId, webSearch: true },
    actual: full,
    planAllowsWebSearch: false,
  });
  assert.match(String(byPlan.degradations[0].reason), /not included in this plan/);
  assert.equal(byPlan.webSearch, false);
});

test("a model swapped under a budget ceiling is the first thing recorded", () => {
  // The degradation users notice in the bill, so it must not be buried behind
  // the incidental ones the swap itself caused.
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: "claude-opus-5", reasoning: "max", webSearch: true },
    actual: modest,
    substitutedFrom: {
      modelId: "claude-opus-5",
      reason: "The platform budget was exhausted, so a cheaper model answered.",
    },
  });

  assert.equal(effective.degradations[0].kind, "model_substituted");
  assert.equal(effective.degradations[0].requested, "claude-opus-5");
  assert.equal(effective.degradations[0].effective, "tiny-chat");
  // And the knock-on losses are recorded too, rather than only the swap.
  const kinds = effective.degradations.map((d) => d.kind);
  assert.ok(kinds.includes("reasoning_unsupported"));
  assert.ok(kinds.includes("web_search_unavailable"));
});

test("a substitution that did not actually change the model is not reported", () => {
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: full.modelId },
    actual: full,
    substitutedFrom: { modelId: full.modelId, reason: "considered but not applied" },
  });
  assert.equal(wasDegraded(effective), false);
});

test("fast mode and vision report separately", () => {
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: modest.modelId, fastMode: true, vision: true },
    actual: modest,
  });
  const kinds = effective.degradations.map((d) => d.kind);
  assert.ok(kinds.includes("fast_mode_unavailable"));
  assert.ok(kinds.includes("vision_unavailable"));
});

test("connectors are gated by model capability and by plan", () => {
  const byModel = resolveEffectiveCapabilities({
    requested: { modelId: modest.modelId, connectors: ["github"] },
    actual: modest,
  });
  assert.match(String(byModel.degradations[0].reason), /does not support tool calling/);

  const byPlan = resolveEffectiveCapabilities({
    requested: { modelId: full.modelId, connectors: ["github", "figma"] },
    actual: full,
    planAllowsConnectors: false,
  });
  assert.equal(byPlan.connectors, false);
  assert.match(String(byPlan.degradations[0].requested), /2 connector/);
});

test("an empty connector list is not a request, so it cannot degrade", () => {
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: modest.modelId, connectors: [] },
    actual: modest,
  });
  assert.equal(wasDegraded(effective), false);
});

test("an unrecognised reasoning level ranks lowest, never highest", () => {
  // A value from a newer build must not be read as permission to run at max.
  assert.equal(reasoningRank("nonsense" as never), reasoningRank("minimal"));
  assert.ok(reasoningRank("max") > reasoningRank("high"));
});

test("the stored summary carries the version, so an older reader can tell", () => {
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: modest.modelId, webSearch: true },
    actual: modest,
  });
  const summary = degradationSummary(effective);
  assert.equal(summary?.version, CAPABILITY_MANIFEST_VERSION);
  assert.equal(summary?.model, "tiny-chat");
  assert.equal(summary?.degradations.length, 1);
});
