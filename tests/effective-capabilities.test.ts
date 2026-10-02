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
  proMode: true,
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
  proMode: false,
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

test("pro mode on a model without one is reported, not silently dropped", () => {
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: modest.modelId, proMode: true },
    actual: modest,
  });

  assert.equal(effective.proMode, false);
  const d = effective.degradations.find((x) => x.kind === "pro_mode_unavailable");
  assert.ok(d, "asking for pro on a model that has none must be recorded");
  assert.equal(d.effective, "off");
});

test("pro mode and reasoning effort are independent axes", () => {
  // The whole point of modelling pro as a mode rather than a deeper tier: a turn
  // can run pro at a modest effort, and neither choice clamps the other.
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: full.modelId, proMode: true, reasoning: "low" },
    actual: full,
  });

  assert.equal(effective.proMode, true);
  assert.equal(effective.reasoning, "low");
  assert.equal(wasDegraded(effective), false);
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

/*
 * v4: code execution (TOOL_RUNTIME_DESIGN.md §6.11). Two different refusals
 * with two different fixes: an unverified model (choose another model) and no
 * sandbox for this chat (nothing the model can change). The model's evidence
 * is checked first, so the reader is never sent to the wrong fix.
 */

test("code execution runs only on a verified model with an open gate", () => {
  const verified = { ...full, toolCalling: "verified" as const };
  const ok = resolveEffectiveCapabilities({
    requested: { modelId: verified.modelId, codeExecution: true },
    actual: verified,
    codeExecutionGate: { allowed: true },
  });
  assert.equal(ok.codeExecution, true);
  assert.equal(wasDegraded(ok), false);
});

test("an untested or failed model is tool_calling_unverified, whatever the sandbox", () => {
  for (const toolCalling of [undefined, "untested", "failed"] as const) {
    const effective = resolveEffectiveCapabilities({
      requested: { modelId: full.modelId, codeExecution: true },
      actual: { ...full, ...(toolCalling ? { toolCalling } : {}) },
      codeExecutionGate: { allowed: true },
    });
    assert.equal(effective.codeExecution, false);
    assert.deepEqual(effective.degradations.map((d) => d.kind), ["tool_calling_unverified"]);
    assert.match(effective.degradations[0].reason, /Choose a model whose tool calling is verified/);
  }
});

test("a verified model with no sandbox for this chat is code_execution_unavailable, with the gate's reason", () => {
  const effective = resolveEffectiveCapabilities({
    requested: { modelId: full.modelId, codeExecution: true },
    actual: { ...full, toolCalling: "verified" },
    codeExecutionGate: { allowed: false, reason: "Running code is off in private chats." },
  });
  assert.equal(effective.codeExecution, false);
  assert.deepEqual(effective.degradations.map((d) => d.kind), ["code_execution_unavailable"]);
  assert.equal(effective.degradations[0].reason, "Running code is off in private chats.");
  const noGate = resolveEffectiveCapabilities({
    requested: { modelId: full.modelId, codeExecution: true },
    actual: { ...full, toolCalling: "verified" },
  });
  assert.equal(noGate.degradations[0].kind, "code_execution_unavailable", "no gate given means no sandbox");
});

test("not asking for code execution never degrades", () => {
  const effective = resolveEffectiveCapabilities({ requested: { modelId: full.modelId }, actual: full });
  assert.equal(effective.codeExecution, false);
  assert.equal(wasDegraded(effective), false);
});

test("the manifest and the TypeScript union name the same degradation kinds", async () => {
  const manifest = (await import("../contracts/capabilities/juno-capabilities-v1.json", { with: { type: "json" } })).default as {
    version: number;
    degradationKinds: { key: string }[];
    capabilities: { key: string }[];
  };
  assert.equal(manifest.version, CAPABILITY_MANIFEST_VERSION);
  const keys = manifest.degradationKinds.map((k) => k.key);
  for (const kind of ["code_execution_unavailable", "tool_calling_unverified"]) assert.ok(keys.includes(kind), kind);
  assert.ok(manifest.capabilities.some((c) => c.key === "codeExecution"));
});
