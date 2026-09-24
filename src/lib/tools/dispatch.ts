/**
 * The tool dispatcher every adapter calls after a round ends in tool calls
 * (SPEC §4.2).
 *
 * The adapters keep their own wire code; this is the one place that parses a
 * call's arguments, resolves its tool, authorises it, runs it and turns
 * whatever happened into a result the model can act on. A failure is a result,
 * never a thrown error: the model is told what failed and what to do next, and
 * the turn carries on.
 *
 * The algorithm, in order: parse (invalid JSON is reported, never run as
 * `{}`), resolve, validate against the tool's schema, look the call up in the
 * turn's duplicate cache, group consecutive parallel-safe reads (at most four
 * in flight), queue every row at once, then authorise and run each call. The
 * approval wait is never inside the per-tool timer: Juno's `juno_runtime`
 * tools are authorised here and timed after the yes; connector tools and
 * `start_task` authorise inside `execute` and start their own timer after
 * `onAuthorized()`. Results come back in call order, and the last one before
 * the tools-off request carries the final-round note outside the envelope.
 *
 * Everything `server-only` — the approval broker, the audit trail — arrives
 * through `BatchContext.ports`, so this module stays importable offline and
 * tests pass fakes (SPEC §13 harness rule 1). A private chat never calls them
 * (INV-32), and a saved chat whose broker is not wired runs nothing it would
 * have brokered.
 */

import type { ActionReceiptStatus, ClientActionApproval } from "@/lib/action-approval";
import type { ResolvedActionPolicy } from "@/lib/action-approval-store";
import { FINAL_ROUND_NOTE } from "@/lib/llm/loop";
import type { ToolExecution, ToolResultImage } from "@/lib/mcp";
import { auditArgsForJunoTool } from "@/lib/tools/audit-args";
import {
  BROKER_UNAVAILABLE_TEXT,
  CANCELLED_BEFORE_RUN_TEXT,
  CANCELLED_WHILE_RUNNING_TEXT,
  DENIED_TEXT,
  EXPIRED_TEXT,
  NOT_AN_OBJECT_TEXT,
  blockedText,
  invalidJsonText,
  missingFieldText,
  notInEnumText,
  notPermittedText,
  timeoutText,
  toolErrorText,
  unknownToolText,
  wrongTypeText,
} from "@/lib/tools/dispatch.prompt";
import type { ToolFeeAccumulator } from "@/lib/tools/metering";
import { withoutEnvelope } from "@/lib/tools/specs/shared";
import type {
  ChatToolset,
  PortableProperty,
  PortableSchema,
  ResolvedTool,
  ToolContext,
  ToolOutcome,
  ToolSpec,
} from "@/lib/tools/types";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { TaintSource } from "@/lib/web/taint";
import { canonicalize } from "@/lib/work/canonical";
import type { LlmEvent } from "@/types/llm";
import type { ChatSourceOrigin, ToolErrorCode, ToolPresentArgs } from "@/types/run";

export interface ToolCallInput {
  name: string;
  callId: string;
  providerCallId?: string;
  round: number;
  index: number;
  /** Raw argument text as the provider sent it; parsed and validated here. */
  argsText: string;
}

export interface BatchContext {
  toolset: ChatToolset;
  toolContext: Omit<ToolContext, "callId" | "round" | "signal" | "onApprovalRequest">;
  cache: Map<string, ToolOutcome>;          // per turn (SPEC §4.5)
  fees: ToolFeeAccumulator;
  nextIsFinal: boolean;                     // from LoopController.nextIsFinal()
  /** Per-generation set of call ids already used (SPEC §4.3). */
  seenCallIds: Set<string>;
  /** Everything server-only the dispatcher calls, injected so dispatch.ts has no server-only
   *  import and tests can pass fakes. Private chats pass `null` broker/audit ports: they are
   *  never called (INV-32). */
  ports: {
    authorizeExternalAction: typeof import("@/lib/action-approval-store").authorizeExternalAction | null;
    completeExternalAction: typeof import("@/lib/action-approval-store").completeExternalAction | null;
    recordToolInvocation: typeof import("@/lib/tool-audit").recordToolInvocation | null;
    settleToolInvocation: typeof import("@/lib/tool-audit").settleToolInvocation | null;
    /** Resolved once per turn by the route (SPEC §3.3 item 3). */
    resolvedPolicy: ResolvedActionPolicy | null;
  };
}

