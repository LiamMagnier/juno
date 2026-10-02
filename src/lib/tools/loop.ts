/**
 * What an adapter's tool loop holds for one turn: the toolset, the call-id
 * issuer and the dispatcher, bound together so every adapter runs tools the
 * same way (design §6.4: "every adapter builds ToolCallInput[] and calls the
 * dispatcher; none executes tools itself").
 *
 * One `ToolLoop` per generation: the issued call ids and the duplicate cache
 * span every round of the turn and nothing else.
 *
 * Free of `server-only`.
 */

import { createCallIdIssuer } from "@/lib/tools/call-ids";
import { executeToolBatch } from "@/lib/tools/dispatch";
import { NO_RESULT_TEXT } from "@/lib/tools/dispatch.prompt";
import type { BatchResult, ChatToolset, ToolCallInput, ToolOutcome } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";

export interface ToolLoop {
  readonly toolset: ChatToolset;
  /** The Alevr id for a call the provider streamed (src/lib/tools/call-ids.ts). */
  issueCallId(providerCallId: string | undefined, round: number, index: number): string;
  /**
   * Run one round's calls through the dispatcher. Yields the `tool` status,
   * progress and result acts; returns one result per call, in call order.
   */
  run(
    calls: readonly ToolCallInput[],
    signal: AbortSignal | undefined,
    opts?: { nextIsFinal?: boolean },
  ): AsyncGenerator<LlmEvent, BatchResult[]>;
}

export function createToolLoop(toolset: ChatToolset, opts: { now?: () => number } = {}): ToolLoop {
  const issue = createCallIdIssuer();
  const cache = new Map<string, ToolOutcome>();
  const never = new AbortController().signal;
  return {
    toolset,
    issueCallId: issue,
    async *run(calls, signal, runOpts) {
      if (calls.length === 0) return [];
      const results = yield* executeToolBatch(calls, signal ?? never, {
        toolset,
        cache,
        nextIsFinal: runOpts?.nextIsFinal,
        now: opts.now,
      });
      // Every provider rejects a call left without its result; the dispatcher
      // returns one per call, so this is a guard, not a path.
      return calls.map(
        (call, i) =>
          results[i] ?? {
            callId: call.callId,
            name: call.name,
            ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
            text: NO_RESULT_TEXT,
            isError: true,
            images: [],
            status: "failed",
            errorCode: "tool_error",
          },
      );
    },
  };
}

/** The id the provider pairs its result with: its own when it sent one, else the Alevr id. */
export function wireCallId(result: Pick<BatchResult, "providerCallId" | "callId">): string {
  return result.providerCallId || result.callId;
}
