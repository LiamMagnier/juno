/**
 * The one tool dispatcher every adapter calls after a round ends in tool calls
 * (chat-rework SPEC §4.2; design §6.4).
 *
 * The four adapters keep their own wire code — how a call streams in, how a
 * result goes back — and hand everything in between to this module: parse the
 * arguments (invalid JSON is answered, never run as `{}`), resolve the tool
 * (an unknown name is refused), validate against its schema, look the call up
 * in the turn's duplicate cache, run consecutive parallel-safe reads together
 * (at most four in flight) and everything else in call order, start each
 * tool's timer only once it is authorised, forward its progress, and turn
 * whatever happened into a result the model can act on. A failure is a result,
 * never a thrown error. Results come back in CALL order.
 *
 * AUTHORISATION IS NOT HERE. It stays in the executors that already hold it —
 * the connector chokepoint (`mcp.ts`), the runtime registry's broker
 * (`agent/runtime.ts`) and the native tools' own approval flows — which the
 * static approval gate (`scripts/check-approval-dispatch.mjs`) inventories.
 * The executor tells the dispatcher when authorisation is over
 * (`onAuthorized`), and only then does the tool's timer start: an approval can
 * wait as long as its receipt lives, and is never cut short by a tool budget.
 *
 * STOP. When the turn signal aborts, every call that has not finished gets a
 * `cancelled` result — the ones that never started and the ones that were
 * running — and only then does the generator throw the abort, so a transcript
 * never ends on a call nobody answered (agent-core's rule, loop.ts).
 *
 * Free of `server-only`: the adapters' tool loops and their scripted-transport
 * tests import it.
 */

import { PRODUCT_NAME } from "@/lib/brand/names";
import {
  CANCELLED_BEFORE_RUN_TEXT,
  CANCELLED_WHILE_RUNNING_TEXT,
  timeoutText,
  toolErrorText,
  unknownToolText,
} from "@/lib/tools/dispatch.prompt";
import {
  TOOL_PROGRESS_MAX_LINES,
  TOOL_PROGRESS_MAX_LINE_CHARS,
  TOOL_PROGRESS_MIN_INTERVAL_MS,
  type BatchResult,
  type ChatToolset,
  type ResolvedTool,
  type ToolCallInput,
  type ToolErrorCode,
  type ToolOutcome,
  type ToolOutcomeStatus,
  type ToolProgress,
} from "@/lib/tools/types";
import { parseToolArguments, portableArgumentsProblem, shallowArgumentsProblem } from "@/lib/tools/validate";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { ToolExecution } from "@/lib/mcp";
import { wrapUntrusted } from "@/lib/untrusted-content";
import { canonicalize } from "@/lib/work/canonical";
import type { LlmEvent } from "@/types/llm";

/**
 * Appended to the last result of a batch when the next request is the forced
 * tools-off one, OUTSIDE the untrusted envelope (SPEC §4.6). This one placement
 * works on every provider: it never adds a user text block after tool results
 * (Anthropic rejects that when a server tool is unresolved) and never puts a
 * user message after a tool message (Mistral rejects that).
 */
export const FINAL_ROUND_NOTE = `[${PRODUCT_NAME}: this is the last step. Do not call tools. Answer the user now from what you have, and say briefly what you could not check.]`;

/** Most calls of one parallel group in flight at once (SPEC DECISIONS T5). */
export const MAX_PARALLEL_CALLS = 4;
/** A thrown error's message is cut to this before it reaches the model. */
const ERROR_MESSAGE_CHARS = 2_000;

export interface ToolBatchContext {
  toolset: ChatToolset;
  /** Per turn: identical calls return the first outcome (SPEC §4.5). */
  cache: Map<string, ToolOutcome>;
  /** The next provider request is the forced tools-off one. */
  nextIsFinal?: boolean;
  /** Injected clock, for the progress rate limit in tests. */
  now?: () => number;
}