export interface BatchResult {
  callId: string;
  name: string;
  /** Echo of ToolCallInput.providerCallId: the id the adapter sends back to the provider. */
  providerCallId?: string;
  /** Model-facing text; for failures an instructive message. FINAL_ROUND_NOTE appended to the
   *  last result when nextIsFinal (outside the untrusted envelope). */
  text: string;
  isError: boolean;
  images: readonly ToolResultImage[];
  /** Gemini wants a structured error object. */
  errorCode?: ToolErrorCode;
}

/** Most calls of one parallel group in flight at once (DECISIONS T5). */
export const MAX_PARALLEL_CALLS = 4;
/** A thrown error's message is cut to this before it reaches the model. */
const ERROR_MESSAGE_CHARS = 2_000;
/** The receipt keeps at most this much of what a Juno tool returned. */
const RECEIPT_RESULT_CHARS = 30_000;
/** URLs taken from one connector result into the provenance ledger. */
const MAX_LEDGER_URLS_PER_RESULT = 50;
/** The dispatcher's backstop runs this long past a connector's own timer. */
const BACKSTOP_GRACE_MS = 1_000;
/** Failures that say something about the arguments, not the moment: cached like successes. */
const NON_TRANSIENT_FAILURES: ReadonlySet<ToolErrorCode> = new Set([
  "invalid_args",
  "url_not_in_prior_context",
  "url_not_allowed",
  "unsupported_content_type",
]);

type ResultStatus = ToolOutcome["status"];

/** A call after parse, resolve and validate: either ready to run, or already failed. */
type PreparedCall =
  | {
      call: ToolCallInput;
      ok: true;
      args: Record<string, unknown>;
      tool: ResolvedTool;
      present: ToolPresentArgs;
      dedupeKey: string | null;
    }
  | { call: ToolCallInput; ok: false; code: ToolErrorCode; text: string; present?: ToolPresentArgs };

type ReadyCall = Extract<PreparedCall, { ok: true }>;

// ── Parse, resolve, validate ────────────────────────────────────────────────

/**
 * The id the call is known by for the rest of the turn (SPEC §4.3). The
 * adapter stamps it; the dispatcher records it, and suffixes a repeat the
 * adapter did not catch, so no two calls of a generation ever share a broker
 * idempotency key (a reused key replays the old receipt or refuses as a
 * conflict).
 */
function uniqueCallId(call: ToolCallInput, seen: Set<string>): string {
  const base = call.callId || call.providerCallId || `jc_${call.round}_${call.index}`;
  let id = base;
  for (let n = 1; seen.has(id); n += 1) {
    id = n === 1 ? `${base}#${call.round}.${call.index}` : `${base}#${call.round}.${call.index}.${n}`;
  }
  seen.add(id);
  return id;
}

function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  // Several providers send numbers as strings; the specs coerce them.
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

/** Why `value` does not fit `property`, as the text for the model; null when it fits. */
function propertyProblem(field: string, value: unknown, property: PortableProperty): string | null {
  switch (property.type) {
    case "string":
      if (typeof value !== "string") return wrongTypeText(field, "string");
      if (property.enum && !property.enum.includes(value)) return notInEnumText(field, property.enum);
      return null;
    case "number":
      return isNumeric(value) ? null : wrongTypeText(field, "number");
    case "integer":
      return isNumeric(value) && Number.isInteger(Number(value)) ? null : wrongTypeText(field, "integer");
    case "boolean":
      return typeof value === "boolean" || value === "true" || value === "false" ? null : wrongTypeText(field, "boolean");
    case "array": {
      if (!Array.isArray(value)) return wrongTypeText(field, "array");
      for (const item of value) {
        const nested = propertyProblem(`${field}[]`, item, property.items);
        if (nested) return nested;
      }
      return null;
    }
    case "object":
      return value && typeof value === "object" && !Array.isArray(value) ? null : wrongTypeText(field, "object");
  }
}

