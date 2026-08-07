import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { MODEL_LIST } from "@/lib/models";
import type { ModelInfo } from "@/lib/models";

/*
 * GPT-5.6's "pro" is a MODE, not a deeper effort tier.
 *
 * Every earlier generation shipped Pro as its own model id (gpt-5.5-pro), at its
 * own much higher price. On 5.6 it is `reasoning.mode: "pro"` on the same id at
 * the same per-token rate, and it composes with `reasoning.effort` rather than
 * replacing it. Conflating the two is the expensive mistake in both directions:
 * treating pro as a tier would put it on the thinking slider (where picking it
 * on a 5.5 model would 400), and treating it as a separate model would send
 * users to a line that costs 6x as much for the same work.
 */

function fake(providerModel: string, provider: ModelInfo["provider"] = "openai"): ModelInfo {
  return {
    id: `${provider}:${providerModel}`,
    provider,
    providerModel,
    name: providerModel,
    minPlan: "PRO",
    vision: true,
    reasoning: true,
    agenticTools: true,
    cost: 2,
    modality: "chat",
    webSearch: false,
    status: "current",
  };
}

describe("pro mode", () => {
  it("is offered on the whole GPT-5.6 line, including the bare alias", () => {
    assert.equal(supportsProMode(fake("gpt-5.6-sol")), true);
    assert.equal(supportsProMode(fake("gpt-5.6-terra")), true);
    assert.equal(supportsProMode(fake("gpt-5.6-luna")), true);
    assert.equal(supportsProMode(fake("gpt-5.6")), true);
  });

  it("is NOT offered on the generations where Pro is its own model id", () => {
    // Asking for reasoning.mode here is a 400: these ids ARE the pro model, and
    // the mode parameter does not exist on their generation.
    assert.equal(supportsProMode(fake("gpt-5.5-pro")), false);
    assert.equal(supportsProMode(fake("gpt-5.4-pro")), false);
    assert.equal(supportsProMode(fake("gpt-5.2-pro")), false);
    assert.equal(supportsProMode(fake("gpt-5.5")), false);
    assert.equal(supportsProMode(fake("gpt-5.3-codex")), false);
    assert.equal(supportsProMode(fake("gpt-4o")), false);
  });

  it("never leaks to another provider that happens to say 'pro'", () => {
    assert.equal(supportsProMode(fake("gemini-3.1-pro-preview", "google")), false);
    assert.equal(supportsProMode(fake("deepseek-v4-pro", "deepseek")), false);
  });

  it("stays orthogonal to the effort ladder on every model that has it", () => {
    // The mode must not consume a tier: 5.6 keeps its full none..max ladder, and
    // a pro turn picks a point on that ladder rather than replacing it.
    for (const model of MODEL_LIST.filter((m) => supportsProMode(m))) {
      const caps = reasoningCaps(model);
      assert.ok(caps.tiers.includes("max"), `${model.id} should keep its max tier`);
      assert.ok(caps.tiers.includes("medium"), `${model.id} should keep its medium tier`);
      assert.equal(caps.canDisable, true, `${model.id} should still offer Instant`);
      assert.equal(caps.onOff, false, `${model.id} is a ladder, not an on/off toggle`);
    }
  });

  it("covers every catalog model the GPT-5.6 family registers", () => {
    // Guards the registry side rather than the predicate: a 5.6 tier added later
    // (a "gpt-5.6-nova") must not silently ship without pro.
    const family = MODEL_LIST.filter(
      (m) => m.provider === "openai" && m.providerModel.toLowerCase().includes("gpt-5.6")
    );
    assert.ok(family.length >= 3, "expected at least Sol, Terra and Luna in the catalog");
    for (const m of family) {
      assert.equal(supportsProMode(m), true, `${m.id} is GPT-5.6 and should offer pro mode`);
    }
  });
});
