import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPromptComplexity,
  isAutoModelId,
  pickAutoReasoningEffort,
  AUTO_MODEL_ID,
} from "../src/lib/auto-model";
import type { ModelInfo } from "../src/lib/models";

function fakeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: "openai:gpt-5.4-mini",
    provider: "openai",
    providerModel: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    minPlan: "FREE",
    vision: true,
    reasoning: true,
    cost: 1,
    modality: "chat",
    webSearch: false,
    status: "current",
    ...overrides,
  };
}

describe("auto-model", () => {
  it("recognizes the Auto sentinel", () => {
    assert.equal(isAutoModelId(AUTO_MODEL_ID), true);
    assert.equal(isAutoModelId("auto"), true);
    assert.equal(isAutoModelId("anthropic:claude-sonnet-5"), false);
  });

  it("classifies short chit-chat as simple", () => {
    const r = classifyPromptComplexity("hey, what's 2+2?");
    assert.equal(r.level, "simple");
    assert.ok(r.minIntelligence <= 5);
  });

  it("classifies multi-step coding as hard or expert", () => {
    const r = classifyPromptComplexity(
      [
        "Implement a production-ready distributed task queue from scratch.",
        "```ts",
        "export class Worker {}",
        "```",
        "Cover race conditions, retries, and a formal correctness argument.",
      ].join("\n")
    );
    assert.ok(r.level === "hard" || r.level === "expert", r.level);
    assert.ok(r.minIntelligence >= 8);
  });

  it("classifies medium analysis requests as medium+", () => {
    const r = classifyPromptComplexity(
      "Compare and contrast React Server Components vs client components for a multi-step dashboard redesign. " +
        "Walk through the trade-offs and propose an architecture."
    );
    assert.ok(r.level === "medium" || r.level === "hard" || r.level === "expert", r.level);
  });

  it("picks Instant thinking for simple prompts on models that can disable", () => {
    const complexity = classifyPromptComplexity("hi");
    const effort = pickAutoReasoningEffort(fakeModel({ providerModel: "gpt-5.4-mini" }), complexity);
    // gpt-5.4-mini typically allows Instant (null) for simple asks
    assert.ok(effort === null || effort === "minimal" || effort === "low", String(effort));
  });

  it("picks deeper thinking for expert prompts", () => {
    const complexity = classifyPromptComplexity(
      "Architect a formal distributed consensus protocol with proofs of safety and liveness, " +
        "implement a production-ready multi-step agent pipeline, and rigorously debug race conditions."
    );
    const effort = pickAutoReasoningEffort(fakeModel({ providerModel: "gpt-5.6-sol" }), complexity);
    assert.ok(effort === "high" || effort === "xhigh" || effort === "max" || effort === "medium", String(effort));
  });
});