/** Juno tools: required keys, primitive types and enum membership (SPEC §4.2 step 3). */
function portableProblem(args: Record<string, unknown>, schema: PortableSchema): string | null {
  for (const field of schema.required ?? []) {
    if (args[field] === undefined || args[field] === null) return missingFieldText(field);
  }
  for (const [field, property] of Object.entries(schema.properties)) {
    const value = args[field];
    // A model often sends null for an optional field it means to leave out.
    if (value === undefined || value === null) continue;
    const problem = propertyProblem(field, value, property);
    if (problem) return problem;
  }
  return null;
}

const PRIMITIVE_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: (value) => typeof value === "string",
  number: isNumeric,
  integer: (value) => isNumeric(value) && Number.isInteger(Number(value)),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => !!value && typeof value === "object" && !Array.isArray(value),
};

/** Connector tools: a shallow check of `required` and primitive types only. Their schemas are theirs. */
function connectorProblem(args: Record<string, unknown>, schema: Record<string, unknown> | undefined): string | null {
  if (!schema) return null;
  const required = Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [];
  for (const field of required) {
    if (args[field] === undefined) return missingFieldText(field);
  }
  const properties =
    schema.properties && typeof schema.properties === "object" ? (schema.properties as Record<string, unknown>) : {};
  for (const [field, value] of Object.entries(args)) {
    const declared = properties[field] as { type?: unknown } | undefined;
    if (value === undefined || value === null || !declared || typeof declared.type !== "string") continue;
    const check = PRIMITIVE_CHECKS[declared.type];
    if (check && !check(value)) return wrongTypeText(field, declared.type);
  }
  return null;
}

function prepare(call: ToolCallInput, toolset: ChatToolset): PreparedCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.argsText || "{}");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { call, ok: false, code: "invalid_args", text: invalidJsonText(reason) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { call, ok: false, code: "invalid_args", text: NOT_AN_OBJECT_TEXT };
  }
  const tool = toolset.resolve(call.name);
  if (!tool) return { call, ok: false, code: "unknown_tool", text: unknownToolText(call.name) };

  const args = parsed as Record<string, unknown>;
  let present: ToolPresentArgs = {};
  try {
    present = tool.present(args);
  } catch {
    // `present` must never throw; a row without its argument is still a row.
  }
  const schema = tool.input ?? tool.spec?.input;
  const problem = schema ? portableProblem(args, schema) : connectorProblem(args, tool.inputSchema);
  if (problem) return { call, ok: false, code: "invalid_args", text: problem, present };

  // Keyed by the resolved FUNCTION name, unique per toolset — never the
  // canonical id, which every connector tool shares (SPEC §4.5).
  const dedupeKey = tool.dedupe ? `${tool.name}:${canonicalize(args)}` : null;
  return { call, ok: true, args, tool, present, dedupeKey };
}

function cacheable(outcome: ToolOutcome): boolean {
  if (outcome.status === "succeeded") return true;
  return outcome.status === "failed" && !!outcome.error && NON_TRANSIENT_FAILURES.has(outcome.error.code);
}

/** Consecutive parallel-safe reads form one group; every other call is a group of one (§4.2 step 5). */
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

// ── Outcomes ────────────────────────────────────────────────────────────────

function sourceOrigin(tool: ResolvedTool): ChatSourceOrigin | undefined {
  if (tool.canonical === "web_search") return "juno_search";
  if (tool.canonical === "web_fetch") return "juno_fetch";
  return undefined;
}

