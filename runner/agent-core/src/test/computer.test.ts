import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { remoteComputerTools } from '../computer.js';
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { AgentEvent } from '../types.js';

test('computer screenshot reaches vision input but is omitted from events and persistence', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-computer-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-computer-work-'));
  process.env.JUNO_HOME = home;
  const png = Buffer.from('safe-test-png').toString('base64');
  const requests: ProviderRequest[] = [];
  let call = 0;
  const provider: ProviderAdapter = {
    id: 'mock',
    name: 'Mock',
    defaultModel: 'mock',
    models: () => ['mock'],
    capabilities: () => ({
      tools: true,
      vision: true,
      computerUse: true,
      reasoningLevels: [],
      maxContext: 100_000,
      streaming: true,
      mcp: false,
    }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      requests.push(structuredClone(req));
      if (call++ === 0) {
        yield { type: 'tool_call', id: 'screen-1', name: 'computer_screenshot', input: {} };
        yield {
          type: 'done',
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      } else {
        yield { type: 'text_delta', text: 'I can see the screen.' };
        yield {
          type: 'done',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
    },
  };
  const events: AgentEvent[] = [];
  const session = AgentSession.create({
    provider,
    cwd,
    mode: 'ask',
    tools: remoteComputerTools(async () => `data:image/png;base64,${png}`),
    callbacks: {
      onEvent: (event) => events.push(event),
      requestApproval: async () => 'allow',
    },
  });

  await session.prompt('Inspect the display.');

  const secondRequest = requests[1];
  assert.ok(
    secondRequest.messages.some(
      (message) =>
        message.role === 'user' &&
        message.content.some(
          (content) => content.type === 'image' && content.data === png,
        ),
    ),
  );
  assert.ok(!JSON.stringify(events).includes(png));
  const stored = session.store.loadMessages();
  assert.ok(!JSON.stringify(stored).includes(png));
  assert.ok(JSON.stringify(stored).includes('Ephemeral Computer Use screenshot omitted'));
  delete process.env.JUNO_HOME;
});

test('computer input tools remain permission-gated commands', () => {
  const tools = remoteComputerTools(async () => 'ok');
  assert.equal(tools.find((tool) => tool.spec.name === 'computer_screenshot')?.kind, 'read');
  assert.equal(tools.find((tool) => tool.spec.name === 'computer_click')?.kind, 'command');
  assert.equal(tools.find((tool) => tool.spec.name === 'computer_type')?.kind, 'command');
});
