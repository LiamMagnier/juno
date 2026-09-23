/**
 * The tool dispatcher every adapter calls after a round ends in tool calls
 * (SPEC §4.2).
 *
 * The adapters keep their own wire code; this is the one place that parses a
 * call's arguments, resolves its tool, runs it and turns whatever happened into
 * a result the model can act on. A failure is a result, never a thrown error:
 * the model is told what failed and what to do next, and the turn carries on.
 *
 * Everything `server-only` the full dispatcher needs — the approval broker,
 * the audit trail — arrives through `BatchContext.ports`, so this module stays
 * importable offline and tests pass fakes (SPEC §13 harness rule 1).
 *
 * THIS IS WS0'S MINIMAL BODY, with the final signature. It runs calls one at a
 * time and emits `queued` → `running` → `result` for each, reports parse and
 * resolve failures and thrown executors as results, and appends the final-round
 * note — enough for the adapters to be tested against real event shapes. It
 * does not authorise, time out, dedupe, suffix repeated call ids or run reads
 * in parallel; WS1 replaces it with the full algorithm.
 */

import type { ResolvedActionPolicy } from "@/lib/action-approval-store";
import { FINAL_ROUND_NOTE } from "@/lib/llm/loop";
import type { ToolExecution, ToolResultImage } from "@/lib/mcp";
import {
  CANCELLED_BEFORE_RUN_TEXT,
  CANCELLED_WHILE_RUNNING_TEXT,
  NOT_AN_OBJECT_TEXT,
  invalidJsonText,
  toolErrorText,
  unknownToolText,
} from "@/lib/tools/dispatch.prompt";
import type { ToolFeeAccumulator } from "@/lib/tools/metering";
import type { ChatToolset, ResolvedTool, ToolContext, ToolOutcome } from "@/lib/tools/types";
import { wrapUntrusted } from "@/lib/untrusted-content";
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

type ResultStatus = "succeeded" | "failed" | "denied" | "expired" | "cancelled";

/** A call after parse and resolve: either ready to run, or already failed. */
type PreparedCall =
  | { call: ToolCallInput; ok: true; args: Record<string, unknown>; tool: ResolvedTool; present: ToolPresentArgs }
  | { call: ToolCallInput; ok: false; code: ToolErrorCode; text: string };

const CONNECTOR_ERROR_CHARS = 2_000;

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
  if (!tool) {
    return { call, ok: false, code: "unknown_tool", text: unknownToolText(call.name) };
  }
  const args = parsed as Record<string, unknown>;
  let present: ToolPresentArgs = {};
  try {
    present = tool.present(args);
  } catch {
    // `present` must never throw; a row without its argument is still a row.
  }
  return { call, ok: true, args, tool, present };
}

function sourceOrigin(tool: ResolvedTool): ChatSourceOrigin | undefined {
  if (tool.canonical === "web_search") return "juno_search";
  if (tool.canonical === "web_fetch") return "juno_fetch";
  return undefined;
}

function outcomeOf(exec: ToolExecution): { status: ResultStatus; code?: ToolErrorCode } {
  const status: ResultStatus = exec.status ?? (exec.ok ? "succeeded" : "failed");
  if (status === "succeeded") return { status };
  if (exec.error) return { status, code: exec.error.code };
  return { status, code: status === "failed" ? "tool_error" : status };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Yields `tool` status/result events and `sources` events as they happen; returns results in
 *  CALL order. Never throws for a tool failure; throws only when the turn signal is aborted. */
export async function* executeToolBatch(
  calls: readonly ToolCallInput[],
  signal: AbortSignal,
  ctx: BatchContext,
): AsyncGenerator<LlmEvent, BatchResult[]> {
  const prepared = calls.map((call) => prepare(call, ctx.toolset));

  // Every row appears at once, carrying its query or domain.
  for (const entry of prepared) {
    yield {
      type: "tool",
      phase: "status",
      callId: entry.call.callId,
      status: "queued",
      ...(entry.ok ? { present: entry.present } : {}),
      argsText: entry.call.argsText,
    };
  }

  const results: BatchResult[] = [];
  for (const entry of prepared) {
    const { call } = entry;
    const server = ctx.toolset.labelFor(call.name);
    const base = {
      type: "tool" as const,
      phase: "result" as const,
      server,
      name: call.name,
      callId: call.callId,
      round: call.round,
      index: call.index,
      args: call.argsText,
    };

    if (signal.aborted) {
      yield { ...base, result: "Cancelled.", ok: false, status: "cancelled", error: { code: "cancelled" } };
      results.push(failure(call, CANCELLED_BEFORE_RUN_TEXT, "cancelled"));
      continue;
    }

    if (!entry.ok) {
      yield { ...base, result: entry.text, ok: false, status: "failed", error: { code: entry.code } };
      results.push(failure(call, entry.text, entry.code));
      continue;
    }

    yield { type: "tool", phase: "status", callId: call.callId, status: "running", timeoutMs: entry.tool.timeoutMs };

    let exec: ToolExecution;
    try {
      exec = await ctx.toolset.execute(call.name, entry.args, signal, call.callId);
    } catch (error) {
      if (signal.aborted) {
        yield { ...base, result: "Cancelled.", ok: false, status: "cancelled", error: { code: "cancelled" } };
        results.push(failure(call, CANCELLED_WHILE_RUNNING_TEXT, "cancelled"));
        continue;
      }
      const message = (error instanceof Error ? error.message : String(error)).slice(0, CONNECTOR_ERROR_CHARS);
      const body = toolErrorText(message);
      const text = entry.tool.origin === "connector" ? wrapUntrusted(server, body) : body;
      yield { ...base, result: body, ok: false, status: "failed", error: { code: "tool_error" } };
      results.push(failure(call, text, "tool_error"));
      continue;
    }

    const outcome = outcomeOf(exec);
    if (exec.sources?.length) {
      const origin = sourceOrigin(entry.tool);
      yield { type: "sources", sources: exec.sources, ...(origin ? { origin } : {}) };
    }
    yield {
      ...base,
      result: exec.body,
      ok: outcome.status === "succeeded",
      status: outcome.status,
      ...(outcome.code ? { error: { code: outcome.code } } : {}),
      ...(exec.durationMs === undefined ? {} : { durationMs: exec.durationMs }),
      ...(exec.figure ? { figure: exec.figure } : {}),
      ...(exec.web ? { web: exec.web } : {}),
      ...(exec.feeMicroUsd === undefined ? {} : { feeMicroUsd: exec.feeMicroUsd }),
    };
    results.push({
      callId: call.callId,
      name: call.name,
      ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
      text: exec.text,
      isError: outcome.status !== "succeeded",
      images: exec.images ?? [],
      ...(outcome.code ? { errorCode: outcome.code } : {}),
    });
  }

  const last = results.at(-1);
  if (ctx.nextIsFinal && last) last.text = `${last.text}\n\n${FINAL_ROUND_NOTE}`;

  if (signal.aborted) throw abortError(signal);
  return results;
}

function failure(call: ToolCallInput, text: string, code: ToolErrorCode): BatchResult {
  return {
    callId: call.callId,
    name: call.name,
    ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
    text,
    isError: true,
    images: [],
    errorCode: code,
  };
}
