import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicThinkingKind,
  buildAnthropicThinkingBits,
} from "@/lib/anthropic-thinking";

/** Every Anthropic model currently selectable in Juno. */
const JUNO_ANTHROPIC_MODELS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
] as const;

const ADAPTIVE = new Set([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-6",
]);

const MANUAL = new Set([
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
]);

test("anthropicThinkingKind maps every Juno Claude model correctly", () => {
  for (const id of JUNO_ANTHROPIC_MODELS) {
    const kind = anthropicThinkingKind(id);
    if (ADAPTIVE.has(id)) assert.equal(kind, "adaptive", id);
    else if (MANUAL.has(id)) assert.equal(kind, "manual", id);
    else assert.fail(`unclassified model ${id}`);
  }
});

test("sonnet-4-5 is manual; sonnet-5 is adaptive (no substring collision)", () => {
  assert.equal(anthropicThinkingKind("claude-sonnet-4-5"), "manual");
  assert.equal(anthropicThinkingKind("claude-sonnet-5"), "adaptive");
  assert.equal(anthropicThinkingKind("claude-sonnet-4-6"), "adaptive");
});

test("adaptive models never emit type:enabled when thinking is requested", () => {
  for (const id of ADAPTIVE) {
    const bits = buildAnthropicThinkingBits(id, 8192, "high");
    assert.ok(bits.thinking, id);
    assert.equal(bits.thinking!.type, "adaptive", id);
    assert.equal(bits.outputConfig?.effort, "high", id);
    assert.notEqual((bits.thinking as { type: string }).type, "enabled", id);
  }
});

test("manual models use type:enabled + budget_tokens", () => {
  for (const id of MANUAL) {
    const bits = buildAnthropicThinkingBits(id, 8192, "high");
    assert.ok(bits.thinking, id);
    assert.equal(bits.thinking!.type, "enabled", id);
    if (bits.thinking!.type === "enabled") {
      assert.ok(bits.thinking.budget_tokens >= 1024, id);
      assert.ok(bits.thinking.budget_tokens < bits.maxTokens, id);
    }
    assert.equal(bits.outputConfig, undefined, id);
  }
});

test("Sonnet 5 Instant explicitly disables thinking (default is adaptive on)", () => {
  const bits = buildAnthropicThinkingBits("claude-sonnet-5", 8192, undefined);
  assert.equal(bits.thinking?.type, "disabled");
  assert.equal(bits.outputConfig, undefined);
});

test("Opus 4.8 Instant omits thinking (default is off)", () => {
  const bits = buildAnthropicThinkingBits("claude-opus-4-8", 8192, undefined);
  assert.equal(bits.thinking, undefined);
  assert.equal(bits.outputConfig, undefined);
});

test("Fable always enables adaptive thinking even without effort", () => {
  const bits = buildAnthropicThinkingBits("claude-fable-5", 8192, undefined);
  assert.equal(bits.thinking?.type, "adaptive");
  assert.equal(bits.outputConfig?.effort, "high");
});

test("newest adaptive models request summarized display for UI streaming", () => {
  for (const id of ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]) {
    const bits = buildAnthropicThinkingBits(id, 8192, "medium");
    assert.equal(bits.thinking?.type, "adaptive", id);
    if (bits.thinking?.type === "adaptive") {
      assert.equal(bits.thinking.display, "summarized", id);
    }
  }
  // Opus 4.6 already defaults to summarized — no need to set display.
  const bits46 = buildAnthropicThinkingBits("claude-opus-4-6", 8192, "medium");
  assert.equal(bits46.thinking?.type, "adaptive");
  if (bits46.thinking?.type === "adaptive") {
    assert.equal(bits46.thinking.display, undefined);
  }
});

test("minimal effort maps to Anthropic low (no minimal wire value)", () => {
  const bits = buildAnthropicThinkingBits("claude-opus-4-8", 8192, "minimal");
  assert.equal(bits.outputConfig?.effort, "low");
});

test("Haiku Instant omits thinking", () => {
  const bits = buildAnthropicThinkingBits("claude-haiku-4-5", 8192, undefined);
  assert.equal(bits.thinking, undefined);
});