function outcomeFromExecution(exec: ToolExecution): ToolOutcome {
  const status: ResultStatus = exec.status ?? (exec.ok ? "succeeded" : "failed");
  const code: ToolErrorCode | undefined =
    status === "succeeded" ? undefined : exec.error?.code ?? (status === "failed" ? "tool_error" : status);
  return {
    status,
    text: exec.text,
    body: exec.body,
    ...(exec.images?.length ? { images: exec.images } : {}),
    ...(exec.sources?.length ? { sources: exec.sources } : {}),
    ...(exec.figure ? { figure: exec.figure } : {}),
    ...(exec.web ? { web: exec.web } : {}),
    ...(code ? { error: { code } } : {}),
    ...(exec.durationMs === undefined ? {} : { durationMs: exec.durationMs }),
    ...(exec.feeMicroUsd === undefined ? {} : { feeMicroUsd: exec.feeMicroUsd }),
  };
}

function failedOutcome(code: ToolErrorCode, text: string, status: ResultStatus = "failed"): ToolOutcome {
  return { status, text, body: text, error: { code } };
}

/** A broker refusal as the tool record's status and code (SPEC §2.5). */
export function refusalOutcome(status: ActionReceiptStatus | undefined, reason: string): ToolOutcome {
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
      return { status: "failed", text: notPermittedText(reason), body: reason, error: { code: "not_permitted" } };
  }
}

class TimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "TimeoutError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Races `work` against the turn's abort and a timer, so a tool that ignores its signal still ends. */
function bounded<T>(work: Promise<T>, turn: AbortSignal, timer: Promise<never> | null): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onTurn = () => reject(abortReason(turn));
    if (turn.aborted) return onTurn();
    turn.addEventListener("abort", onTurn, { once: true });
    const settle = (fn: () => void) => {
      turn.removeEventListener("abort", onTurn);
      fn();
    };
    timer?.catch((error) => settle(() => reject(error)));
    work.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

/** A timer that rejects with `TimeoutError`, and the handle that clears it. */
function timeoutAfter(ms: number): { promise: Promise<never>; clear: () => void } {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new TimeoutError()), ms);
  });
  // A timer nobody raced must not become an unhandled rejection.
  promise.catch(() => undefined);
  return {
    promise,
    clear: () => {
      if (handle) clearTimeout(handle);
    },
  };
}

/** Absolute URLs in a connector's result, for the provenance ledger (SPEC §6.2 `connector_result`). */
function urlsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]}]+/gi)) {
    found.add(match[0].replace(/[.,;:!?]+$/, ""));
    if (found.size >= MAX_LEDGER_URLS_PER_RESULT) break;
  }
  return [...found];
}

/** Which taint source a successful outcome marks, if any (SPEC §4.2 step 10, §6.5). */
function taintSourceFor(tool: ResolvedTool, outcome: ToolOutcome): TaintSource | null {
  if (outcome.status !== "succeeded") return null;
  if (tool.origin === "connector") return "connector";
  const counted = outcome.figure?.n ?? 0;
  switch (tool.canonical) {
    case "web_fetch":
      return "web_fetch";
    case "web_search":
      return counted > 0 ? "web_search" : null;
    case "search_chats":
      return counted > 0 ? "search_chats" : null;
    case "read_document":
      return "read_document";
    default:
      return null;
  }
}

function markTaintAndLedger(tool: ResolvedTool, outcome: ToolOutcome, ctx: BatchContext): void {
  const source = taintSourceFor(tool, outcome);
  if (!source) return;
  // Optional at runtime: an adapter test's context carries neither.
  const taint = ctx.toolContext.taint as BatchContext["toolContext"]["taint"] | undefined;
  taint?.mark(source, outcome.web?.injection);
  if (tool.origin === "connector") {
    const ledger = ctx.toolContext.ledger as BatchContext["toolContext"]["ledger"] | undefined;
    if (ledger) for (const url of urlsIn(outcome.body)) ledger.add(url, "connector_result");
  }
}