/** A call after parse, resolve and validate: ready to run, or already answered. */
type PreparedCall =
  | { call: ToolCallInput; ok: true; args: Record<string, unknown>; tool: ResolvedTool; dedupeKey: string | null }
  | { call: ToolCallInput; ok: false; code: ToolErrorCode; text: string; tool?: ResolvedTool };

type ReadyCall = Extract<PreparedCall, { ok: true }>;

function prepare(call: ToolCallInput, toolset: ChatToolset): PreparedCall {
  const tool = toolset.resolve(call.name);
  if (!tool) return { call, ok: false, code: "unknown_tool", text: unknownToolText(call.name) };
  const parsed = parseToolArguments(call.argsText);
  if (!parsed.ok) return { call, ok: false, code: "invalid_args", text: parsed.text, tool };
  const problem = tool.input
    ? portableArgumentsProblem(parsed.args, tool.input)
    : shallowArgumentsProblem(parsed.args, tool.inputSchema);
  if (problem) return { call, ok: false, code: "invalid_args", text: problem, tool };
  // Keyed by the function name, unique per toolset — two connectors' `{}`
  // calls must never share an entry (SPEC §4.5).
  const dedupeKey = tool.dedupe ? `${tool.name}:${canonicalize(parsed.args)}` : null;
  return { call, ok: true, args: parsed.args, tool, dedupeKey };
}

/** Consecutive parallel-safe reads form one group; every other call is a group of one. */
function groupsOf(prepared: readonly PreparedCall[]): PreparedCall[][] {
  const groups: PreparedCall[][] = [];
  let run: PreparedCall[] = [];
  for (const entry of prepared) {
    if (entry.ok && entry.tool.parallelSafe && entry.tool.risk === "read") {
      run.push(entry);
      continue;
    }
    if (run.length) groups.push(run);
    run = [];
    groups.push([entry]);
  }
  if (run.length) groups.push(run);
  return groups;
}

function failedOutcome(code: ToolErrorCode, text: string, status: ToolOutcomeStatus = "failed"): ToolOutcome {
  return { status, text, body: text, error: { code } };
}

function outcomeFromExecution(exec: ToolExecution): ToolOutcome {
  const status: ToolOutcomeStatus = exec.status ?? (exec.ok ? "succeeded" : "failed");
  const code: ToolErrorCode | undefined =
    status === "succeeded"
      ? undefined
      : (exec.error?.code ?? (status === "failed" ? "tool_error" : status === "outcome_unknown" ? "outcome_unknown" : status));
  return {
    status,
    text: exec.text,
    body: exec.body,
    ...(exec.images?.length ? { images: exec.images } : {}),
    ...(code ? { error: { code } } : {}),
    ...(exec.durationMs === undefined ? {} : { durationMs: exec.durationMs }),
    ...(exec.run ? { run: exec.run } : {}),
  };
}

