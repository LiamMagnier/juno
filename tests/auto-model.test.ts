import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPromptComplexity, isAutoModelId, AUTO_MODEL_ID } from "../src/lib/auto-model";

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
});
