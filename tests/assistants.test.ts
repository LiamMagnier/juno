import { test } from "node:test";
import assert from "node:assert/strict";
import { type JunoAssistantConfig } from "../src/lib/assistants";

test("JunoAssistantConfig correctly structures assistant metadata and prompt configuration", () => {
  const assistant: JunoAssistantConfig = {
    id: "test-ast-1",
    userId: "user-123",
    slug: "quant-analyst",
    name: "Quantitative Financial Analyst",
    description: "Analyzes financial reports, performs valuation models and DCF simulations.",
    avatarIcon: "sparkles",
    systemPrompt: "You are a quantitative financial analyst. Always provide rigorous calculations and clear tables.",
    starterPrompts: [
      "Analyze this company's 10-K filing",
      "Build a 5-year discounted cash flow model",
    ],
    allowedTools: ["python_interpreter", "browser_agent"],
    preferredModelId: "anthropic:claude-opus-4-8",
    reasoningEffort: "high",
    isPinned: true,
    isPublic: false,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.equal(assistant.name, "Quantitative Financial Analyst");
  assert.equal(assistant.starterPrompts.length, 2);
  assert.equal(assistant.allowedTools?.length, 2);
  assert.ok(assistant.allowedTools?.includes("python_interpreter"));
  assert.equal(assistant.reasoningEffort, "high");
  assert.equal(assistant.isPinned, true);
});