class ToolTimeout extends Error {
  constructor() {
    super("timeout");
    this.name = "ToolTimeout";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Races `work` against `signal`, so a tool that ignores its signal still ends. */
function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Cut a progress frame to its bounds: the last lines, each one line and short. */
export function boundedProgress(progress: ToolProgress): ToolProgress {
  const lines = progress.lines
    .slice(-TOOL_PROGRESS_MAX_LINES)
    .map((line) => ({
      stream: line.stream === "stderr" ? ("stderr" as const) : ("stdout" as const),
      text: line.text.replace(/[\r\n]+/g, " ").slice(0, TOOL_PROGRESS_MAX_LINE_CHARS),
    }));
  return {
    lines,
    ...(typeof progress.stdoutBytes === "number" ? { stdoutBytes: progress.stdoutBytes } : {}),
    ...(typeof progress.stderrBytes === "number" ? { stderrBytes: progress.stderrBytes } : {}),
  };
}

/** Events from concurrently running calls, drained by the generator in arrival order. */
class EventChannel {
  private readonly items: LlmEvent[] = [];
  private wake: (() => void) | null = null;

  push(event: LlmEvent): void {
    this.items.push(event);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  drain(): LlmEvent[] {
    return this.items.splice(0, this.items.length);
  }

  /** Resolves when an event arrives or `done` settles, whichever is first. */
  wait(done: Promise<unknown>): Promise<void> {
    if (this.items.length) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      done.then(
        () => resolve(),
        () => resolve(),
      );
    });
  }
}

/**
 * Run one round's calls. Yields `tool` status, progress and result events as
 * they happen and returns the results in call order. Throws only when the turn
 * signal is aborted, and only after every call has been answered `cancelled`.
 */
export async function* executeToolBatch(
  calls: readonly ToolCallInput[],
  signal: AbortSignal,
  ctx: ToolBatchContext,
): AsyncGenerator<LlmEvent, BatchResult[]> {
  const prepared = calls.map((call) => prepare(call, ctx.toolset));
  const channel = new EventChannel();
  const results = new Array<BatchResult>(prepared.length);
  const inflight = new Map<string, Promise<void>>();
  const position = new Map(prepared.map((entry, i) => [entry, i]));

  // Every runnable row is queued at once, before any of them runs.
  for (const entry of prepared) {
    if (!entry.ok) continue;
    yield {
      type: "tool",
      phase: "status",
      server: ctx.toolset.labelFor(entry.call.name),
      name: entry.call.name,
      callId: entry.call.callId,
      status: "queued",
    };
  }

  for (const group of groupsOf(prepared)) {
    let next = 0;
    const worker = async () => {
      while (next < group.length) {
        const entry = group[next++];
        results[position.get(entry)!] = await runCall(entry, signal, ctx, channel, inflight);
      }
    };
    const done = Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_CALLS, group.length) }, worker));
    let settled = false;
    void done.finally(() => (settled = true)).catch(() => undefined);
    while (!settled) {
      await channel.wait(done);
      for (const event of channel.drain()) yield event;
    }
    await done;
    for (const event of channel.drain()) yield event;
  }

  const last = results.at(-1);
  if (ctx.nextIsFinal && last) last.text = `${last.text}\n\n${FINAL_ROUND_NOTE}`;

  if (signal.aborted) throw abortReason(signal);
  return results;
}

async function runCall(
  entry: PreparedCall,
  signal: AbortSignal,
  ctx: ToolBatchContext,
  channel: EventChannel,
  inflight: Map<string, Promise<void>>,
): Promise<BatchResult> {
  const { call } = entry;
  const server = ctx.toolset.labelFor(call.name);

  const finish = (outcome: ToolOutcome, opts: { cached?: boolean } = {}): BatchResult => {
    channel.push({
      type: "tool",
      phase: "result",
      server,
      name: call.name,
      callId: call.callId,
      ...(call.providerCallId && call.providerCallId !== call.callId ? { providerCallId: call.providerCallId } : {}),
      round: call.round,
      index: call.index,
      args: call.argsText,
      result: outcome.body,
      ok: outcome.status === "succeeded",
      status: outcome.status,
      ...(outcome.error ? { error: { code: outcome.error.code } } : {}),
      ...(outcome.durationMs === undefined || opts.cached ? {} : { durationMs: outcome.durationMs }),
      ...(outcome.run ? { run: outcome.run } : {}),
      ...(opts.cached ? { cached: true } : {}),
    });
    return {
      callId: call.callId,
      name: call.name,
      ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
      text: outcome.text,
      isError: outcome.status !== "succeeded",
      images: outcome.images ?? [],
      status: outcome.status,
      ...(outcome.error ? { errorCode: outcome.error.code } : {}),
    };
  };

  if (!entry.ok) return finish(failedOutcome(entry.code, entry.text));
  if (signal.aborted) return finish(failedOutcome("cancelled", CANCELLED_BEFORE_RUN_TEXT, "cancelled"));

  // A duplicate still running in this batch finishes first; then the cache decides.
  if (entry.dedupeKey) {
    const earlier = inflight.get(entry.dedupeKey);
    if (earlier) await earlier;
    const cached = ctx.cache.get(entry.dedupeKey);
    // The first call was authorised and ran; a repeat runs nothing.
    if (cached) return finish(cached, { cached: true });
    if (signal.aborted) return finish(failedOutcome("cancelled", CANCELLED_BEFORE_RUN_TEXT, "cancelled"));
  }

  let release: () => void = () => {};
  if (entry.dedupeKey) inflight.set(entry.dedupeKey, new Promise<void>((resolve) => (release = resolve)));
  try {
    const outcome = await execute(entry, signal, ctx, channel, server);
    if (entry.dedupeKey && outcome.status === "succeeded") ctx.cache.set(entry.dedupeKey, outcome);
    return finish(outcome);
  } finally {
    if (entry.dedupeKey) inflight.delete(entry.dedupeKey);
    release();
  }
}

