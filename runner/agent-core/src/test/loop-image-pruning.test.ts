import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_KEEP_LAST,
  IMAGE_PRUNE_BATCH,
  OMITTED_SCREENSHOT_MARKER,
  pruneOldMessageImages,
  runAgentLoop,
} from '../loop.js';
import type { ChatMessage } from '../types.js';
import { done, scriptedProvider } from './fake-provider.js';

/*
 * Cache-friendly screenshot pruning (VENDORED.md, "Cloud agent loop").
 *
 * The model keeps seeing the newest three screenshots, but history is only
 * rewritten once more than three plus a batch have piled up. Rewriting an old
 * message changes the transcript's prefix and so misses the prompt cache on
 * everything after it; doing that once a step re-billed a long computer run's
 * whole transcript every turn.
 */

function withImages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: `step ${index + 1}` },
      { type: 'image' as const, mediaType: 'image/jpeg' as const, data: `jpeg_${index + 1}` },
    ],
  }));
}

const images = (messages: ChatMessage[]) =>
  messages.flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) => (part.type === 'image' ? [part.data] : []))
      : [],
  );

test('the defaults are three kept and a batch of ten', () => {
  assert.equal(IMAGE_KEEP_LAST, 3);
  assert.equal(IMAGE_PRUNE_BATCH, 10);
});

test('history is left byte-for-byte untouched until three plus the batch is exceeded', () => {
  for (const count of [1, 3, 4, 8, 13]) {
    const messages = withImages(count);
    const before = JSON.stringify(messages);
    assert.equal(pruneOldMessageImages(messages, 3, 10), 0, `${count} images`);
    assert.equal(JSON.stringify(messages), before, `${count} images leaves the prefix alone`);
  }
});

test('past the batch it cuts back to the newest three in one rewrite', () => {
  const messages = withImages(14);
  assert.equal(pruneOldMessageImages(messages, 3, 10), 11);
  assert.deepEqual(images(messages), ['jpeg_12', 'jpeg_13', 'jpeg_14']);
  const markers = messages.flatMap((message) =>
    message.role === 'user' ? message.content.filter((part) => part.type === 'text' && part.text === OMITTED_SCREENSHOT_MARKER) : [],
  );
  assert.equal(markers.length, 11);

  // The next ten steps add images without touching anything already sent.
  const grown = [...messages, ...withImages(10).map((message, index) => ({
    ...message,
    content: message.role === 'user'
      ? message.content.map((part) => (part.type === 'image' ? { ...part, data: `later_${index + 1}` } : part))
      : message.content,
  })) as ChatMessage[]];
  const snapshot = JSON.stringify(grown);
  assert.equal(pruneOldMessageImages(grown, 3, 10), 0);
  assert.equal(JSON.stringify(grown), snapshot);
});

test('with no batch it behaves exactly as before: the newest three, every time', () => {
  const messages = withImages(5);
  assert.equal(pruneOldMessageImages(messages, 3), 2);
  assert.deepEqual(images(messages), ['jpeg_3', 'jpeg_4', 'jpeg_5']);
});

test('the loop keeps every screenshot in the request until the batch is exceeded', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Look at these.' }] },
    ...withImages(IMAGE_KEEP_LAST + IMAGE_PRUNE_BATCH),
  ];
  const provider = scriptedProvider('prune', () => [{ type: 'text_delta', text: 'Seen.' }, done()]);
  await runAgentLoop({
    provider,
    model: 'prune-model',
    system: 'test',
    tools: [],
    messages,
    signal: new AbortController().signal,
    maxSteps: 2,
    executeToolCall: async () => {
      throw new Error('no tools in this test');
    },
  });
  const sent = provider.requests[0]!.messages as ChatMessage[];
  assert.equal(images(sent).length, IMAGE_KEEP_LAST + IMAGE_PRUNE_BATCH, 'thirteen images went out untouched');
});
