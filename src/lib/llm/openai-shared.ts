/**
 * What the two OpenAI-wire adapters — Responses (OpenAI and xAI) and Chat
 * Completions (every compat lab) — share around a tool round (SPEC §4.2, §4.3).
 *
 * Both loops end a request the same way: stamp each call with the id the turn
 * knows it by, run the round's calls through one runner, and send every
 * result back in call order. Only the wire shape of that last step differs,
 * so this module holds the rest: where the calls run, and what they are
 * called.
 *
 * Pure: no SDK, no `server-only` (SPEC §13 harness rule 2).
 */

import type { LoopController } from "@/lib/llm/loop";
import { FINAL_ROUND_NOTE } from "@/lib/llm/loop";
import type { AdapterRequest } from "@/lib/llm/types";
import type { McpFunctionTool, McpToolset, ToolExecution } from "@/lib/mcp";
import { executeToolBatch, type BatchResult, type ToolCallInput } from "@/lib/tools/dispatch";
import {
  CANCELLED_BEFORE_RUN_TEXT,
  CANCELLED_WHILE_RUNNING_TEXT,
  NOT_AN_OBJECT_TEXT,
  invalidJsonText,
  toolErrorText,
} from "@/lib/tools/dispatch.prompt";
import type { LlmEvent } from "@/types/llm";

/** Runs one round's calls: yields their tool and sources events, returns results in call order. */
export type ToolRunner = (
  calls: readonly ToolCallInput[],
  signal: AbortSignal,
) => AsyncGenerator<LlmEvent, BatchResult[]>;

/** The function tools a turn offers, and how its calls run. */
export interface ToolSource {
  tools: readonly McpFunctionTool[];
  labelFor(name: string): string;
  run: ToolRunner;
}

/**
 * Where a request's function calls go.
 *
 * The reworked path is the turn's `ChatToolset` with its batch context: every
 * call goes through `executeToolBatch`, which parses, authorises, runs and
 * reports it (SPEC §4.2). The deprecated path is the `McpToolset` that
 * `streamChat` still opens from `connectors`/`audit` until the route passes a
 * toolset (WS9a); it runs through `legacyToolRunner`, which keeps that path's
 * behaviour. Null when the turn offers no function tools.
 */
export function toolSourceFor(req: AdapterRequest, legacyToolset?: McpToolset): ToolSource | null {
  const { toolset, batch, loop } = req;
  if (toolset && batch && toolset.tools.length > 0) {
    return {
      tools: toolset.tools,
      labelFor: (name) => toolset.labelFor(name),
      run: (calls, signal) =>
        // `nextIsFinal` is read when the batch runs, after this request began:
        // true exactly when the next request will be the tools-off one.
        executeToolBatch(calls, signal, { ...batch, toolset, nextIsFinal: loop.nextIsFinal() }),
    };
  }
  const legacy = toolset ?? legacyToolset;
  if (legacy && legacy.tools.length > 0) {
    return { tools: legacy.tools, labelFor: (name) => legacy.labelFor(name), run: legacyToolRunner(legacy, loop) };
  }
  return null;
}

/**
 * The ids one call is known by (SPEC §4.3).
 *
 * `callId` is the provider's id, or `jc_<round>_<index>` when the host sent
 * none; a repeat of an id the turn has already used is suffixed
 * `#<round>.<index>`, because several hosts restart their numbering per
 * response and a reused id would replay the broker's old receipt. The
 * provider's own id is what goes back on the wire.
 *
 * `seen` — the batch context's set — is only read. The dispatcher records the
 * ids it runs, and an adapter that wrote to the set as well would make every
 * id look like a repeat to it. The ids this loop stamped before (`local`) are
 * checked too, so a repeat inside one response, or across requests before the
 * dispatcher has recorded anything, is caught, and the same formula gives the
 * same answer on both sides.
 */