/** Run one call through its executor; every way it can end is an outcome. */
async function execute(
  entry: ReadyCall,
  turn: AbortSignal,
  ctx: ToolBatchContext,
  channel: EventChannel,
  server: string,
): Promise<ToolOutcome> {
  const { call, tool, args } = entry;
  const now = ctx.now ?? Date.now;

  // The executor's signal: the turn's abort, plus the tool's own timer once it
  // is armed. Authorisation waits on it too, which is safe because the timer
  // is armed only after authorisation.
  const controller = new AbortController();
  const onTurnAbort = () => controller.abort(abortReason(turn));
  if (turn.aborted) onTurnAbort();
  else turn.addEventListener("abort", onTurnAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let startedAt: number | null = null;
  let lastProgressAt = Number.NEGATIVE_INFINITY;

  const onAuthorized = () => {
    if (running) return;
    running = true;
    startedAt = now();
    channel.push({ type: "tool", phase: "status", server, name: call.name, callId: call.callId, status: "running", timeoutMs: tool.timeoutMs });
    timer = setTimeout(() => controller.abort(new ToolTimeout()), tool.timeoutMs);
    timer.unref?.();
  };
  const onApprovalRequest = (_approval: ClientActionApproval) => {
    channel.push({ type: "tool", phase: "status", server, name: call.name, callId: call.callId, status: "awaiting_approval" });
  };
  const reportProgress = (progress: ToolProgress) => {
    if (controller.signal.aborted) return;
    const at = now();
    if (at - lastProgressAt < TOOL_PROGRESS_MIN_INTERVAL_MS) return;
    lastProgressAt = at;
    channel.push({ type: "tool", phase: "progress", server, name: call.name, callId: call.callId, progress: boundedProgress(progress) });
  };

  try {
    const exec = await raceSignal(
      ctx.toolset.execute(call.name, args, controller.signal, call.callId, {
        onApprovalRequest,
        onAuthorized,
        timeoutMs: tool.timeoutMs,
        reportProgress,
        round: call.round,
      }),
      controller.signal,
    );
    const outcome = outcomeFromExecution(exec);
    if (outcome.durationMs === undefined && startedAt !== null) return { ...outcome, durationMs: now() - startedAt };
    return outcome;
  } catch (error) {
    if (turn.aborted) {
      return failedOutcome("cancelled", running ? CANCELLED_WHILE_RUNNING_TEXT : CANCELLED_BEFORE_RUN_TEXT, "cancelled");
    }
    const elapsed = startedAt === null ? {} : { durationMs: now() - startedAt };
    if (controller.signal.reason instanceof ToolTimeout) {
      return { ...failedOutcome("timeout", timeoutText(tool.timeoutMs)), ...elapsed };
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MESSAGE_CHARS);
    const body = toolErrorText(message);
    // A connector's error message is its text too, so it goes inside the envelope.
    const text = tool.origin === "connector" ? wrapUntrusted(server, body) : body;
    return { status: "failed", text, body, error: { code: "tool_error" }, ...elapsed };
  } finally {
    if (timer) clearTimeout(timer);
    turn.removeEventListener("abort", onTurnAbort);
  }
}
