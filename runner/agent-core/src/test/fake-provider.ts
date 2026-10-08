/**
 * A scripted model for harness tests: every `stream()` call is answered by the
 * route function, which sees the whole request. Records every request.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { ChatMessage } from '../types.js';

export type Script = ProviderStreamEvent[] | 'hang' | { delayMs: number; events: ProviderStreamEvent[] };

export interface ScriptedProvider extends ProviderAdapter {
  requests: ProviderRequest[];
}

export function scriptedProvider(
  id: string,
  route: (req: ProviderRequest, index: number) => Script,
  maxContext = 100_000,
): ScriptedProvider {
  const requests: ProviderRequest[] = [];
  return {
    id,
    name: id,
    defaultModel: `${id}-model`,
    requests,
    models: () => [`${id}-model`],
    capabilities: () => ({
      tools: true,
      vision: true,
      computerUse: false,
      reasoningLevels: [],
      maxContext,
      streaming: true,
      mcp: false,
    }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      // A deep copy: the loop mutates its transcript after the call.
      requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })) as ProviderRequest);
      const script = route(req, requests.length - 1);
      if (script === 'hang') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return;
      }
      const events = Array.isArray(script) ? script : script.events;
      if (!Array.isArray(script)) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, script.delayMs);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (req.signal?.aborted) return;
      }
      for (const ev of events) yield ev;
    },
  };
}

export const done = (
  stop: 'end_turn' | 'tool_use' | 'max_tokens' | 'other' = 'end_turn',
  input = 1,
  output = 1,
): ProviderStreamEvent => ({ type: 'done', stopReason: stop, usage: { inputTokens: input, outputTokens: output } });

export const say = (text: string, input = 1, output = 1): ProviderStreamEvent[] => [
  { type: 'text_delta', text },
  done('end_turn', input, output),
];

export const call = (id: string, name: string, input: Record<string, unknown>, tokens = 1): ProviderStreamEvent[] => [
  { type: 'tool_call', id, name, input },
  done('tool_use', tokens, tokens),
];

/** All text a request carries in user messages (prompts, tool results, notices). */
export function userText(req: ProviderRequest): string {
  return req.messages
    .filter((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user')
    .flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : '')))
    .join('\n');
}

/** The text of the last user message. */
export function lastUserText(req: ProviderRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === 'user');
  if (!last || last.role !== 'user') return '';
  return last.content.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : '')).join('\n');
}

export function isChild(req: ProviderRequest): boolean {
  return req.system.includes('SUBAGENT') || userText(req).includes('<fork>');
}

export function tmpdir(prefix = 'alevr-harness-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function gitRepo(files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const cwd = tmpdir('alevr-repo-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=test@alevr.dev', '-c', 'user.name=Alevr', 'commit', '-q', '-m', 'init'], { cwd });
  return cwd;
}