export function stampCallId(
  providerId: string | undefined,
  round: number,
  index: number,
  seen: ReadonlySet<string> | undefined,
  local: Set<string>,
): { callId: string; providerCallId?: string } {
  const provider = providerId?.trim() ? providerId : undefined;
  const base = provider ?? `jc_${round}_${index}`;
  const taken = local.has(base) || !!seen?.has(base);
  const callId = taken ? `${base}#${round}.${index}` : base;
  local.add(callId);
  return { callId, ...(provider ? { providerCallId: provider } : {}) };
}

/**
 * The runner for the deprecated `McpToolset` path.
 *
 * The toolset authorises and runs each call itself (its broker is inside
 * `execute`), so this only does what the dispatcher would do around it, one
 * call at a time: arguments that are not a JSON object are reported back
 * instead of run as `{}` (RC-14), the provider's call id reaches the broker
 * (RC-13), a failure is a result, and the last result of the round before the
 * tools-off request carries the final-round note (SPEC §4.6).
 */
export function legacyToolRunner(toolset: McpToolset, loop: LoopController): ToolRunner {
  return async function* run(calls, signal) {
    const results: BatchResult[] = [];
    for (const call of calls) {
      const base = {
        type: "tool" as const,
        phase: "result" as const,
        server: toolset.labelFor(call.name),
        name: call.name,
        callId: call.callId,
        round: call.round,
        index: call.index,
        args: call.argsText,
      };
      const fail = (text: string, code: "invalid_args" | "tool_error" | "cancelled"): BatchResult => ({
        callId: call.callId,
        name: call.name,
        ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
        text,
        isError: true,
        images: [],
        errorCode: code,
      });

      if (signal.aborted) {
        yield { ...base, result: "Cancelled.", ok: false, status: "cancelled", error: { code: "cancelled" } };
        results.push(fail(CANCELLED_BEFORE_RUN_TEXT, "cancelled"));
        continue;
      }
      const parsed = parseArgs(call.argsText);
      if (!parsed.ok) {
        yield { ...base, result: parsed.text, ok: false, status: "failed", error: { code: "invalid_args" } };
        results.push(fail(parsed.text, "invalid_args"));
        continue;
      }

      yield { type: "tool", phase: "status", callId: call.callId, status: "running" };
      let exec: ToolExecution;
      try {
        exec = await toolset.execute(call.name, parsed.args, signal, call.callId);
      } catch (error) {
        if (signal.aborted) {
          yield { ...base, result: "Cancelled.", ok: false, status: "cancelled", error: { code: "cancelled" } };
          results.push(fail(CANCELLED_WHILE_RUNNING_TEXT, "cancelled"));
          continue;
        }
        const text = toolErrorText((error instanceof Error ? error.message : String(error)).slice(0, 2_000));
        yield { ...base, result: text, ok: false, status: "failed", error: { code: "tool_error" } };
        results.push(fail(text, "tool_error"));
        continue;
      }
      const status = exec.status ?? (exec.ok ? "succeeded" : "failed");
      yield {
        ...base,
        result: exec.body,
        ok: exec.ok,
        status,
        ...(exec.durationMs === undefined ? {} : { durationMs: exec.durationMs }),
      };
      results.push({
        callId: call.callId,
        name: call.name,
        ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
        text: exec.text,
        isError: !exec.ok,
        images: exec.images ?? [],
      });
    }
    const last = results.at(-1);
    if (last && loop.nextIsFinal()) last.text = `${last.text}\n\n${FINAL_ROUND_NOTE}`;
    if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    return results;
  };
}

function parseArgs(argsText: string): { ok: true; args: Record<string, unknown> } | { ok: false; text: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText || "{}");
  } catch (error) {
    return { ok: false, text: invalidJsonText(error instanceof Error ? error.message : String(error)) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, text: NOT_AN_OBJECT_TEXT };
  return { ok: true, args: parsed as Record<string, unknown> };
}

/**
 * The model-facing output of a failed call on a wire with no error flag.
 *
 * Neither Responses nor Chat Completions has `is_error`, so the text itself has
 * to say it failed; the dispatcher's text then says why and what to do next.
 */
export function outputTextFor(result: Pick<BatchResult, "text" | "isError">): string {
  return result.isError ? `Error: ${result.text}` : result.text;
}

/** The turn signal, or one that never aborts for a caller that passed none. */
export function turnSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}
