import test from 'node:test';
import assert from 'node:assert/strict';
import { LeadingThinkingFilter } from '../providers/leading-thinking.js';

test('leading reasoning is separated at every possible stream boundary', () => {
  for (const tag of ['think', 'thinking', 'analysis']) {
    const source = ` \n<${tag}>Inspect files.</${tag}>Updated the file.`;
    for (let split = 1; split < source.length; split++) {
      const filter = new LeadingThinkingFilter();
      const chunks = [filter.push(source.slice(0, split)), filter.push(source.slice(split)), filter.finish()];
      assert.equal(chunks.map(c => c.text).join(''), 'Updated the file.', `${tag} boundary ${split}`);
      assert.equal(chunks.map(c => c.thinking).join(''), 'Inspect files.');
    }
  }
});

test('literal tags inside an answer or code example are preserved', () => {
  const filter = new LeadingThinkingFilter();
  const source = 'Example: `<think>hello</think>`';
  const chunks = [...source].map(c => filter.push(c));
  chunks.push(filter.finish());
  assert.equal(chunks.map(c => c.text).join(''), source);
  assert.equal(chunks.map(c => c.thinking).join(''), '');
});

test('an interrupted thinking envelope never becomes an answer', () => {
  const filter = new LeadingThinkingFilter();
  const chunks = [filter.push('<think>Inspect files.</thi'), filter.finish()];
  assert.equal(chunks.map(c => c.text).join(''), '');
});
