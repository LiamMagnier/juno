import type {
  AssistantContent,
  ChatMessage,
  ToolSpec,
  Usage,
  UserContent,
} from './types.js';
import type { ProviderAdapter, ReasoningEffort } from './providers/types.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './providers/timeouts.js';

/**
 * How long the loop will listen to a stream that is saying nothing.
 *
 * The SDK timeouts in providers/timeouts.ts cover a provider that never
 * answers. This covers the rest: an adapter that is not an SDK, a connection
 * that stays open and delivers no bytes, a proxy that holds the request. The
 * loop is the one place every provider passes through, so it is the one place a
 * silence can be given a ceiling for all of them at once.
 *
 * It is a silence deadline and not a request deadline. A long answer that keeps
 * streaming is fine and must not be cut off mid-sentence; a stream that has
 * produced nothing at all for two minutes is not slow, it is gone.
 */
export const DEFAULT_STREAM_SILENCE_MS = DEFAULT_REQUEST_TIMEOUT_MS;

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
  /** How hard to think, when the provider can be asked. Absent means Instant. */
  reasoningEffort?: ReasoningEffort;
  /** Longest silence from a stream before it is judged dead, in ms. */
  silenceTimeoutMs?: number;
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

/**
 * Raised when a stream said nothing for longer than the silence deadline.
 *
 * Its own class so a caller can tell "the provider stopped talking" from "the
 * provider said no". The two want different sentences: one is worth retrying
 * and one is not, and a run that reports the wrong one sends its user to check
 * the wrong thing.
 */
export class ProviderSilenceError extends Error {
  constructor(readonly silenceMs: number) {
    super(
      `The model provider accepted the request and then sent nothing for ${Math.round(silenceMs / 1000)}s, so this turn was abandoned. Nothing was charged and no work was lost.`,
    );
    this.name = 'ProviderSilenceError';
  }
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason = 'end_turn';
  let finalText = '';
  const silenceMs = opts.silenceTimeoutMs ?? DEFAULT_STREAM_SILENCE_MS;

  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal.aborted) {
      stopReason = 'aborted';
      break;
    }
    const assistantContent: AssistantContent[] = [];
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let textAcc = '';
    let stepUsage: Usage = { inputTokens: 0, outputTokens: 0 };

    /*
     * The stream is driven through a controller of this step's own, chained to
     * the caller's, so the deadline has something to pull. Handing the caller's
     * signal straight to the provider — which is what used to happen — left the
     * loop with no way to end a request it had started: an adapter awaiting a
     * socket that never delivers is not interruptible from the outside, and
     * every ceiling above it (the budget guard, the run's runtime limit, the
     * executor's stalled-run sweep) is checked at points that request never
     * reaches. A Work run in that state showed `running`, zero tokens and an
     * empty transcript for as long as anyone watched.
     */
    const turn = new AbortController();
    const chain = () => turn.abort();
    opts.signal.addEventListener('abort', chain, { once: true });
    let silent = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const listen = () => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => {
        silent = true;
        turn.abort();
      }, silenceMs);
      // Never hold the process open on account of a deadline that is only
      // there to end something early.
      deadline.unref?.();
    };

    try {
      listen();
      for await (const ev of opts.provider.stream({
        model: opts.model,
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
        signal: turn.signal,
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      })) {
        listen();
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
    } catch (err) {
      if (silent) throw new ProviderSilenceError(silenceMs);
      // A cancelled request throws from inside the SDK rather than ending the
      // iteration, and a stop the user asked for is not an error to report. The
      // partial turn below is still recorded: whatever arrived before the abort
      // is in the transcript, and a resumed run reads it.
      if (!opts.signal.aborted) throw err;
      stopReason = 'aborted';
    } finally {
      if (deadline) clearTimeout(deadline);
      opts.signal.removeEventListener('abort', chain);
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
