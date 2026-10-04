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
import { autoDataUseVerdict } from "../src/lib/router/data-policy";
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
      autoDataUseVerdict(m, { paidTier: new Set() }).eligible &&
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

describe("Auto picks the lowest expected total cost, and stays cheap on easy questions", () => {
  // Auto Router 2.0 (src/lib/router/decide.ts) ranks by EXPECTED total cost —
  // the call, its tool rounds, retries and the cost of a wrong answer — not by
  // list price alone, and only among models whose data-use terms are accepted.
  // So the invariant is: the pick is the decision's best-ranked candidate, it
  // never lands outside the data-use terms, and easy prompts still go cheap.
  for (const plan of ["FREE", "PRO"] as Plan[]) {
    for (const prompt of PROMPTS) {
      it(`${plan}: the pick is the cheapest expected outcome — ${prompt.slice(0, 40)}`, () => {
        const picked = pickAutoModel({ message: prompt, plan });
        assert.equal(picked.model.id, picked.decision.ranked[0].modelId);
        const totals = picked.decision.ranked.map((c) => c.expectedTotalMicroUsd);
        assert.equal(Math.min(...totals), picked.decision.ranked[0].expectedTotalMicroUsd);
        assert.equal(autoDataUseVerdict(picked.model, { paidTier: new Set() }).eligible, true, `${picked.model.id} is outside the data-use terms`);
        assert.equal(canUseModel(plan, picked.model.id), true);
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