// ── The event channel ───────────────────────────────────────────────────────

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

// ── The batch ───────────────────────────────────────────────────────────────

/** Yields `tool` status/result events and `sources` events as they happen; returns results in
 *  CALL order. Never throws for a tool failure; throws only when the turn signal is aborted. */
export async function* executeToolBatch(
  calls: readonly ToolCallInput[],
  signal: AbortSignal,
  ctx: BatchContext,
): AsyncGenerator<LlmEvent, BatchResult[]> {
  const prepared = calls
    .map((call) => ({ ...call, callId: uniqueCallId(call, ctx.seenCallIds) }))
    .map((call) => prepare(call, ctx.toolset));
  const channel = new EventChannel();
  const results = new Array<BatchResult>(prepared.length);
  const inflight = new Map<string, Promise<void>>();

  // Every row appears at once, carrying its query or domain.
  for (const entry of prepared) {
    yield {
      type: "tool",
      phase: "status",
      callId: entry.call.callId,
      status: "queued",
      ...(entry.present ? { present: entry.present } : {}),
      argsText: entry.call.argsText,
    };
  }

  const position = new Map(prepared.map((entry, i) => [entry, i]));
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
  ctx: BatchContext,
  channel: EventChannel,
  inflight: Map<string, Promise<void>>,
): Promise<BatchResult> {
  const { call } = entry;
  const tool = entry.ok ? entry.tool : null;

  const finish = (outcome: ToolOutcome, opts: { cached?: boolean } = {}): BatchResult => {
    if (outcome.sources?.length && tool) {
      const origin = sourceOrigin(tool);
      channel.push({ type: "sources", sources: outcome.sources, ...(origin ? { origin } : {}) });
    }
    channel.push({
      type: "tool",
      phase: "result",
      server: ctx.toolset.labelFor(call.name),
      name: call.name,
      callId: call.callId,
      round: call.round,
      index: call.index,
      args: call.argsText,
      result: outcome.body,
      ok: outcome.status === "succeeded",
      status: outcome.status,
      ...(outcome.error ? { error: { code: outcome.error.code } } : {}),
      ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
      ...(outcome.figure ? { figure: outcome.figure } : {}),
      ...(outcome.web ? { web: outcome.web } : {}),
      ...(opts.cached ? { cached: true } : {}),
      ...(!opts.cached && outcome.feeMicroUsd ? { feeMicroUsd: outcome.feeMicroUsd } : {}),
    });
    return {
      callId: call.callId,
      name: call.name,
      ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
      text: outcome.text,
      isError: outcome.status !== "succeeded",
      images: outcome.images ?? [],
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
    // Cached results skip authorisation (the first call was authorised) and are billed nothing.
    if (cached) return finish(cached, { cached: true });
  }

  let release: () => void = () => {};
  if (entry.dedupeKey) inflight.set(entry.dedupeKey, new Promise<void>((resolve) => (release = resolve)));
  try {
    const outcome = await execute(entry, signal, ctx, channel);
    if (entry.dedupeKey && cacheable(outcome)) ctx.cache.set(entry.dedupeKey, outcome);
    if (outcome.feeMicroUsd) ctx.fees.add(entry.tool.canonical, outcome.feeMicroUsd);
    markTaintAndLedger(entry.tool, outcome, ctx);
    return finish(outcome);
  } finally {
    if (entry.dedupeKey) inflight.delete(entry.dedupeKey);
    release();
  }
}

/** Authorise (where the dispatcher does) and run one call; every way it can end is an outcome. */
async function execute(entry: ReadyCall, signal: AbortSignal, ctx: BatchContext, channel: EventChannel): Promise<ToolOutcome> {
  const { call, tool } = entry;
  const state = { running: false };
  const onApprovalRequest = (approval: ClientActionApproval) => {
    channel.push({ type: "tool", phase: "status", callId: call.callId, status: "awaiting_approval", approval });
  };
  const onAuthorized = () => {
    if (state.running) return;
    state.running = true;
    channel.push({ type: "tool", phase: "status", callId: call.callId, status: "running", timeoutMs: tool.timeoutMs });
  };

  const spec = tool.spec && (tool.spec.broker === "juno_runtime" || tool.spec.broker === "none") ? tool.spec : null;
  try {
    if (spec) return await executeSpec(spec, entry, signal, ctx, onApprovalRequest, onAuthorized);
    return await executeThroughToolset(entry, signal, ctx, onApprovalRequest, onAuthorized, state);
  } catch (error) {
    if (signal.aborted) {
      return failedOutcome("cancelled", state.running ? CANCELLED_WHILE_RUNNING_TEXT : CANCELLED_BEFORE_RUN_TEXT, "cancelled");
    }
    if (error instanceof TimeoutError) return failedOutcome("timeout", timeoutText(tool.timeoutMs));
    const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MESSAGE_CHARS);
    const body = toolErrorText(message);
    // A connector's error message is its text too, so it goes inside the envelope.
    const text = tool.origin === "connector" ? wrapUntrusted(ctx.toolset.labelFor(call.name), body) : body;
    return { status: "failed", text, body, error: { code: "tool_error" } };
  }
}

