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
    agenticTools: true,
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

  it("classifies French multi-step technical work like its English twin", () => {
    // The regression this pins: English-only wordlists scored this "simple"
    // and routed a refactoring brief to the cheapest model.
    const fr = classifyPromptComplexity(
      "Refactorise ce service distribué étape par étape : analyse les conditions de course, " +
        "propose une architecture cible, puis implémente la migration de bout en bout."
    );
    assert.ok(fr.level === "hard" || fr.level === "expert", fr.level);
    assert.ok(fr.minIntelligence >= 8);
  });

  it("classifies Japanese architecture work well above simple", () => {
    const ja = classifyPromptComplexity(
      "分散システムのアーキテクチャを設計してください。並行処理の競合状態を分析し、" +
        "段階的に移行計画を立てて、本番環境向けに実装してください。"
    );
    assert.notEqual(ja.level, "simple");
    assert.ok(ja.minIntelligence >= 6);
  });

  it("keeps short non-English chit-chat simple", () => {
    assert.equal(classifyPromptComplexity("Bonjour, ça va ?").level, "simple");
    assert.equal(classifyPromptComplexity("こんにちは！元気ですか？").level, "simple");
  });

  it("routes uncovered languages up on structure, never down on vocabulary", () => {
    // Finnish has no wordlist here: the question count, the requirements list
    // and the length must carry it off the cheapest tier on their own.
    const r = classifyPromptComplexity(
      [
        "Selitä yksityiskohtaisesti seuraavat asiat hajautetuista järjestelmistä:",
        "- Miten järjestelmä pysyy yhtenäisenä vikatilanteissa?",
        "- Mitkä ovat eri konsensusalgoritmien keskeiset erot käytännössä?",
        "- Miten suunnittelisit varmuuskopioinnin ja palautumisen?",
        "1. Vertaile vaihtoehtoja huolellisesti",
        "2. Perustele jokainen valintasi esimerkein",
        "3. Anna lopuksi suositus perusteluineen",
      ].join("\n")
    );
    assert.notEqual(r.level, "simple");
    assert.ok(r.minIntelligence >= 6, `intelligence floor ${r.minIntelligence}`);
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
