import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicThinkingBits } from '../providers/thinking.js';

// The vendored copy of src/lib/anthropic-thinking.ts. These pin the cases
// where drift between the two copies is a 400 rather than a style difference.

test('Opus 5.5 always thinks: no tier still sends adaptive at its default medium', () => {
  const bits = anthropicThinkingBits('claude-opus-5-5', 8192, undefined);
  // `{type: 'disabled'}` and a manual budget are both 400s on this model.
  assert.equal(bits.thinking?.type, 'adaptive');
  assert.equal(bits.outputConfig?.effort, 'medium');
  if (bits.thinking?.type === 'adaptive') assert.equal(bits.thinking.display, 'summarized');
});

test('Opus 5.5 relays every chosen tier as adaptive effort', () => {
  for (const tier of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const bits = anthropicThinkingBits('claude-opus-5-5', 8192, tier);
    assert.equal(bits.thinking?.type, 'adaptive', tier);
    assert.equal(bits.outputConfig?.effort, tier);
  }
});

test('Opus 5 asks for summarized thinking and Instant really turns it off', () => {
  const on = anthropicThinkingBits('claude-opus-5', 8192, 'high');
  assert.equal(on.thinking?.type, 'adaptive');
  if (on.thinking?.type === 'adaptive') assert.equal(on.thinking.display, 'summarized');
  // Opus 5 thinks by default ("On" in Anthropic's per-model table), so
  // omitting `thinking` was not Instant: it must say disabled.
  assert.deepEqual(anthropicThinkingBits('claude-opus-5', 8192, undefined).thinking, { type: 'disabled' });
});

test('Haiku 5.5 is adaptive: never a budget, and Instant says disabled without an effort', () => {
  // `type: 'enabled'` + budget_tokens is a 400 on Haiku 5.5; this copy used to
  // send it for every "haiku" id, which is what broke Haiku 5.5 in Code and Work.
  for (const tier of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const bits = anthropicThinkingBits('claude-haiku-5-5', 8192, tier);
    assert.deepEqual(bits.thinking, { type: 'adaptive', display: 'summarized' }, tier);
    assert.deepEqual(bits.outputConfig, { effort: tier });
  }
  const instant = anthropicThinkingBits('claude-haiku-5-5', 8192, undefined);
  assert.deepEqual(instant.thinking, { type: 'disabled' });
  // `disabled` is a 400 at xhigh/max, so Instant carries no effort at all.
  assert.equal(instant.outputConfig, undefined);
  // Haiku 4.5 keeps the extended-thinking budget it requires.
  assert.equal(anthropicThinkingBits('claude-haiku-4-5', 8192, 'high').thinking?.type, 'enabled');
});

test('Sonnet 5.5 turns thinking off with between_tools, never disabled', () => {
  assert.deepEqual(anthropicThinkingBits('claude-sonnet-5-5', 8192, undefined).thinking, { type: 'between_tools' });
});

test('Fable keeps its high default when no tier is given', () => {
  assert.equal(anthropicThinkingBits('claude-fable-5-1', 8192, undefined).outputConfig?.effort, 'high');
});
