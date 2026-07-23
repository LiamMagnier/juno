import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelGeneration, sortModelsForDisplay } from "../src/lib/model-metrics";
import type { ModelInfo } from "../src/lib/models";

/** Synthetic ids on purpose: they miss the BENCHMARKS table, so `intelligence`
 *  falls out of `cost` alone and the power tiebreak stays deterministic. */
function model(name: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: `test:${name.toLowerCase().replace(/\s+/g, "-")}`,
    provider: "openai",
    providerModel: name,
    name,
    minPlan: "FREE",
    vision: true,
    reasoning: false,
    cost: 2,
    modality: "chat",
    webSearch: false,
    status: "current",
    ...overrides,
  };
}

const names = (list: ModelInfo[]) => list.map((m) => m.name);

describe("modelGeneration", () => {
  it("reads the first version in a display name", () => {
    assert.equal(modelGeneration("GPT-5.6 Sol"), 5.6);
    assert.equal(modelGeneration("Gemini 3.6 Flash"), 3.6);
    assert.equal(modelGeneration("Claude Opus 4.8"), 4.8);
    assert.equal(modelGeneration("Kimi K3"), 3);
    assert.equal(modelGeneration("Qwen3.8 Max Preview"), 3.8);
  });

  it("returns null when the name carries no version", () => {
    assert.equal(modelGeneration("Nano Banana Pro"), null);
    assert.equal(modelGeneration("Gemini Omni Flash"), null);
  });
});

describe("sortModelsForDisplay", () => {
  it("orders a lab by generation, newest first, regardless of ship date", () => {
    // GPT-5.3 Codex shipped AFTER the 5.4 line — a date-first sort put it above
    // 5.4, which is the bug this ordering exists to prevent.
    const sorted = sortModelsForDisplay([
      model("GPT-5.3 Codex", { released: "2026-04", cost: 3 }),
      model("GPT-5.4 Mini", { released: "2026-03", cost: 1 }),
      model("GPT-5.5 Pro", { released: "2026-06", cost: 3 }),
      model("GPT-5.6 Sol", { released: "2026-07", cost: 3 }),
    ]);
    assert.deepEqual(names(sorted), ["GPT-5.6 Sol", "GPT-5.5 Pro", "GPT-5.4 Mini", "GPT-5.3 Codex"]);
  });

  it("orders one generation's siblings by power", () => {
    const sorted = sortModelsForDisplay([
      model("GPT-5.6 Luna", { released: "2026-07", cost: 1 }),
      model("GPT-5.6 Sol", { released: "2026-07", cost: 3 }),
      model("GPT-5.6 Terra", { released: "2026-07", cost: 2 }),
    ]);
    assert.deepEqual(names(sorted), ["GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna"]);
  });

  it("floats a newly discovered model that has no release date", () => {
    // Discovered models carry a name but no `released`; under a date-first sort
    // this sank below every dated sibling instead of leading the lab.
    const sorted = sortModelsForDisplay([
      model("Gemini 3.5 Flash", { provider: "google", released: "2026-06", cost: 2 }),
      model("Gemini 3.1 Pro", { provider: "google", released: "2026-04", cost: 3 }),
      model("Gemini 3.6 Flash", { provider: "google", released: undefined, cost: 2 }),
    ]);
    assert.deepEqual(names(sorted), ["Gemini 3.6 Flash", "Gemini 3.5 Flash", "Gemini 3.1 Pro"]);
  });

  it("falls back to release date when a name carries no version", () => {
    const sorted = sortModelsForDisplay([
      model("Nano Banana Pro", { provider: "google", released: "2025-11", cost: 3 }),
      model("Nano Banana 2", { provider: "google", released: "2026-04", cost: 2 }),
    ]);
    assert.deepEqual(names(sorted), ["Nano Banana 2", "Nano Banana Pro"]);
  });

  it("keeps current models ahead of superseded ones", () => {
    const sorted = sortModelsForDisplay([
      model("GPT-5.9 Old", { released: "2026-07", status: "legacy", legacy: true }),
      model("GPT-5.1 Live", { released: "2026-01", status: "current" }),
    ]);
    assert.deepEqual(names(sorted), ["GPT-5.1 Live", "GPT-5.9 Old"]);
  });

  it("groups by lab before anything else, and does not mutate the input", () => {
    const input = [
      model("Gemini 3.5 Flash", { provider: "google" }),
      model("GPT-5.6 Sol", { provider: "openai" }),
    ];
    const before = names(input);
    const sorted = sortModelsForDisplay(input);
    assert.deepEqual(names(sorted), ["GPT-5.6 Sol", "Gemini 3.5 Flash"]);
    assert.deepEqual(names(input), before, "input array must not be mutated");
  });
});
