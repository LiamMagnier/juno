import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import {
  SUMMARY_SYSTEM_PROMPT,
  compactedMessages,
  modelMemory,
  planCompaction,
  toolPairingIntact,
  type CompactionInfo,
} from '../compaction.js';
import { runAgentLoop } from '../loop.js';
import { ProviderCallError } from '../providers/errors.js';
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { AgentEvent, ChatMessage, Usage } from '../types.js';

/** A single long request: one prompt, then `steps` tool steps. */
function longRun(steps: number, resultChars = 200): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Fix the failing parser tests.' },
        { type: 'text', text: '<session_state>\nDate: 2026-09-30\nPermission mode: full\n</session_state>' },
      ],
    },
  ];
  for (let n = 1; n <= steps; n++) {
    messages.push({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: `thinking ${n}`, signature: `sig-${n}`, model: 'm' },
        { type: 'text', text: `Step ${n}: running the tests.` },
        { type: 'tool_call', id: `call-${n}`, name: 'bash', input: { command: `npm test -- --shard ${n}` } },
      ],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: `call-${n}`, content: `shard ${n}: ${'x'.repeat(resultChars)} <tag> & done` }],
    });
  }
  return messages;
}

function anchorOf(messages: ChatMessage[]): string {
  const first = messages[0]!;
  assert.equal(first.role, 'user');
  const part = first.content[0]!;
  assert.equal(part.type, 'text');
  return part.type === 'text' ? part.text : '';
}

test('a single long request can be cut at a step boundary, and no call loses its result', () => {
  const messages = longRun(12);
  const plan = planCompaction(messages, { keepRecentSteps: 4, targetTokens: 1_000_000 });
  assert.ok(plan);
  // Four whole steps kept: each an assistant turn and the results it asked for.
  assert.equal(plan.recent.length, 8);
  assert.equal(plan.recent[0]!.role, 'assistant');
  assert.equal(plan.folded.length, messages.length - 1 - 8);
  const next = compactedMessages(plan, plan.structuralMemory);
  assert.ok(toolPairingIntact(next));
  assert.equal(next[0]!.role, 'user');
  assert.ok(next.every((message, index) => index === 0 || message.role !== next[index - 1]!.role), 'turns alternate');
  const anchor = anchorOf(next);
  assert.ok(anchor.startsWith('Fix the failing parser tests.\n\n[Juno retained context]'));
  // The folded steps are notes; the state block and the reasoning are not.
  assert.match(anchor, /- Called bash \{"command":"npm test -- --shard 1"\}/);
  assert.match(anchor, /- Result of bash: shard 1:/);
  assert.match(anchor, /- Assistant: Step 1: running the tests\./);
  assert.doesNotMatch(anchor, /session_state|thinking 1/);
});

test('fewer recent steps are kept when they alone would not fit', () => {
  const messages = longRun(8, 4_000);
  const plan = planCompaction(messages, { keepRecentSteps: 6, targetTokens: 2_500 });
  assert.ok(plan);
  assert.ok(plan.recent.length < 12, `kept ${plan.recent.length} messages`);
  assert.ok(toolPairingIntact(compactedMessages(plan, plan.structuralMemory)));
});

test('nothing to cut in a request with a single step', () => {
  assert.equal(planCompaction(longRun(1), { targetTokens: 10 }), null);
});

test('a folded steer is quoted whole as the request in progress', () => {
  const messages = longRun(6);
  // A person steered at step 2, in their own words.
  const steered = messages[4]!;
  assert.equal(steered.role, 'user');
  steered.content.push({ type: 'text', text: 'Only touch src/parser — leave the lexer alone.' });
  const plan = planCompaction(messages, { keepRecentSteps: 2, targetTokens: 1_000_000 });
  assert.ok(plan);
  assert.equal(plan.currentRequest, 'Only touch src/parser — leave the lexer alone.');
  const anchor = anchorOf(compactedMessages(plan, plan.structuralMemory));
  assert.ok(
    anchor.endsWith("The reader's latest message, which the steps below are still carrying out:\nOnly touch src/parser — leave the lexer alone."),
  );
});