/**
 * Connector tools and `start_task`: authorisation happens inside `execute`,
 * on the TURN signal, and the executor calls `onAuthorized()` and only then
 * starts its own timer around the sink (SPEC §3.4 item 8), so an approval can
 * wait the receipt's full fifteen minutes. The dispatcher arms a backstop from
 * the same moment, a second past the tool's own timer.
 */
async function executeThroughToolset(
  entry: ReadyCall,
  signal: AbortSignal,
  ctx: BatchContext,
  onApprovalRequest: (approval: ClientActionApproval) => void,
  onAuthorized: () => void,
  state: { running: boolean },
): Promise<ToolOutcome> {
  const { call, tool, args } = entry;
  let backstop: ReturnType<typeof timeoutAfter> | null = null;
  let armBackstop: (timer: Promise<never>) => void = () => {};
  const armed = new Promise<never>((_, reject) => {
    armBackstop = (timer) => {
      timer.catch(reject);
    };
  });
  armed.catch(() => undefined);
  try {
    const exec = await bounded(
      ctx.toolset.execute(call.name, args, signal, call.callId, {
        onApprovalRequest,
        timeoutMs: tool.timeoutMs,
        onAuthorized: () => {
          backstop ??= timeoutAfter(tool.timeoutMs + BACKSTOP_GRACE_MS);
          armBackstop(backstop.promise);
          onAuthorized();
        },
      }),
      signal,
      armed,
    );
    const outcome = outcomeFromExecution(exec);
    // An executor that predates `onAuthorized` still ran: its row passes through running.
    const ran = outcome.status === "succeeded" || outcome.error?.code === "tool_error" || outcome.error?.code === "timeout";
    if (!state.running && ran) onAuthorized();
    return outcome;
  } finally {
    (backstop as ReturnType<typeof timeoutAfter> | null)?.clear();
  }
}

/**
 * The audit row's arguments: hashed and host-only, because that column is not
 * encrypted (SPEC §3.3 item 7). An audit is best-effort like the rest of the
 * trail — without the hashing secret the row keeps only the tool and the
 * argument count, and the call itself is never refused over it.
 */
function auditArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  try {
    return auditArgsForJunoTool(spec, args) as unknown as Record<string, unknown>;
  } catch {
    return { tool: spec.id, n: Object.keys(args).length };
  }
}

/**
 * A Juno spec the dispatcher runs itself: `juno_runtime` tools are brokered
 * here (SPEC §3.3 item 3) and audited on saved chats (item 7); `none` tools
 * are pure and go straight to the timed execute. A private chat never reaches
 * the broker or the audit trail (INV-32).
 */
