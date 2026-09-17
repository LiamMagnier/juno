import { WORKER_CONTEXT_CHARS } from "@/lib/research/domain";
import {
  parseToolArgs,
  renderFindMatches,
  renderPageDigest,
  renderSearchDigest,
  type RunWorkerInput,
  type WorkerFinishReason,
  type WorkerStopReason,
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
      adapter.elideOldResults(resultsToKeep(resultLog));
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
    resultChars: resultLog.reduce((n, r) => n + r.text.length, 0),
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
