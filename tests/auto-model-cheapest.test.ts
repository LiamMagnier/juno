/**
 * Auto routes easy questions to cheap models (docs/pricing/COST_ENGINEERING.md
 * §4): for every prompt, no eligible model that clears the prompt's
 * intelligence floor is cheaper than the one Auto picked, and an everyday
 * question lands on a cost-1 model whenever the plan has one.
 *
 * Kept apart from tests/auto-model.test.ts so it pins the invariant without
 * touching the low-budget behaviour another change owns.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPromptComplexity, pickAutoModel } from "../src/lib/auto-model";
import { MODEL_LIST, trainsOnPrompts, type ModelInfo } from "../src/lib/models";
import { averageRequestCostMicroUsd, getModelMetrics } from "../src/lib/model-metrics";
import { canUseModel } from "../src/lib/plans";
import { PROVIDERS, PROVIDER_LIST } from "../src/lib/providers";
import type { Plan } from "@prisma/client";

const saved = new Map<string, string | undefined>();
before(() => {
  // Every provider configured, so the whole catalogue competes on price.
  for (const provider of PROVIDER_LIST) {
    const name = PROVIDERS[provider].apiKeyEnv;
    saved.set(name, process.env[name]);
    process.env[name] = "test-key";
  }
});
after(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The pool `pickAutoModel` ranks, restated: current, callable, not a training tier, above the floor. */
function capablePool(plan: Plan, floor: number): ModelInfo[] {
  return MODEL_LIST.filter(
    (m) =>
      m.modality === "chat" &&
      !m.comingSoon &&
      m.status !== "deprecated" &&
      (m.status === "current" || !m.status) &&
      !trainsOnPrompts(m) &&
      canUseModel(plan, m.id) &&
      getModelMetrics(m).intelligence >= floor
  );
}

const PROMPTS = [
  "hey, what's the capital of Portugal?",
  "translate 'good morning' into German",
  "summarise the pros and cons of renting vs buying a flat in three bullet points",
  "Refactor this TypeScript module into smaller functions, add tests, and explain the architecture trade-offs step by step:\n```ts\nexport function a() {}\n```",
];

describe("Auto picks the cheapest capable model", () => {
  for (const plan of ["FREE", "PRO"] as Plan[]) {
    for (const prompt of PROMPTS) {
      it(`${plan}: nothing capable is cheaper — ${prompt.slice(0, 40)}`, () => {
        const picked = pickAutoModel({ message: prompt, plan });
        const complexity = classifyPromptComplexity(prompt);
        const pool = capablePool(plan, complexity.minIntelligence);
        if (pool.length === 0) return; // nothing clears the floor: Auto falls back, not this invariant
        const cheapest = Math.min(...pool.map((m) => averageRequestCostMicroUsd(m)));
        assert.ok(
          averageRequestCostMicroUsd(picked.model) <= cheapest,
          `${picked.model.id} costs ${averageRequestCostMicroUsd(picked.model)} but a capable model costs ${cheapest}`
        );
      });
    }
  }

  it("an everyday question goes to a cost-1 model when the plan has one", () => {
    const picked = pickAutoModel({ message: "what's a good name for a goldfish?", plan: "PRO" });
    assert.equal(classifyPromptComplexity("what's a good name for a goldfish?").level, "simple");
    const hasCostOne = capablePool("PRO", 4).some((m) => m.cost === 1);
    if (hasCostOne) assert.equal(picked.model.cost, 1, `picked ${picked.model.id}`);
  });

  it("an easy question never costs more than a hard one", () => {
    const easy = pickAutoModel({ message: "hi! how are you?", plan: "PRO" });
    const hard = pickAutoModel({ message: PROMPTS[3], plan: "PRO" });
    assert.ok(averageRequestCostMicroUsd(easy.model) <= averageRequestCostMicroUsd(hard.model));
  });

  it("an easy question runs without extra thinking where the model allows it", () => {
    const picked = pickAutoModel({ message: "hey there", plan: "PRO" });
    if (picked.model.reasoning && picked.reasoningEffort !== null) {
      // Always-on thinkers get their lowest tier, never more.
      assert.notEqual(picked.reasoningEffort, "high");
      assert.notEqual(picked.reasoningEffort, "max");
    }
  });
});