test('a second compaction folds the first memory in rather than stacking it', () => {
  const first = planCompaction(longRun(10), { keepRecentSteps: 3, targetTokens: 1_000_000 });
  assert.ok(first);
  const once = compactedMessages(first, modelMemory(first, '1. Requests and intent: fix the parser tests.\n6. Open tasks: shards 8-10.'));
  // More steps happen after the first compaction.
  const grown: ChatMessage[] = [...once];
  for (let n = 11; n <= 16; n++) {
    grown.push({ role: 'assistant', content: [{ type: 'tool_call', id: `late-${n}`, name: 'bash', input: { command: `echo ${n}` } }] });
    grown.push({ role: 'user', content: [{ type: 'tool_result', toolCallId: `late-${n}`, content: `${n}` }] });
  }
  const second = planCompaction(grown, { keepRecentSteps: 2, targetTokens: 1_000_000 });
  assert.ok(second);
  assert.equal(second.originalRequest, 'Fix the failing parser tests.');
  assert.match(second.earlierSummary ?? '', /Open tasks: shards 8-10/);

  // Structural path: the model summary is carried whole, the new steps noted.
  const structural = anchorOf(compactedMessages(second, second.structuralMemory));
  assert.equal(structural.split('[Juno retained context]').length, 2, 'one memory, not two');
  assert.equal(structural.split('Summary of the earlier conversation, written by the model:').length, 2);
  assert.match(structural, /Notes on the steps since that summary:/);
  assert.match(structural, /- Called bash \{"command":"echo 11"\}/);

  // Model path: the new summary replaces the old memory entirely.
  const modelWritten = anchorOf(compactedMessages(second, modelMemory(second, 'Everything so far, folded.')));
  assert.equal(modelWritten.split('Summary of the earlier conversation').length, 2);
  assert.doesNotMatch(modelWritten, /shards 8-10/);
});

// ---------------------------------------------------------------------------
// In the loop.
// ---------------------------------------------------------------------------

interface Scripted {
  provider: ProviderAdapter;
  requests: ProviderRequest[];
  summaryRequests: ProviderRequest[];
}

/**
 * A provider whose main requests each take one tool step, report the usage
 * given, and finish after `steps`; summary requests answer with `summary`
 * (or throw it, when it is an error).
 */
function scripted(options: {
  steps: number;
  usage: (call: number) => Usage;
  summary: string | Error;
  contextWindow: number;
  overflowOnCall?: number;
}): Scripted {
  const requests: ProviderRequest[] = [];
  const summaryRequests: ProviderRequest[] = [];
  let call = 0;
  const provider: ProviderAdapter = {
    id: 'mock',
    name: 'Mock',
    defaultModel: 'm',
    models: () => ['m'],
    capabilities: () => ({
      tools: true,
      vision: false,
      computerUse: false,
      reasoningLevels: [],
      maxContext: options.contextWindow,
      streaming: true,
      mcp: false,
    }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      const snapshot = { ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatMessage[] };
      if (req.system === SUMMARY_SYSTEM_PROMPT) {
        summaryRequests.push(snapshot);
        if (options.summary instanceof Error) throw options.summary;
        yield { type: 'text_delta', text: `<summary>\n${options.summary}\n</summary>` };
        yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 50 } };
        return;
      }
      call += 1;
      requests.push(snapshot);
      if (options.overflowOnCall === call) {
        throw new ProviderCallError('context_overflow', 400, null, 'Mock', 'Too long.');
      }
      if (requests.length > options.steps) {
        yield { type: 'text_delta', text: 'All shards pass.' };
        yield { type: 'done', stopReason: 'end_turn', usage: options.usage(call) };
        return;
      }
      yield { type: 'tool_call', id: `call-${call}`, name: 'bash', input: { command: `npm test -- --shard ${call}` } };
      yield { type: 'done', stopReason: 'tool_use', usage: options.usage(call) };
    },
  };
  return { provider, requests, summaryRequests };
}

