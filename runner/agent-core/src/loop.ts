import type {
  AssistantContent,
  ChatMessage,
  ToolSpec,
  Usage,
  UserContent,
} from './types.js';
import type { ProviderAdapter, ReasoningEffort } from './providers/types.js';
import { ProviderCallError, type ProviderFailureKind } from './providers/errors.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './providers/timeouts.js';
import { decodeComputerScreenshot } from './computer.js';

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
  /**
   * The system prompt, or a function that builds it for each turn.
   *
   * A plain string was fine while the prompt described only things that could
   * not change mid-run. It stopped being fine when the plan became something
   * the model writes: `WorkAgentSession` renders the current plan into its
   * prompt, the string was built once when these options were constructed, and
   * every turn after the first therefore carried the *seed* plan — three
   * placeholder steps with ids that `write_plan` had already deleted, under a
   * line telling the model to call `write_plan` first. On turn thirty it was
   * still being told to start planning, and any step id it read out of the
   * prompt came back "No step with id".
   *
   * Passing a function moves the build to the moment of use, which is the only
   * place it can be correct.
   */
  system: string | (() => string);
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
  }) => Promise<UserContent | UserContent[]>;
  /** Called after each provider request with that request's usage slice.
   *  Return 'stop' to end the turn (budget enforcement). */
  onStep?: (stepUsage: Usage) => void | 'stop';
  /** Persistence hook, called whenever `messages` changed. */
  onMessagesChanged?: () => void;
  /**
   * Called before the loop waits to try a step again.
   *
   * Exists so a waiting run can say it is waiting. A rate limit that clears in
   * forty seconds is a run that looks frozen for forty seconds, and "frozen"
   * and "gave up" are indistinguishable from outside — which is the complaint
   * that started this whole piece of work. The Work runner turns this into a
   * transcript event, so the Activity list reads "Anthropic is limiting how fast
   * Juno may call it — trying again in 8s" instead of nothing at all.
   */
  onProviderRetry?: (info: {
    attempt: number;
    of: number;
    delayMs: number;
    kind: ProviderFailureKind;
    /** The human sentence from the classifier. Safe to show. */
    reason: string;
  }) => void;
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

/**
 * How many times one step may be attempted again before the run gives up on
 * this model.
 *
 * Four, and the number is chosen against what is above rather than what is
 * below. The SDKs already retry two or three times over about two seconds,
 * which is the right shape for a blip and useless against a quota — the run
 * that started this work had already been retried three times before it showed
 * its user a failure. What was missing was the longer wait, and above THAT sits
 * the Work runner's failover to a different lab. So this layer only has to
 * cover the middle case: a per-minute limit that clears in tens of seconds. A
 * limit that does not clear in `MAX_TURN_RETRY_WAIT_MS` is a different lab's
 * problem, and handing it up is faster than sitting on it.
 */
const MAX_TURN_RETRIES = 4;
/** Total time one step may spend waiting, across every retry it makes. */
const MAX_TURN_RETRY_WAIT_MS = 90_000;
const RETRY_BASE_MS = 1_000;
const MAX_TURN_RETRY_BACKOFF_MS = 20_000;

