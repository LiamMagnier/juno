/**
 * A scripted Work model, for tests and local demos only.
 *
 * Nothing about it is a model: it replays a fixed list of steps, one per
 * assistant turn, so a Work run can drive real tools (a real computer
 * included) on a machine with no provider key. The website refuses it in
 * production and never offers it to anyone (src/lib/dev/scripted-work-model.ts);
 * the run that uses it says so in its own transcript.
 *
 * The step is the number of assistant turns already in the request, so a run
 * that parks and resumes continues where it stopped rather than starting
 * over. A step's `expect` is a regular expression the previous tool result
 * must match; when it does not, the run ends with a sentence that says which
 * step failed and what the tool said, rather than carrying on blind.
 */

import type { ChatMessage } from '../types.js';
import type { ModelCapabilities, ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';

export interface ScriptedWorkStep {
  /** Text the model "writes" this turn. */
  say?: string;
  /** One tool call this turn. */
  call?: { name: string; input: Record<string, unknown> };
  /** A regular expression the previous tool result must match. */
  expect?: string;
  /** Ends the run at this turn: any call in the step is not made (a step with no call ends it too). */
  end?: boolean;
}

export interface ScriptedWorkScript {
  version: 1;
  /** Whether the "model" claims vision, which decides whether pixel tools are offered. */
  vision: boolean;
  steps: ScriptedWorkStep[];
}

export const SCRIPTED_PROVIDER_ID = 'scripted';
export const SCRIPTED_MODEL_ID = 'scripted-work-model';

/** A script read from untrusted JSON, checked; throws with a sentence on a bad one. */
export function parseScriptedWorkScript(raw: unknown): ScriptedWorkScript {
  const fail = (why: string): never => {
    throw new Error(`Not a scripted Work model script: ${why}.`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected an object');
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) fail('version must be 1');
  if (typeof value.vision !== 'boolean') fail('vision must be true or false');
  if (!Array.isArray(value.steps) || value.steps.length === 0) fail('steps must be a non-empty list');
  const steps = (value.steps as unknown[]).map((step, index): ScriptedWorkStep => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) fail(`step ${index + 1} is not an object`);
    const s = step as Record<string, unknown>;
    const out: ScriptedWorkStep = {};
    if (s.say !== undefined) {
      if (typeof s.say !== 'string') fail(`step ${index + 1}: say must be text`);
      out.say = s.say as string;
    }
    if (s.call !== undefined) {
      const call = s.call as Record<string, unknown> | null;
      if (!call || typeof call !== 'object' || typeof call.name !== 'string' || !call.name) {
        fail(`step ${index + 1}: call needs a name`);
      }
      const input = call!.input ?? {};
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`step ${index + 1}: call.input must be an object`);
      out.call = { name: call!.name as string, input: input as Record<string, unknown> };
    }
    if (s.expect !== undefined) {
      if (typeof s.expect !== 'string') fail(`step ${index + 1}: expect must be a regular expression as text`);
      try {
        new RegExp(s.expect as string);
      } catch {
        fail(`step ${index + 1}: expect is not a valid regular expression`);
      }
      out.expect = s.expect as string;
    }
    if (s.end !== undefined) out.end = s.end === true;
    return out;
  });
  return { version: 1, vision: value.vision as boolean, steps };
}

function assistantTurns(messages: readonly ChatMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length;
}

/** The last tool result in the request, as text (what the previous step's call returned). */
function previousToolResult(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j];
      if (part?.type === 'tool_result') return part.content;
    }
  }
  return '';
}

/** The run's last words when a step's expectation fails. */
export function scriptedExpectationFailure(step: number, expect: string, toolSaid: string): string {
  return `Scripted step ${step} expected /${expect}/; the tool said: ${toolSaid.slice(0, 200)}`;
}

export function createScriptedWorkProvider(script: ScriptedWorkScript): ProviderAdapter {
  const capabilities: ModelCapabilities = {
    tools: true,
    vision: script.vision,
    computerUse: false,
    reasoningLevels: [],
    maxContext: 200_000,
    streaming: true,
    mcp: false,
  };
  const done = (stopReason: 'end_turn' | 'tool_use'): ProviderStreamEvent => ({
    type: 'done',
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

  return {
    id: SCRIPTED_PROVIDER_ID,
    name: 'Scripted test model',
    defaultModel: SCRIPTED_MODEL_ID,
    models: () => [SCRIPTED_MODEL_ID],
    capabilities: () => capabilities,
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      const index = assistantTurns(req.messages);
      const step = script.steps[index];
      if (!step) {
        yield { type: 'text_delta', text: `The script has no step ${index + 1}; the run ends here.` };
        yield done('end_turn');
        return;
      }
      if (step.expect !== undefined) {
        const said = previousToolResult(req.messages);
        if (!new RegExp(step.expect).test(said)) {
          yield { type: 'text_delta', text: scriptedExpectationFailure(index + 1, step.expect, said) };
          yield done('end_turn');
          return;
        }
      }
      if (step.say) yield { type: 'text_delta', text: step.say };
      if (step.call && !step.end) {
        yield { type: 'tool_call', id: `scripted-call-${index + 1}`, name: step.call.name, input: step.call.input };
        yield done('tool_use');
        return;
      }
      yield done('end_turn');
    },
  };
}
