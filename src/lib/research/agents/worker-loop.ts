import type Anthropic from "@anthropic-ai/sdk";
import { withConversationCacheBreakpoint } from "@/lib/anthropic-cache";
import { WORKER_CONTEXT_CHARS } from "@/lib/research/domain";
import {
  parseToolArgs,
  renderFindMatches,
  renderPageDigest,
  renderSearchDigest,
  type RunWorkerInput,
  type WorkerFinishReason,
  type WorkerStopReason,
  WORKER_TOOLS,
} from "@/lib/research/agents/protocol";
import { timeboxSignal } from "@/lib/research/agents/scheduler";
import { truncate } from "@/lib/utils";
import { wrapUntrusted } from "@/lib/untrusted-content";

/**
 * The worker's tool loop, with no provider and no billing in it.
 *
 * Lifted out of worker.ts because that file is `server-only` — it names the
 * Anthropic and OpenAI clients — and so nothing in `tests/` could ever drive
 * the loop. That is how `if (idleTurns > MAX_IDLE_TURNS || toolCalls === 0)`
 * shipped: a worker whose first turn was a paragraph of plan was stopped on
 * the spot with reason `done`, zero tool calls and zero findings, and the
 * nudge the comment beside it described never ran for exactly the worker it
 * was written for. The adapters stay in worker.ts; the decisions — when to
 * nudge, when to stop, what to elide — live here where a scripted adapter can
 * exercise them.
 */

/** One tool call as the model requested it, provider shape removed. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Turn {
  /** Tool calls the model made this turn. Empty means it answered in prose. */
  calls: ToolCall[];
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache hits, when the provider reports them (see `WorkerCacheUsage`). */
  cache?: WorkerCacheUsage;
}

/**
 * Prompt-cache counters for one call, in the provider's own convention:
 * Anthropic's `input_tokens` excludes both, an OpenAI-compatible
 * `prompt_tokens` includes them. `normalizeUsage` reconciles the two when the
 * caller prices the worker, so the loop only adds them up.
 */
export interface WorkerCacheUsage {
  read: number;
  /** A write whose TTL the provider did not split. */
  write: number;
  write5m: number;
  write1h: number;
}

/**
 * The provider-specific half: given the transcript so far, one model call.
 *
 * `record` is the transcript in the provider's own message shape, owned by the
 * adapter; the loop only ever appends through `pushToolResults`.
 */
export interface Adapter {
  next(signal: AbortSignal): Promise<Turn>;
  pushToolResults(results: Array<{ call: ToolCall; text: string }>): void;
  /** Drops the bodies of tool results older than the newest `keep`. */
  elideOldResults(keep: number): void;
}

/** Tool results the model can still see in full. Older ones are elided. */
export const RESULTS_KEPT_IN_FULL = 10;
/** Characters of tool output one result may carry into the transcript. */
export const MAX_RESULT_CHARS = 14_000;
/** Turns in a row that produced no tool call before the worker is stopped. */
export const MAX_IDLE_TURNS = 2;
/** Results elided at a time: the transcript's prefix changes once per batch, not once per step. */
export const ELIDE_STEP = 4;

export function elided(call: ToolCall): string {
  const arg = typeof call.args.query === "string" ? call.args.query : typeof call.args.url === "string" ? call.args.url : "";
  return `[earlier ${call.name} result${arg ? ` for "${truncate(arg, 80)}"` : ""} elided to save context — call the tool again if you need it]`;
}

/**
 * How many of the newest results the model may still see in full.
 *
 * By characters, not only by count. The runner kept the newest ten results
 * whatever their size, and ten page digests at `MAX_RESULT_CHARS` is 140,000
 * characters — nearly twice the `WORKER_CONTEXT_CHARS` the cost model in
 * domain.ts states the runner enforces, so every per-worker estimate built on
 * that cap was a floor rather than a bound. Walking back from the newest
 * result and stopping at the cap makes the cap true; the count is kept as the
 * outer limit for the short-result case, where the cap alone would let sixty
 * search digests through.
 */
export function resultsToKeep(results: ReadonlyArray<{ text: string }>): number {
  let keep = 0;
  let chars = 0;
  for (let i = results.length - 1; i >= 0 && keep < RESULTS_KEPT_IN_FULL; i -= 1) {
    const length = results[i]!.text.length;
    if (chars + length > WORKER_CONTEXT_CHARS) break;
    chars += length;
    keep += 1;
  }
  // The newest result is never elided: it answers the call the model just
  // made, and a model shown a placeholder for its own last question re-asks it.
  return Math.max(1, keep);
}

