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
import { LeadingThinkingFilter } from './providers/leading-thinking.js';
import { addUsage } from './usage.js';
import {
  TARGET_AFTER_COMPACTION,
  clampThreshold,
  compactedMessages,
  estimateTokens,
  modelMemory,
  planCompaction,
  requestModelSummary,
  toolPairingIntact,
  type CompactionOptions,
} from './compaction.js';

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
  /**
   * What changes between steps of a run, rendered for the model: the date, the
   * permission mode, a Work run's plan.
   *
   * Kept out of `system` so the system prompt is byte-identical from the first
   * step to the last. Everything a request sends before the first byte that
   * differs from the previous request is read from the provider's prompt cache
   * at a tenth of the price, and the system prompt comes before the whole
   * conversation — so a plan rendered into it, as Work's used to be, made
   * every `update_plan` call a cache miss for the entire transcript.
   *
   * Instead the text is appended, wrapped in `<session_state>`, to the user
   * message the step is about to send — which no earlier request has seen — and
   * only when it differs from the last block in the transcript. It stays there,
   * so every later request carries the same bytes at the same place, and the
   * model reads the newest block as the current state.
   */
  sessionState?: () => string | null | undefined;
  /** The transcript, mutated in place (assistant + tool-result messages). */
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  maxSteps: number;
  /** How hard to think, when the provider can be asked. Absent means Instant. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Text a person sent while this turn was running, taken at the top of the
   * next step.
   *
   * The loop is the only place that knows where a step boundary is, so it is
   * the only place a mid-turn instruction can be folded into the transcript
   * without breaking it: the text is appended to the user message the step is
   * about to send — the tool results of the previous step, or the prompt
   * itself on the first — so the user/assistant alternation every provider
   * requires is kept and the model reads the instruction beside the results
   * it is reacting to. Called once per step; returns nothing when there is
   * nothing queued, which is the common case and costs a function call.
   */
  takeQueuedUserText?: () => string[];
  /** Longest silence from a stream before it is judged dead, in ms. */
  silenceTimeoutMs?: number;
  /**
   * Keep the run inside the model's context window (see compaction.ts).
   *
   * Checked at the top of every step against the usage the provider last
   * reported plus an estimate of what was appended since; past the threshold
   * the older steps are folded into a model-written summary before the
   * request goes out. And if the provider still refuses a request as too long,
   * the step compacts and sends it again, once. Absent, the loop never folds
   * anything — a subagent's fifteen steps do not need it.
   */
  compaction?: CompactionOptions;
  onAssistantDelta?: (text: string) => void;
  onAssistantMessage?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingMessage?: (text: string) => void;
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
 * Raised when a tool's own code threw, as opposed to returning an error result.
 *
 * Kept apart from `ProviderCallError` and `ProviderSilenceError` because a
 * caller does opposite things with them: a provider failure may be retried,
 * failed over or reported as the lab's fault, and a tool that threw is none of
 * those — it is this process's code (or the Work runner's deliberate pause) and
 * trying the model again would only reach the same tool. The original throw is
 * the `cause`, and the message is its message, so a caller that only reads the
 * text sees what it always saw.
 *
 * Provider failures that surface through a tool — a delegated child's model
 * call, for one — are passed through unwrapped: they are still provider
 * failures, and wrapping them would hide the kind a caller decides on.
 */
export class ToolExecutionError extends Error {
  override readonly name = 'ToolExecutionError';

