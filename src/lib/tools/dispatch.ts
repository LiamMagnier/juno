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
  BROKER_UNAVAILABLE_TEXT,
  CACHED_RESULT_NOTE,
  CANCELLED_BEFORE_RUN_TEXT,
  CANCELLED_WHILE_RUNNING_EFFECT_TEXT,
  CANCELLED_WHILE_RUNNING_TEXT,
  DENIED_TEXT,
  EXPIRED_TEXT,
  blockedText,
  internalToolErrorText,
  invalidJsonText,
  oversizedResultText,
  timeoutText,
  tooManyCallsText,
  toolErrorText,
  unknownToolText,
} from "@/lib/tools/dispatch.prompt";
import { auditArgsForJunoTool } from "@/lib/tools/audit-args";
import { withoutEnvelope } from "@/lib/tools/specs/shared";
import {
  TOOL_PROGRESS_MAX_LINES,
  TOOL_PROGRESS_MAX_LINE_CHARS,
  TOOL_PROGRESS_MIN_INTERVAL_MS,
  type BatchResult,
  type ChatToolset,
  type ResolvedTool,
  type ToolCallInput,
  type ToolContext,
  type ToolErrorCode,
  type ToolOutcome,
  type ToolOutcomeStatus,
  type ToolProgress,
  type ToolSpec,
} from "@/lib/tools/types";
import {
  coercePortableArguments,
  parseToolArguments,
  portableArgumentsProblem,
  shallowArgumentsProblem,
} from "@/lib/tools/validate";
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
/**
 * Most calls one response may have considered. A model that emits hundreds of
 * calls at once (it costs it a few thousand tokens) would otherwise queue
 * hundreds of rows, approvals and runs on one turn; the rest are answered —
 * every provider needs a result per call — and nothing of theirs runs.
 */
export const MAX_CALLS_PER_ROUND = 32;
/** A thrown error's message is cut to this before it reaches the model. */
const ERROR_MESSAGE_CHARS = 2_000;
/**
 * The most model-facing text one result may carry. Every tool that exists
 * bounds itself well below this (connectors 30k, documents 60k, code 34k); the
 * ceiling is for the one that does not, because an unbounded result is a
 * provider request that fails the whole turn and memory this host cannot
 * spare. Over it, the text is WITHHELD rather than cut: a cut could split the
 * untrusted envelope and leave it open.
 */
export const MAX_TOOL_RESULT_CHARS = 100_000;

export type { BatchResult, ToolCallInput };

export type BrokeredActionAuthorization =
  | { kind: "authorized"; receiptId: string | null; riskClass?: string }
  | { kind: "replay"; receiptId: string; result: string; failed: boolean }
  | { kind: "refused"; receiptId: string | null; reason: string; status?: string };

export interface ToolBatchPorts {
  authorizeExternalAction?: (request: Record<string, unknown>) => Promise<BrokeredActionAuthorization>;
  completeExternalAction?: (request: Record<string, unknown>) => Promise<unknown>;
  recordToolInvocation?: (request: Record<string, unknown>) => Promise<string | null>;
  settleToolInvocation?: (id: string | null, outcome?: Record<string, unknown>) => Promise<unknown>;
  resolvedPolicy?: unknown;
  [key: string]: unknown;
}

export interface ToolBatchContext {
  toolset: ChatToolset;
  /** Per turn: identical calls return the first outcome (SPEC §4.5). */
  cache?: Map<string, ToolOutcome>;
  /** The next provider request is the forced tools-off one. */
  nextIsFinal?: boolean;
  /** Injected clock, for the progress rate limit in tests. */
  now?: () => number;
  /** Unique call IDs issued across rounds in this turn (SPEC §4.1). */
  seenCallIds?: Set<string>;
  toolContext?: Partial<ToolContext> | Record<string, unknown>;
  fees?: unknown;
  ports?: ToolBatchPorts;
}

export type BatchContext = ToolBatchContext & {
  ports: ToolBatchPorts;
};

/** A call after parse, resolve and validate: ready to run, or already answered. */
type PreparedCall =
  | { call: ToolCallInput; ok: true; args: Record<string, unknown>; tool: ResolvedTool; dedupeKey: string | null }
  | { call: ToolCallInput; ok: false; code: ToolErrorCode; text: string; tool?: ResolvedTool };

