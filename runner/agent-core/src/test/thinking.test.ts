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

test('Opus 5 asks for summarized thinking and can still be left off', () => {
  const on = anthropicThinkingBits('claude-opus-5', 8192, 'high');
  assert.equal(on.thinking?.type, 'adaptive');
  if (on.thinking?.type === 'adaptive') assert.equal(on.thinking.display, 'summarized');
  assert.equal(anthropicThinkingBits('claude-opus-5', 8192, undefined).thinking, undefined);
});

test('Fable keeps its high default when no tier is given', () => {
  assert.equal(anthropicThinkingBits('claude-fable-5-1', 8192, undefined).outputConfig?.effort, 'high');
});