/**
 * Waits, unless the run is stopped first.
 *
 * Returns true if the full delay elapsed and false if the signal fired, so the
 * caller can tell "we waited" from "we were stopped" without inspecting the
 * signal a second time and racing itself.
 *
 * The listener is removed on both paths. A step that retried four times would
 * otherwise leave four listeners on a signal that outlives it, and Node warns
 * about exactly that at eleven.
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeToolResult(result: UserContent | UserContent[]): UserContent[] {
  const values = Array.isArray(result) ? result : [result];
  if (values.length !== 1) return values;
  const [only] = values;
  if (only.type !== 'tool_result' || only.isError || !only.content.startsWith('data:image/')) {
    return values;
  }
  const image = decodeComputerScreenshot(only.content);
  if (!image) return values;
  return [
    {
      ...only,
      content: 'Screenshot captured. The image is attached as ephemeral vision input.',
    },
    image,
  ];
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
    let toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let textAcc = '';
    let stepUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    /** Retries spent on THIS step. Each step starts with a full allowance. */
    let retries = 0;
    let waitedMs = 0;

    /*
     * One step, attempted until it works, is told not to try again, or runs out
     * of allowance.
     *
     * The retry lives here rather than in the adapters because this is the
     * innermost place that still knows whether anything has been *shown* yet —
     * and that is the whole condition. See the guard below.
     */
    for (;;) {
      // Reset per attempt. A retry that inherited the last attempt's partial
      // text would emit it twice into the transcript.
      textAcc = '';
      toolCalls = [];
      stepUsage = { inputTokens: 0, outputTokens: 0 };

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
        // Keep the deadline referenced. If a provider request is the only live
        // work in a short-lived runner, unref'ing this timer lets Node exit before
        // the abort fires and leaves the caller's promise unresolved forever.
        // Long-lived hosts already have their server handle; this makes the
        // fail-safe correct for both hosts and one-shot CLI/test processes.
      };

      /** Set when this attempt failed in a way worth another go. */
      let retryable: ProviderCallError | null = null;

      try {
        listen();
        for await (const ev of opts.provider.stream({
          model: opts.model,
          // Rebuilt per turn when the caller passed a builder — see the field.
          system: typeof opts.system === 'function' ? opts.system() : opts.system,
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
        if (opts.signal.aborted) {
          stopReason = 'aborted';
        } else if (
          err instanceof ProviderCallError &&
          err.retryable &&
          // NOTHING may have been shown yet. This is the load-bearing condition:
          // `onAssistantDelta` has already streamed `textAcc` to whoever is
          // watching, so retrying after a partial answer would show the opening
          // of the reply twice and leave a transcript that reads as a stutter.
          // A rate limit — the failure this retry exists for — is refused before
          // the first token, so the case that matters is always the clean one.
          textAcc === '' &&
          toolCalls.length === 0 &&
          retries < MAX_TURN_RETRIES &&
          waitedMs < MAX_TURN_RETRY_WAIT_MS
        ) {
          retryable = err;
        } else {
          throw err;
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        opts.signal.removeEventListener('abort', chain);
      }

      if (retryable === null) break;

      // What the lab asked for, when it said, and an exponential back-off when
      // it did not. `retryAfterMs` is already capped by the classifier: a lab
      // answering "come back in an hour" is telling us to fail the run over to
      // another model, not to hold an executor for an hour.
      const backoff = Math.min(
        RETRY_BASE_MS * 2 ** retries,
        MAX_TURN_RETRY_BACKOFF_MS,
      );
      // Full jitter. Several runs meeting the same per-minute quota at the same
      // moment must not all come back at the same moment, or the retry is just
      // the thundering herd that caused the limit rearranged.
      const jittered = Math.round(backoff * (0.5 + Math.random() * 0.5));
      const delayMs = retryable.retryAfterMs ?? jittered;

      retries += 1;
      waitedMs += delayMs;
      opts.onProviderRetry?.({
        attempt: retries,
        of: MAX_TURN_RETRIES,
        delayMs,
        kind: retryable.kind,
        reason: retryable.message,
      });

      // Racing the signal rather than sleeping through it. A plain `setTimeout`
      // here would make Stop take as long as the back-off — up to a minute of a
      // button the user already pressed doing nothing — and would let the run's
      // own runtime ceiling overshoot by the same amount, because both are
      // delivered as an abort and an abort cannot interrupt a bare timer.
      const slept = await sleepUnlessAborted(delayMs, opts.signal);
      if (!slept) {
        stopReason = 'aborted';
        break;
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
    // The first throw out of a tool, kept rather than propagated, so the loop
    // can finish answering the assistant message before it unwinds.
    //
    // `executeToolCall` used to be awaited bare here, and a throw from it left
    // by the fastest possible route: past the `opts.messages.push(results)`
    // below, out of `runAgentLoop` entirely. The transcript it left behind ended
    // on an assistant message carrying tool_call blocks that nothing answered —
    // exactly the shape session.ts's own header says must never be checkpointed,
    // "which every provider rejects". It was not a hypothetical: the Work
    // runner's `askQuestion` throws by design when its wait for a person
    // expires, so the pause path — the one path whose entire purpose is to be
    // resumed — was the one reliably writing a transcript that could not be.
    //
    // So a throw now behaves like an abort: every outstanding call still gets a
    // result, the answer is still pushed, the checkpoint still sees a valid
    // transcript, and only then does the error continue on its way.
    let toolFailure: { error: unknown } | null = null;
    for (const call of toolCalls) {
      if (toolFailure !== null || opts.signal.aborted) {
        results.content.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: toolFailure !== null ? 'Not started — the run stopped first.' : 'Cancelled.',
          isError: true,
        });
        continue;
      }
      try {
        results.content.push(...normalizeToolResult(await opts.executeToolCall(call)));
      } catch (err) {
        toolFailure = { error: err };
        results.content.push({
          type: 'tool_result',
          toolCallId: call.id,
          content: 'Stopped before this finished.',
          isError: true,
        });
      }
    }
    opts.messages.push(results);
    opts.onMessagesChanged?.();
    if (toolFailure !== null) throw toolFailure.error;
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