/**
 * How many of the oldest results should be elided, given how many already are.
 *
 * In batches of `ELIDE_STEP`. Eliding a result rewrites a message in the
 * middle of the transcript, and every provider caches a prompt by its prefix:
 * when one more result was elided on every step, each request differed from
 * the previous one at the newest elided result and re-billed everything after
 * it as fresh input. Rounding the boundary UP to the next multiple keeps the
 * character cap true (at least `total - keep` are elided) while the prefix
 * stays byte-identical for the next few steps, so they read it from cache.
 * Never elides the newest result, and never un-elides one.
 */
export function nextElidedCount(total: number, keep: number, elided: number): number {
  const required = Math.max(0, total - keep);
  if (required <= elided) return elided;
  return Math.max(elided, Math.min(Math.max(0, total - 1), Math.ceil(required / ELIDE_STEP) * ELIDE_STEP));
}

/** What the loop established, before the caller prices it. */
export interface WorkerLoopOutcome {
  summary: string;
  openQuestions: string[];
  followUps: string[];
  reason: WorkerFinishReason;
  toolCalls: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  cache: WorkerCacheUsage;
  /** Characters of tool output shown to the model, for pricing a worker whose provider reported no usage. */
  resultChars: number;
}

export async function runWorkerLoop(
  input: RunWorkerInput,
  adapter: Adapter,
  opts: { label: string }
): Promise<WorkerLoopOutcome> {
  const startedAt = Date.now();
  const box = timeboxSignal(input.signal, input.limits.wallClockMs);
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const cache: WorkerCacheUsage = { read: 0, write: 0, write5m: 0, write1h: 0 };
  const addCache = (turn: Turn) => {
    if (!turn.cache) return;
    cache.read += turn.cache.read;
    cache.write += turn.cache.write;
    cache.write5m += turn.cache.write5m;
    cache.write1h += turn.cache.write1h;
  };
  let elidedCount = 0;
  let idleTurns = 0;
  let reason: WorkerFinishReason = "error";
  let summary = "";
  let openQuestions: string[] = [];
  let followUps: string[] = [];
  let stop: WorkerStopReason | null = null;
  const resultLog: Array<{ call: ToolCall; text: string }> = [];

  try {
    for (;;) {
      if (box.signal.aborted) {
        reason = box.timedOut() ? "time_limit" : "aborted";
        break;
      }
      let turn: Turn;
      try {
        turn = await adapter.next(box.signal);
      } catch (error) {
        if (box.signal.aborted) {
          reason = box.timedOut() ? "time_limit" : "aborted";
        } else {
          console.error("[research] worker model call failed", {
            model: opts.label,
            worker: input.brief.delegation.workerId,
            message: error instanceof Error ? error.message : String(error),
          });
          reason = "error";
        }
        break;
      }
      inputTokens += turn.inputTokens;
      outputTokens += turn.outputTokens;
      addCache(turn);

      if (turn.calls.length === 0) {
        /*
         * A worker that writes prose instead of calling a tool is usually one
         * that has finished in its own mind — but not always, and the first
         * turn is where the difference matters. The cheap agentic models the
         * worker runs on routinely open with a plan-of-attack paragraph before
         * their first search, and stopping on that paragraph is a worker that
         * never worked. So every prose turn gets the same nudge, and only a
         * worker that keeps answering in prose is stopped. One that never made
         * a call finishes `idle` rather than `done`, so the round can tell an
         * empty result from an established one.
         */
        idleTurns += 1;
        if (idleTurns > MAX_IDLE_TURNS) {
          summary = summary || turn.text.trim();
          reason = toolCalls === 0 ? "idle" : "done";
          break;
        }
        adapter.pushToolResults([]);
        continue;
      }
      idleTurns = 0;

      const results: Array<{ call: ToolCall; text: string }> = [];
      let finished = false;
      for (const call of turn.calls) {
        if (finished || stop) {
          results.push({ call, text: "The worker has finished; this call was not run." });
          continue;
        }
        const parsed = parseToolArgs(call.name, call.args);
        if (!parsed.ok) {
          results.push({ call, text: `Error: ${parsed.reason}` });
          continue;
        }
        const args = parsed.parsed;
        if (args.name === "done") {
          summary = args.summary;
          openQuestions = args.openQuestions;
          followUps = args.followUps;
          reason = "done";
          finished = true;
          results.push({ call, text: "Recorded. Thank you." });
          continue;
        }
        toolCalls += 1;
        const remaining = input.limits.maxToolCalls - toolCalls;
        let text: string;
        try {
          switch (args.name) {
            case "search": {
              const out = await input.tools.search(args.query);
              text = renderSearchDigest(out.result.hits, out.result.note);
              if (out.stop) stop = out.stop;
              break;
            }
            case "open_page": {
              const out = await input.tools.openPage(args.url);
              text = out.result.ok
                ? wrapUntrusted(out.result.url, renderPageDigest(out.result))
                : `Could not open ${out.result.url}: ${out.result.reason}`;
              if (out.stop) stop = out.stop;
              break;
            }
            case "find_in_page": {
              const out = await input.tools.findInPage(args.url, args.pattern);
              text = out.result.ok
                ? wrapUntrusted(args.url, renderFindMatches(out.result.matches))
                : `Could not search that page: ${out.result.reason ?? "not opened yet"}`;
              if (out.stop) stop = out.stop;
              break;
            }
            case "note_finding": {
              const out = await input.tools.noteFinding({
                claim: args.claim,
                quote: args.quote,
                url: args.url,
                locator: args.locator,
                confidence: args.confidence,
              });
              text = out.result.ok ? "Finding recorded." : `Finding rejected: ${out.result.reason ?? "unknown"}`;
              if (out.stop) stop = out.stop;
              break;
            }
          }
        } catch (error) {
          text = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`;
        if (stop) {
          text += `\n\nThis was your last tool call (${describeStop(stop)}). Call done now with your summary.`;
        } else if (remaining <= 0) {
          stop = "tool_limit";
          text += "\n\nYou have used every tool call in your budget. Call done now with your summary.";
        } else if (remaining <= 3) {
          text += `\n\n(${remaining} tool call${remaining === 1 ? "" : "s"} left — wrap up and call done.)`;
        }
        results.push({ call, text });
      }
      resultLog.push(...results);
      adapter.pushToolResults(results);
      const elideTo = nextElidedCount(resultLog.length, resultsToKeep(resultLog), elidedCount);
      if (elideTo > elidedCount) {
        elidedCount = elideTo;
        adapter.elideOldResults(resultLog.length - elideTo);
      }
      if (finished) break;
      if (stop) {
        // One more turn so the model can say what it established, then out.
        let last: Turn | null = null;
        try {
          last = await adapter.next(box.signal);
        } catch {
          last = null;
        }
        if (last) {
          inputTokens += last.inputTokens;
          outputTokens += last.outputTokens;
          addCache(last);
          const done = last.calls.find((call) => call.name === "done");
          const parsed = done ? parseToolArgs("done", done.args) : null;
          if (parsed?.ok && parsed.parsed.name === "done") {
            summary = parsed.parsed.summary;
            openQuestions = parsed.parsed.openQuestions;
            followUps = parsed.parsed.followUps;
          } else if (last.text.trim()) {
            summary = last.text.trim();
          }
        }
        reason = stop;
        break;
      }
    }
  } finally {
    box.release();
  }

  return {
    summary,
    openQuestions,
    followUps,
    reason,
    toolCalls,
    elapsedMs: Date.now() - startedAt,
    inputTokens,
    outputTokens,
    cache,
    resultChars: resultLog.reduce((n, r) => n + r.text.length, 0),
  };
}

/**
 * The worker's Anthropic request, cached. Here rather than in worker.ts so a
 * test can check its shape (that file is `server-only`).
 *
 * A worker makes dozens of calls that each re-send the whole transcript, so
 * without breakpoints every call paid full input for every earlier page
 * digest. Three markers: the last tool and the system block (the same for
 * every worker, so parallel workers share them), and the newest message,
 * moved every request so call N+1 reads what call N wrote. 5-minute TTL: the
 * calls are seconds apart. The loop elides old results in batches
 * (`nextElidedCount`) so the prefix holds between jumps.
 */
export function anthropicWorkerRequest(
  model: { providerModel: string },
  system: string,
  messages: readonly Anthropic.MessageParam[]
): Anthropic.MessageCreateParamsNonStreaming {
  const ephemeral = { type: "ephemeral" as const };
  return {
    model: model.providerModel,
    max_tokens: 2_048,
    system: [{ type: "text" as const, text: system, cache_control: ephemeral }],
    messages: withConversationCacheBreakpoint(messages),
    tools: WORKER_TOOLS.map((tool, i, all) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as { type: "object"; [key: string]: unknown },
      ...(i === all.length - 1 ? { cache_control: ephemeral } : {}),
    })),
    tool_choice: { type: "auto" as const },
  };
}

function describeStop(stop: WorkerStopReason): string {
  switch (stop) {
    case "tool_limit":
      return "tool budget spent";
    case "time_limit":
      return "out of time";
    case "budget":
      return "the run's money is spent";
    case "page_limit":
      return "the run has read every page its tier allows";
    case "aborted":
      return "the run was stopped";
  }
}