  constructor(
    readonly toolName: string,
    readonly callId: string,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * What kind of failure ended a turn, in the vocabulary the agent protocol's
 * `error` event uses. One function so every host reports the same code for the
 * same failure rather than each re-deriving it from the message.
 */
export type AgentFailureCode =
  | 'plan_limit'
  | 'rate_limited'
  | 'provider_overload'
  | 'context_overflow'
  | 'provider_error'
  | 'provider_silence'
  | 'tool_error'
  | 'internal';

export function failureCodeOf(error: unknown): AgentFailureCode {
  if (error instanceof ToolExecutionError) return 'tool_error';
  if (error instanceof ProviderSilenceError) return 'provider_silence';
  if (error instanceof ProviderCallError) {
    switch (error.kind) {
      case 'plan_limit':
        return 'plan_limit';
      case 'rate_limit':
        return 'rate_limited';
      case 'overloaded':
        return 'provider_overload';
      case 'context_overflow':
        return 'context_overflow';
      default:
        return 'provider_error';
    }
  }
  return 'internal';
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

export const OMITTED_SCREENSHOT_MARKER = '[Screenshot omitted from the saved run]';

/** Opens every block `AgentLoopOptions.sessionState` writes. */
export const SESSION_STATE_OPEN = '<session_state>';
const SESSION_STATE_CLOSE = '</session_state>';

export function renderSessionState(state: string): string {
  return `${SESSION_STATE_OPEN}\n${state.trim()}\n${SESSION_STATE_CLOSE}`;
}

export function isSessionStateText(text: string): boolean {
  return text.startsWith(SESSION_STATE_OPEN);
}

/** The newest session-state block in the transcript, or null. */
export function latestSessionState(messages: readonly ChatMessage[]): string | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role !== 'user') continue;
    for (let p = message.content.length - 1; p >= 0; p--) {
      const part = message.content[p]!;
      if (part.type === 'text' && isSessionStateText(part.text)) return part.text;
    }
  }
  return null;
}

/** Appends the state block to the message the next request ends with, when it
 *  says something the transcript does not already. True when it did. */
function injectSessionState(messages: ChatMessage[], state: string | null | undefined): boolean {
  if (!state || !state.trim()) return false;
  const block = renderSessionState(state);
  if (latestSessionState(messages) === block) return false;
  const last = messages[messages.length - 1];
  if (last && last.role === 'user') last.content.push({ type: 'text', text: block });
  else messages.push({ role: 'user', content: [{ type: 'text', text: block }] });
  return true;
}

/**
 * Keeps only the newest `keepLast` image parts in `messages`, replacing older
 * `{ type: 'image' }` parts with `OMITTED_SCREENSHOT_MARKER`.
 */
