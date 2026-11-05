import test from "node:test";
import assert from "node:assert/strict";
import { buildUsage, usageBasisOf } from "@/lib/chat-usage";
import type { ModelInfo } from "@/lib/models";

/*
 * The basis of a private turn's receipt (`ClientMessage.applied.usageBasis`):
 * "reported" only when every billed count is the provider's own number, so the
 * comparison never labels a characters/4 guess as a reported cost.
 */

const model = {
  id: "anthropic:claude-sonnet-5",
  provider: "anthropic",
  providerModel: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  reasoning: true,
  modality: "chat",
} as unknown as ModelInfo;
const openai = { ...model, id: "openai:test", provider: "openai", providerModel: "test" } as ModelInfo;

test("provider-reported prompt and completion counts are reported", () => {
  assert.equal(buildUsage(model, { input: 1_000, output: 200, promptChars: 4_000, completionChars: 800 }).basis, "reported");
});

test("a stream with no usage at all is billed from characters, an estimate", () => {
  const usage = buildUsage(model, { promptChars: 4_000, completionChars: 800 });
  assert.ok(usage.cost > 0);
  assert.equal(usage.basis, "estimated");
});

test("a missing prompt count filled from characters is an estimate", () => {
  assert.equal(buildUsage(openai, { output: 200, promptChars: 4_000, completionChars: 100 }).basis, "estimated");
});

test("a character floor that lifts the output above the reported count is an estimate", () => {
  // 40,000 streamed characters ≈ 10,000 tokens, far above the 50 reported.
  const usage = buildUsage(openai, { input: 1_000, output: 50, promptChars: 4_000, completionChars: 40_000 });
  assert.equal(usage.output, 10_000);
  assert.equal(usage.basis, "estimated");
});

test("reasoning or total reported above the completion count is still the provider's number", () => {
  assert.equal(buildUsage(openai, { input: 1_000, output: 100, reasoning: 900, completionChars: 400 }).basis, "reported");
  assert.equal(buildUsage(openai, { input: 1_000, output: 100, total: 2_000, completionChars: 400 }).basis, "reported");
});

test("a fully cached Anthropic turn (zero fresh input) is reported, not estimated", () => {
  assert.equal(buildUsage(model, { input: 0, output: 100, cacheRead: 90_000, promptChars: 360_000, completionChars: 300 }).basis, "reported");
  assert.equal(usageBasisOf({ output: 100, cacheRead: 90_000 }, { promptTokens: 0, completionTokens: 100 }), "reported");
});

test("an empty generation with nothing billed is not called an estimate", () => {
  assert.equal(usageBasisOf({}, { promptTokens: 0, completionTokens: 0 }), "reported");
});