async function executeSpec(
  spec: ToolSpec,
  entry: ReadyCall,
  signal: AbortSignal,
  ctx: BatchContext,
  onApprovalRequest: (approval: ClientActionApproval) => void,
  onAuthorized: () => void,
): Promise<ToolOutcome> {
  const { call, args } = entry;
  const context = ctx.toolContext;
  const brokered = spec.broker === "juno_runtime" && !context.private;

  let auditId: string | null = null;
  let receiptId: string | null = null;
  if (brokered) {
    // Fail closed: a saved chat whose broker is not wired runs nothing it would have brokered.
    if (!ctx.ports.authorizeExternalAction) return failedOutcome("not_permitted", BROKER_UNAVAILABLE_TEXT);

    if (ctx.ports.recordToolInvocation) {
      auditId = await ctx.ports.recordToolInvocation({
        userId: context.userId,
        conversationId: context.conversationId,
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
      userId: context.userId,
      surface: "chat",
      sessionId: context.generationId,
      conversationId: context.conversationId,
      projectId: context.projectId,
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
      signal,
      onApprovalRequest,
      unattended: false,
      resolvedPolicy: ctx.ports.resolvedPolicy,
    });
    if (authorization.kind === "refused") {
      await ctx.ports.settleToolInvocation?.(auditId, {
        status: authorization.status === "denied" ? "denied" : "failed",
        error: authorization.reason,
      });
      if (signal.aborted) throw abortReason(signal);
      return refusalOutcome(authorization.status, authorization.reason);
    }
    if (authorization.kind === "replay") {
      await ctx.ports.settleToolInvocation?.(auditId, {
        status: authorization.failed ? "failed" : "executed",
        ...(authorization.failed ? { error: authorization.result } : {}),
      });
      // The stored result of the original run; its duration belonged to that attempt.
      const body = withoutEnvelope(authorization.result);
      return authorization.failed
        ? { status: "failed", text: authorization.result, body, error: { code: "tool_error" } }
        : { status: "succeeded", text: authorization.result, body };
    }
    receiptId = authorization.receiptId;
  }

  onAuthorized();
  const timer = timeoutAfter(spec.timeoutMs);
  const controller = new AbortController();
  void timer.promise.catch(() => controller.abort(new TimeoutError()));
  const startedAt = Date.now();
  let outcome: ToolOutcome;
  try {
    outcome = await bounded(
      spec.execute(args, {
        ...context,
        callId: call.callId,
        round: call.round,
        signal: AbortSignal.any([signal, controller.signal]),
        onApprovalRequest,
      }),
      signal,
      timer.promise,
    );
    if (outcome.durationMs === undefined) outcome = { ...outcome, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (signal.aborted) {
      outcome = failedOutcome("cancelled", CANCELLED_WHILE_RUNNING_TEXT, "cancelled");
    } else if (error instanceof TimeoutError || controller.signal.aborted) {
      outcome = { ...failedOutcome("timeout", timeoutText(spec.timeoutMs)), durationMs: Date.now() - startedAt };
    } else {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MESSAGE_CHARS);
      outcome = { ...failedOutcome("tool_error", toolErrorText(message)), durationMs: Date.now() - startedAt };
    }
  } finally {
    timer.clear();
  }

  if (brokered) {
    const ok = outcome.status === "succeeded";
    await ctx.ports.completeExternalAction?.({
      userId: context.userId,
      receiptId,
      ok,
      result: outcome.text.slice(0, RECEIPT_RESULT_CHARS),
    });
    await ctx.ports.settleToolInvocation?.(auditId, {
      status: ok ? "executed" : "failed",
      ...(ok ? {} : { error: outcome.body }),
      ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    });
  }
  if (signal.aborted && outcome.status === "cancelled") throw abortReason(signal);
  return outcome;
}