function loop(script: Scripted, messages: ChatMessage[], extra: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  return runAgentLoop({
    provider: script.provider,
    model: 'm',
    system: 'You are Juno.',
    messages,
    tools: [{ name: 'bash', description: 'b', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal,
    maxSteps: 30,
    executeToolCall: async (call) => ({ type: 'tool_result', toolCallId: call.id, content: `ok ${'y'.repeat(400)}` }),
    ...extra,
  });
}

test('the loop compacts once reported usage crosses the threshold, with a model-written summary', async () => {
  const script = scripted({
    steps: 12,
    // Usage climbs a step at a time, past 80% of the window at step 8.
    usage: (call) => ({ inputTokens: call * 1_000, outputTokens: 50 }),
    summary: '1. Requests and intent: fix the parser tests.\n6. Open tasks: the remaining shards.',
    contextWindow: 10_000,
  });
  const compactions: CompactionInfo[] = [];
  const steps: Usage[] = [];
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Fix the failing parser tests.' }] }];
  const result = await loop(script, messages, {
    compaction: { contextWindow: 10_000, keepRecentSteps: 2, onCompaction: (info) => compactions.push(info) },
    onStep: (usage) => {
      steps.push(usage);
    },
  });
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(compactions.length >= 1);
  assert.equal(compactions[0]!.reason, 'threshold');
  assert.equal(compactions[0]!.summary, 'model');

  // The summary call: no tools, no cache write, the folded span escaped.
  const summaryRequest = script.summaryRequests[0]!;
  assert.deepEqual(summaryRequest.tools, []);
  assert.equal(summaryRequest.cache, false);
  const prompt = summaryRequest.messages[0]!.content[0]!;
  assert.ok(prompt.type === 'text');
  assert.match(prompt.text, /<original-request>\nFix the failing parser tests\.\n<\/original-request>/);
  assert.match(prompt.text, /<tool-call name="bash">/);
  assert.match(prompt.text, /Open tasks/);

  // The request after the fold opens with the anchor and keeps every pair.
  const after = script.requests.find((req) => {
    const first = req.messages[0]!.content[0];
    return first?.type === 'text' && first.text.includes('[Juno retained context]');
  });
  assert.ok(after, 'no request went out compacted');
  assert.ok(toolPairingIntact(after.messages));
  const before = script.requests[script.requests.indexOf(after) - 1]!;
  assert.ok(after.messages.length < before.messages.length, 'the compacted request is shorter than the one before it');
  // The summary call is billed like any other request.
  assert.ok(steps.some((usage) => usage.inputTokens === 500 && usage.outputTokens === 50));
  assert.ok(result.usage.inputTokens >= 500);
});

test('when the summary call fails the structural notes stand in, and the run carries on', async () => {
  const script = scripted({
    steps: 10,
    usage: (call) => ({ inputTokens: call * 1_000, outputTokens: 50 }),
    summary: new Error('socket hang up'),
    contextWindow: 10_000,
  });
  const compactions: CompactionInfo[] = [];
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Fix the failing parser tests.' }] }];
  const result = await loop(script, messages, {
    compaction: { contextWindow: 10_000, keepRecentSteps: 2, onCompaction: (info) => compactions.push(info) },
  });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(compactions[0]!.summary, 'structural');
  assert.match(compactions[0]!.failure ?? '', /model call failed/);
  assert.match(anchorOf(messages), /Earlier conversation memory:\n- Called bash/);
  assert.ok(toolPairingIntact(messages));
});

test('a request refused as too long is compacted and sent again, once', async () => {
  const script = scripted({
    steps: 7,
    usage: () => ({ inputTokens: 100, outputTokens: 10 }),
    summary: 'Folded.',
    contextWindow: 1_000_000,
    overflowOnCall: 6,
  });
  const compactions: CompactionInfo[] = [];
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Fix the failing parser tests.' }] }];
  const result = await loop(script, messages, {
    compaction: { contextWindow: 1_000_000, keepRecentSteps: 2, onCompaction: (info) => compactions.push(info) },
  });
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(compactions.map((info) => info.reason), ['overflow']);
  // Call 6 was refused; call 7 is the same step, sent shorter.
  const refused = script.requests[5]!;
  const resent = script.requests[6]!;
  assert.ok(resent.messages.length < refused.messages.length);
  assert.ok(toolPairingIntact(resent.messages));

  // Without a compactor the refusal is the run's failure, as before.
  const bare = scripted({ steps: 3, usage: () => ({ inputTokens: 1, outputTokens: 1 }), summary: 'x', contextWindow: 1_000, overflowOnCall: 2 });
  await assert.rejects(
    loop(bare, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]),
    (error: unknown) => error instanceof ProviderCallError && error.kind === 'context_overflow',
  );
});

test('a Code session compacts by default and says so', async () => {
  process.env.JUNO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-compaction-test-'));
  const script = scripted({
    steps: 9,
    usage: (call) => ({ inputTokens: call * 1_000, outputTokens: 50 }),
    summary: 'Folded.',
    contextWindow: 10_000,
  });
  const events: AgentEvent[] = [];
  const session = AgentSession.create({
    provider: script.provider,
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'juno-compaction-cwd-')),
    mode: 'full',
    subagents: false,
    tools: [
      {
        kind: 'command',
        spec: { name: 'bash', description: 'b', inputSchema: { type: 'object' } },
        summarize: () => 'bash',
        execute: async () => ({ output: 'ok' }),
      },
    ],
    callbacks: { onEvent: (event) => events.push(event), requestApproval: async () => 'allow' },
  });
  await session.prompt('Fix the failing parser tests.');
  const compacted = events.filter((event) => event.type === 'context_compacted');
  assert.ok(compacted.length >= 1);
  assert.deepEqual(
    compacted.map((event) => (event.type === 'context_compacted' ? [event.reason, event.summary] : null))[0],
    ['threshold', 'model'],
  );
  assert.ok(events.some((event) => event.type === 'turn_finished' && event.stopReason === 'end_turn'));
});