type ReadyCall = Extract<PreparedCall, { ok: true }>;

function prepare(call: ToolCallInput, toolset: ChatToolset): PreparedCall {
  const tool = toolset.resolve(call.name);
  if (!tool) return { call, ok: false, code: "unknown_tool", text: unknownToolText(call.name) };
  // Whatever a provider sent, preparing it must not throw: a throw here would
  // leave every call of the batch unanswered. Arguments nested deep enough to
  // overflow the stack in the checks below are malformed, and answered so.
  try {
    const parsed = parseToolArguments(call.argsText);
    if (!parsed.ok) return { call, ok: false, code: "invalid_args", text: parsed.text, tool };
    const problem = tool.input
      ? portableArgumentsProblem(parsed.args, tool.input)
      : shallowArgumentsProblem(parsed.args, tool.inputSchema);
    if (problem) return { call, ok: false, code: "invalid_args", text: problem, tool };
    // An Alevr tool runs with every value in its declared type ("false" is
    // false, "5" is 5): see `coercePortableArguments`.
    const args = tool.input ? coercePortableArguments(parsed.args, tool.input) : parsed.args;
    // Keyed by the function name, unique per toolset — two connectors' `{}`
    // calls must never share an entry (SPEC §4.5).
    const dedupeKey = tool.dedupe ? `${tool.name}:${canonicalize(args)}` : null;
    return { call, ok: true, args, tool, dedupeKey };
  } catch (error) {
    const reason = error instanceof RangeError ? "nested too deeply" : "could not be read";
    return { call, ok: false, code: "invalid_args", text: invalidJsonText(reason), tool };
  }
}

/** A call that may change something: after a timeout or a Stop mid-run its effect is not known. */
function mayHaveTakenEffect(tool: ResolvedTool): boolean {
  return tool.risk !== "read";
}

/** The ceiling on model-facing text (MAX_TOOL_RESULT_CHARS), applied to every outcome. */
function boundedOutcome(outcome: ToolOutcome): ToolOutcome {
  if (outcome.text.length <= MAX_TOOL_RESULT_CHARS) return outcome;
  const text = oversizedResultText(outcome.text.length, MAX_TOOL_RESULT_CHARS);
  return {
    ...outcome,
    text,
    // The panel's copy has no envelope to break, so it keeps a head.
    body: outcome.body.length > MAX_TOOL_RESULT_CHARS ? `${outcome.body.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n${text}` : outcome.body,
  };
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
  /*
   * The batch's own signal: the turn's abort, and also this generator being
   * ABANDONED — a consumer that throws or breaks out of its loop calls
   * `return()` at a yield, and the calls still running would otherwise go on
   * running (and acting) for a turn that is over. The `finally` below aborts
   * them; they settle as `cancelled` into a channel nobody reads.
   */
  const batch = new AbortController();
  const onTurnAbort = () => batch.abort(abortReason(signal));
  if (signal.aborted) onTurnAbort();
  else signal.addEventListener("abort", onTurnAbort, { once: true });
  let completed = false;

  try {
    ctx.cache ??= new Map();
    const prepared = calls.map((call, i): PreparedCall =>
      i < MAX_CALLS_PER_ROUND ? prepare(call, ctx.toolset) : { call, ok: false, code: "budget", text: tooManyCallsText(MAX_CALLS_PER_ROUND) },
    );
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
          results[position.get(entry)!] = await runCall(entry, batch.signal, ctx, channel, inflight);
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

    completed = true;
    if (signal.aborted) throw abortReason(signal);
    return results;
  } finally {
    signal.removeEventListener("abort", onTurnAbort);
    if (!completed && !batch.signal.aborted) batch.abort(new DOMException("The tool batch was abandoned.", "AbortError"));
  }
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

  const cache = (ctx.cache ??= new Map());
  // A duplicate still running in this batch finishes first; then the cache decides.
  if (entry.dedupeKey) {
    const earlier = inflight.get(entry.dedupeKey);
    if (earlier) await earlier;
    const cached = cache.get(entry.dedupeKey);
    // The first call was authorised and ran; a repeat runs nothing, and the
    // model is told so (CACHED_RESULT_NOTE) rather than handed a stale answer
    // as a fresh one.
    if (cached) return finish({ ...cached, text: `${cached.text}\n\n${CACHED_RESULT_NOTE}` }, { cached: true });
    if (signal.aborted) return finish(failedOutcome("cancelled", CANCELLED_BEFORE_RUN_TEXT, "cancelled"));
  }

  let release: () => void = () => {};
  if (entry.dedupeKey) inflight.set(entry.dedupeKey, new Promise<void>((resolve) => (release = resolve)));
  try {
    const outcome = boundedOutcome(await execute(entry, signal, ctx, channel, server));
    // A call that may change state (a write, or a run that shares a
    // workspace) makes every earlier answer stale: "list, create, list" must
    // list again, not replay the first list.
    if (!(entry.tool.parallelSafe && entry.tool.risk === "read")) cache.clear();
    if (entry.dedupeKey && outcome.status === "succeeded") cache.set(entry.dedupeKey, outcome);
    return finish(outcome);
  } finally {
    if (entry.dedupeKey) inflight.delete(entry.dedupeKey);
    release();
  }
}

function auditArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  try {
    return auditArgsForJunoTool(spec, args) as unknown as Record<string, unknown>;
  } catch {
    return { tool: spec.id, n: Object.keys(args).length };
  }
}

export function refusalOutcome(status: string | undefined, reason: string): ToolOutcome {
  switch (status) {
    case "denied":
      return { status: "denied", text: DENIED_TEXT, body: reason, error: { code: "denied" } };
    case "expired":
      return { status: "expired", text: EXPIRED_TEXT, body: reason, error: { code: "expired" } };
    case "blocked":
      return { status: "failed", text: blockedText(reason), body: reason, error: { code: "blocked" } };
    case "superseded":
      return { status: "cancelled", text: CANCELLED_BEFORE_RUN_TEXT, body: reason, error: { code: "cancelled" } };
    default:
      return { status: "failed", text: reason, body: reason, error: { code: "not_permitted" } };
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
  // Once the call has an outcome, nothing the executor reports may reach the
  // stream: a late `running` after the result would hold the stall watchdog
  // for the rest of the turn, and late progress would reopen a closed row.
  let settled = false;
  let startedAt: number | null = null;
  let lastProgressAt = Number.NEGATIVE_INFINITY;

  const onAuthorized = () => {
    if (running || settled) return;
    running = true;
    startedAt = now();
    channel.push({ type: "tool", phase: "status", server, name: call.name, callId: call.callId, status: "running", timeoutMs: tool.timeoutMs });
    timer = setTimeout(() => controller.abort(new ToolTimeout()), tool.timeoutMs);
    timer.unref?.();
  };
  const onApprovalRequest = (approval: ClientActionApproval) => {
    if (settled) return;
    channel.push({ type: "tool", phase: "status", server, name: call.name, callId: call.callId, status: "awaiting_approval", approval });
  };
  const reportProgress = (progress: ToolProgress) => {
    if (settled || controller.signal.aborted) return;
    const at = now();
    if (at - lastProgressAt < TOOL_PROGRESS_MIN_INTERVAL_MS) return;
    lastProgressAt = at;
    channel.push({ type: "tool", phase: "progress", server, name: call.name, callId: call.callId, progress: boundedProgress(progress) });
  };

  const spec = tool.spec && (tool.spec.broker === "juno_runtime" || tool.spec.broker === "none") ? tool.spec : null;

  try {
    if (spec) {
      const context = (ctx.toolContext ?? {}) as Record<string, unknown>;
      const brokered = spec.broker === "juno_runtime" && !context.private;

      let auditId: string | null = null;
      let receiptId: string | null = null;
      if (brokered) {
        if (!ctx.ports?.authorizeExternalAction) {
          return failedOutcome("not_permitted", BROKER_UNAVAILABLE_TEXT);
        }

        if (ctx.ports?.recordToolInvocation) {
          auditId = await ctx.ports.recordToolInvocation({
            userId: context.userId ?? "",
            conversationId: context.conversationId ?? null,
            connectorId: "juno_runtime",
            toolName: spec.id,
            functionName: spec.id,
            access: spec.risk === "read" ? "read" : "write",
            args: auditArgs(spec, args),
            derivedFromUntrusted: true,
            status: "executed",
          });
        }

        const authorization = await ctx.ports.authorizeExternalAction({
          userId: context.userId ?? "",
          surface: "chat",
          sessionId: context.generationId ?? "",
          conversationId: context.conversationId ?? null,
          projectId: context.projectId ?? null,
          connectorId: "juno_runtime",
          connectorLabel: "Juno",
          toolName: spec.id,
          functionName: spec.id,
          args,
          callId: call.callId,
          provenance: {
            source: context.conversationId ? `conversation:${context.conversationId}` : `session:${context.generationId}`,
            sourceKind: "model_tool_call",
            derivedFromUntrusted: true,
          },
          signal: turn,
          onApprovalRequest,
          unattended: false,
          resolvedPolicy: ctx.ports.resolvedPolicy,
        });
        if (authorization.kind === "refused") {
          await ctx.ports.settleToolInvocation?.(auditId, {
            status: authorization.status === "denied" ? "denied" : "failed",
            error: authorization.reason,
          });
          if (turn.aborted) throw abortReason(turn);
          return refusalOutcome(authorization.status, authorization.reason);
        }
        if (authorization.kind === "replay") {
          await ctx.ports.settleToolInvocation?.(auditId, {
            status: authorization.failed ? "failed" : "executed",
            ...(authorization.failed ? { error: authorization.result } : {}),
          });
          const body = withoutEnvelope(authorization.result);
          return authorization.failed
            ? { status: "failed", text: authorization.result, body, error: { code: "tool_error" } }
            : { status: "succeeded", text: authorization.result, body };
        }
        receiptId = authorization.receiptId;
      }

      onAuthorized();
      let outcome: ToolOutcome | undefined;
      try {
        const outcomeOrExec = await raceSignal(
          spec.execute(args, {
            userId: String(context.userId ?? ""),
            conversationId: (context.conversationId as string | null) ?? null,
            projectId: (context.projectId as string | null) ?? null,
            ...context,
            callId: call.callId,
            round: call.round,
            signal: controller.signal,
            onApprovalRequest,
          } as ToolContext),
          controller.signal,
        );
        outcome = "status" in outcomeOrExec && typeof outcomeOrExec.status === "string" ? outcomeOrExec : outcomeFromExecution(outcomeOrExec as unknown as ToolExecution);
        if (outcome.durationMs === undefined && startedAt !== null) {
          outcome = { ...outcome, durationMs: now() - startedAt };
        }
      } finally {
        if (brokered && ctx.ports) {
          const ok = outcome?.status === "succeeded";
          await ctx.ports.completeExternalAction?.({
            userId: context.userId ?? "",
            receiptId,
            ok,
            result: (outcome?.text ?? "").slice(0, 30_000),
          });
          await ctx.ports.settleToolInvocation?.(auditId, {
            status: ok ? "executed" : "failed",
            ...(ok ? {} : { error: outcome?.body }),
            ...(outcome?.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
          });
        }
      }
      return outcome!;
    }

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
    const effect = mayHaveTakenEffect(tool);
    if (turn.aborted) {
      const text = !running ? CANCELLED_BEFORE_RUN_TEXT : effect ? CANCELLED_WHILE_RUNNING_EFFECT_TEXT : CANCELLED_WHILE_RUNNING_TEXT;
      return failedOutcome("cancelled", text, "cancelled");
    }
    const elapsed = startedAt === null ? {} : { durationMs: now() - startedAt };
    if (controller.signal.reason instanceof ToolTimeout) {
      return { ...failedOutcome("timeout", timeoutText(tool.timeoutMs, effect)), ...elapsed };
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MESSAGE_CHARS);
    if (tool.origin !== "connector") {
      // Alevr's own code threw: a bug or an infrastructure fault. Its message
      // (a database error, an internal path) stays in the server log; the
      // model and the panel get a sentence they can act on.
      console.error("[tools] a tool threw", {
        tool: tool.name,
        callId: call.callId,
        error: error instanceof Error ? error.name : typeof error,
        message: message.slice(0, 300),
      });
      const text = internalToolErrorText(effect);
      return { status: "failed", text, body: text, error: { code: "tool_error" }, ...elapsed };
    }
    // A connector's error message is its text too, so it goes inside the envelope.
    const body = toolErrorText(message);
    return { status: "failed", text: wrapUntrusted(server, body), body, error: { code: "tool_error" }, ...elapsed };
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    turn.removeEventListener("abort", onTurnAbort);
  }
}
