import type {
  AssistantContent,
  ChatMessage,
  ToolSpec,
  Usage,
  UserContent,
} from './types.js';
import type { ProviderAdapter } from './providers/types.js';

/**
 * The single copy of the agent step loop: stream → collect tool calls →
 * execute → feed results back → repeat until end_turn. Used by BOTH the root
 * `AgentSession` and every subagent runner, so streaming, tool-result
 * plumbing, usage summing, step limits, and cancellation live in one place.
 */
export interface AgentLoopOptions {
  provider: ProviderAdapter;
  model: string;
  system: string;
  /** The transcript, mutated in place (assistant + tool-result messages). */
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  maxSteps: number;
  onAssistantDelta?: (text: string) => void;
  onAssistantMessage?: (text: string) => void;
  executeToolCall: (call: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }) => Promise<UserContent>;
  /** Called after each provider request with that request's usage slice.
   *  Return 'stop' to end the turn (budget enforcement). */
  onStep?: (stepUsage: Usage) => void | 'stop';
  /** Persistence hook, called whenever `messages` changed. */
  onMessagesChanged?: () => void;
}

export interface AgentLoopResult {
  usage: Usage;
  stopReason: string;
  /** The final assistant text of the turn (the report/answer). */
  finalText: string;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason = 'end_turn';
  let finalText = '';

  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal.aborted) {
      stopReason = 'aborted';
      break;
    }
    const assistantContent: AssistantContent[] = [];
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let textAcc = '';
    let stepUsage: Usage = { inputTokens: 0, outputTokens: 0 };

    for await (const ev of opts.provider.stream({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      signal: opts.signal,
    })) {
      if (ev.type === 'text_delta') {
        textAcc += ev.text;
        opts.onAssistantDelta?.(ev.text);
      } else if (ev.type === 'tool_call') {
        toolCalls.push({
          id: ev.id,
          name: ev.name,
          input: (ev.input ?? {}) as Record<string, unknown>,
        });
      } else if (ev.type === 'done') {
        stepUsage = ev.usage;
        usage = {
          inputTokens: usage.inputTokens + ev.usage.inputTokens,
          outputTokens: usage.outputTokens + ev.usage.outputTokens,
        };
        stopReason = ev.stopReason;
      }
    }

    if (textAcc) {
      assistantContent.push({ type: 'text', text: textAcc });
      opts.onAssistantMessage?.(textAcc);
      finalText = textAcc;
    }
    for (const call of toolCalls) {
      assistantContent.push({ type: 'tool_call', id: call.id, name: call.name, input: call.input });
    }
    if (assistantContent.length > 0) {
      opts.messages.push({ role: 'assistant', content: assistantContent });
    }
    opts.onMessagesChanged?.();

    if (opts.onStep?.(stepUsage) === 'stop') {
      stopReason = 'budget';
      break;
    }
    if (stopReason !== 'tool_use' || toolCalls.length === 0) break;

    // No early break on abort here: the assistant message above already
    // carries tool_call blocks, so the transcript MUST answer each one —
    // the per-call check below emits Cancelled results instead.
    const results: ChatMessage = { role: 'user', content: [] };
    for (const call of toolCalls) {
      if (opts.signal.aborted) {
        results.content.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: 'Cancelled.',
          isError: true,
        });
        continue;
      }
      results.content.push(await opts.executeToolCall(call));
    }
    opts.messages.push(results);
    opts.onMessagesChanged?.();
    if (opts.signal.aborted) {
      stopReason = 'aborted';
      break;
    }
    if (step === opts.maxSteps - 1) {
      stopReason = 'max_steps';
    }
  }

  return { usage, stopReason, finalText };
}