export function pruneOldMessageImages(messages: ChatMessage[], keepLast = 3): void {
  const imageLocations: Array<{ msgIdx: number; partIdx: number }> = [];
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m];
    if (msg.role !== 'user') continue;
    for (let p = 0; p < msg.content.length; p++) {
      if (msg.content[p]?.type === 'image') {
        imageLocations.push({ msgIdx: m, partIdx: p });
      }
    }
  }
  const toDrop = imageLocations.length - keepLast;
  if (toDrop <= 0) return;
  for (let i = 0; i < toDrop; i++) {
    const loc = imageLocations[i]!;
    const msg = messages[loc.msgIdx];
    if (msg && msg.role === 'user') {
      msg.content[loc.partIdx] = {
        type: 'text',
        text: OMITTED_SCREENSHOT_MARKER,
      };
    }
  }
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason = 'end_turn';
  let finalText = '';
  const silenceMs = opts.silenceTimeoutMs ?? DEFAULT_STREAM_SILENCE_MS;
  const systemText = () => (typeof opts.system === 'function' ? opts.system() : opts.system);

  /**
   * What the provider last said the context held, and how long the transcript
   * was then: everything after that point is estimated, everything before it
   * is known. Null before the first answer and after a compaction.
   */
  let reported: { tokens: number; messageCount: number } | null = null;
  const contextTokens = (): number =>
    reported !== null && reported.messageCount <= opts.messages.length
      ? reported.tokens + estimateTokens({ messages: opts.messages.slice(reported.messageCount) })
      : estimateTokens({ system: systemText(), tools: opts.tools, messages: opts.messages });

  /**
   * Fold the older steps into a summary. `stop` when the summary call's cost
   * ended the run (the budget sees it like any other request); `unchanged`
   * when there is nothing it could cut.
   */
  const compact = async (reason: 'threshold' | 'overflow'): Promise<'compacted' | 'unchanged' | 'stop'> => {
    const options = opts.compaction;
    if (!options) return 'unchanged';
    const system = systemText();
    const tokensBefore = contextTokens();
    const plan = planCompaction(opts.messages, {
      ...(options.keepRecentSteps === undefined ? {} : { keepRecentSteps: options.keepRecentSteps }),
      targetTokens: Math.floor(options.contextWindow * TARGET_AFTER_COMPACTION),
      system,
      tools: opts.tools,
    });
    if (plan === null) return 'unchanged';
    let memory = plan.structuralMemory;
    let summary: 'model' | 'structural' = 'structural';
    let failure: string | undefined;
    let summaryUsage: Usage | undefined;
    if (options.modelSummary !== false) {
      const attempt = await requestModelSummary({
        provider: opts.provider,
        model: opts.model,
        plan,
        signal: opts.signal,
        ...(options.summaryTimeoutMs === undefined ? {} : { timeoutMs: options.summaryTimeoutMs }),
      });
      summaryUsage = attempt.usage;
      if (attempt.summary !== null) {
        memory = modelMemory(plan, attempt.summary);
        summary = 'model';
      } else if (attempt.failure !== null) {
        failure = attempt.failure;
      }
    }
    const next = compactedMessages(plan, memory);
    // The cut is placed so this cannot fail; if it ever did, sending a call
    // without its answer is the one outcome worse than not compacting.
    if (!toolPairingIntact(next)) return 'unchanged';
    opts.messages.splice(0, opts.messages.length, ...next);
    reported = null;
    opts.onMessagesChanged?.();
    options.onCompaction?.({
      reason,
      summary,
      ...(failure === undefined ? {} : { failure }),
      removedMessages: plan.folded.length,
      keptMessages: plan.recent.length,
      tokensBefore,
      tokensAfter: contextTokens(),
      ...(summaryUsage === undefined ? {} : { usage: summaryUsage }),
    });
    if (summaryUsage && (summaryUsage.inputTokens > 0 || summaryUsage.outputTokens > 0)) {
      usage = addUsage(usage, summaryUsage);
      if (opts.onStep?.(summaryUsage) === 'stop') return 'stop';
    }
    return 'compacted';
  };

  for (let step = 0; step < opts.maxSteps; step++) {
    if (opts.signal.aborted) {
      stopReason = 'aborted';
      break;
    }
    // Anything a person said since the last step rides into this one. See
    // `takeQueuedUserText` for why it is folded into the last user message.
    const queued = opts.takeQueuedUserText?.() ?? [];
    if (queued.length > 0) {
      const last = opts.messages[opts.messages.length - 1];
      const parts: UserContent[] = queued.map((text) => ({ type: 'text', text }));
      if (last && last.role === 'user') last.content.push(...parts);
      else opts.messages.push({ role: 'user', content: parts });
      opts.onMessagesChanged?.();
    }
    if (
      opts.compaction &&
      contextTokens() >= opts.compaction.contextWindow * clampThreshold(opts.compaction.threshold) &&
      (await compact('threshold')) === 'stop'
    ) {
      stopReason = 'budget';
      break;
    }
    // After compaction, which may have folded the last state block away.
    if (injectSessionState(opts.messages, opts.sessionState?.())) opts.onMessagesChanged?.();
    pruneOldMessageImages(opts.messages, 3);
    /**
     * The assistant turn as it streamed: text, signed reasoning blocks and
     * tool calls, in arrival order. Order is the point — a provider that
     * signs its reasoning takes it back only in the place it was written.
     */
    let assistantContent: AssistantContent[] = [];
    let toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    let textAcc = '';
    let stepUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    /** Retries spent on THIS step. Each step starts with a full allowance. */
    let retries = 0;
    let waitedMs = 0;
    /** Whether this step already compacted because its request was too long;
     *  a second refusal after that is a real failure. */
    let compactedForOverflow = false;

    for (;;) {
      textAcc = '';
      toolCalls = [];
      assistantContent = [];
      stepUsage = { inputTokens: 0, outputTokens: 0 };

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
      };

      let retryable: ProviderCallError | null = null;
      let overflow: ProviderCallError | null = null;
      const thinkingFilter = new LeadingThinkingFilter();
      let thinkingAcc = '';
      const deliver = (parts: { text: string; thinking: string }) => {
        if (parts.text) {
          textAcc += parts.text;
          const last = assistantContent[assistantContent.length - 1];
          if (last?.type === 'text') last.text += parts.text;
          else assistantContent.push({ type: 'text', text: parts.text });
          opts.onAssistantDelta?.(parts.text);
        }
        if (parts.thinking) {
          thinkingAcc = (thinkingAcc + parts.thinking).slice(-12_000);
          opts.onThinkingDelta?.(parts.thinking);
        }
      };

      try {
        listen();
        for await (const ev of opts.provider.stream({
          model: opts.model,
          system: typeof opts.system === 'function' ? opts.system() : opts.system,
          messages: opts.messages,
          tools: opts.tools,
          signal: turn.signal,
          ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        })) {
          listen();
          if (ev.type === 'text_delta') {
            deliver(thinkingFilter.push(ev.text));
          } else if (ev.type === 'thinking_delta') {
            deliver({ text: '', thinking: ev.text });
          } else if (ev.type === 'reasoning_block') {
            // Stamped with the model that wrote it: the adapter replays a
            // block only to that model, and drops it for any other.
            assistantContent.push({ ...ev.block, model: opts.model });
          } else if (ev.type === 'tool_call') {
            const call = {
              id: ev.id,
              name: ev.name,
              input: (ev.input ?? {}) as Record<string, unknown>,
            };
            toolCalls.push(call);
            assistantContent.push({ type: 'tool_call', ...call });
          } else if (ev.type === 'done') {
            stepUsage = ev.usage;
            usage = addUsage(usage, ev.usage);
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
          err.kind === 'context_overflow' &&
          opts.compaction !== undefined &&
          !compactedForOverflow &&
          textAcc === '' && thinkingAcc === '' && assistantContent.length === 0
        ) {
          // Too long to send: fold the older steps and send the shorter one.
          overflow = err;
        } else if (
          err instanceof ProviderCallError &&
          err.retryable &&
          // NOTHING may have been shown yet. This is the load-bearing condition:
          // `onAssistantDelta` has already streamed `textAcc` to whoever is
          // watching, so retrying after a partial answer would show the opening
          // of the reply twice and leave a transcript that reads as a stutter.
          // A rate limit — the failure this retry exists for — is refused before
          // the first token, so the case that matters is always the clean one.
          textAcc === '' && thinkingAcc === '' &&
          toolCalls.length === 0 && assistantContent.length === 0 &&
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

      deliver(thinkingFilter.finish());
      if (thinkingAcc) opts.onThinkingMessage?.(thinkingAcc);

      if (overflow !== null) {
        compactedForOverflow = true;
        const outcome = await compact('overflow');
        if (outcome === 'unchanged') throw overflow;
        if (outcome === 'stop') {
          stopReason = 'budget';
          break;
        }
        // Straight back to the request: not a provider retry, and no wait.
        if (injectSessionState(opts.messages, opts.sessionState?.())) opts.onMessagesChanged?.();
        continue;
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
      opts.onAssistantMessage?.(textAcc);
      finalText = textAcc;
    }
    // Recorded only when the model said or asked for something. Reasoning on
    // its own — a stream stopped between a thinking block and the text it led
    // to — is not a turn, and an assistant message of nothing but thinking is
    // one no provider accepts back.
    if (textAcc || toolCalls.length > 0) {
      opts.messages.push({ role: 'assistant', content: assistantContent });
    }
    opts.onMessagesChanged?.();
    if (stepUsage.inputTokens > 0) {
      reported = { tokens: stepUsage.inputTokens + stepUsage.outputTokens, messageCount: opts.messages.length };
    }

    if (opts.onStep?.(stepUsage) === 'stop') {
      stopReason = 'budget';
      break;
    }
    // Tool calls are the instruction to execute. Some compatible providers
    // incorrectly finish them with `stop` instead of `tool_calls`.
    if (toolCalls.length === 0) break;

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
        toolFailure = {
          error:
            err instanceof ProviderCallError || err instanceof ProviderSilenceError || err instanceof ToolExecutionError
              ? err
              : new ToolExecutionError(call.name, call.id, err),
        };
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
