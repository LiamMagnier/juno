import "server-only";
import type { SseSender } from "@/lib/chat-stream";
import type { GenerationAccumulator, StreamEffect } from "@/lib/chat/stream-accumulator";
import type { StallWatchdog, trackToolActivity } from "@/lib/chat-stall";
import { searchToolLabel, sourceHost } from "@/lib/chat-responses";
import { PROVIDERS } from "@/lib/providers";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import { truncate } from "@/lib/utils";
import type { LlmEvent } from "@/types/llm";
import type { createToolActivity } from "./activity";

/*
 * Pipeline stage — runTurn's inner loop: fold one model stream into the
 * accumulator and the SSE frames the reader sees.
 *
 * The private and the saved turn each had their own copy of this loop, and the
 * two had already drifted once (the private copy never learned `tool_status`
 * or `tool_progress`). One loop now serves both. The private turn carries no
 * connectors, so the tool branches cannot fire there; they are present anyway
 * for the same reason `createToolActivity` is shared — so the paths cannot
 * drift again.
 */

export interface PumpOptions {
  acc: GenerationAccumulator;
  stallWatchdog: Pick<StallWatchdog, "touch">;
  /** Holds the watchdog while a tool call runs (saved turns only). */
  toolWatch?: ReturnType<typeof trackToolActivity>;
  toolActivity: ReturnType<typeof createToolActivity>;
  send: SseSender["send"];
  sendActivity: SseSender["sendActivity"];
  enforceStreamBudget: () => unknown;
  /** The "write" activity row sent when the first text arrives. */
  writing: { title: string; detail: string };
  /** False for a canvas edit: patch protocol output is server-internal. */
  forwardDeltas: boolean;
  /** Observes every effect after it is applied (the turn trace). */
  onEffect?: (effect: StreamEffect) => void;
}

export async function pumpTurnStream(stream: AsyncIterable<LlmEvent>, options: PumpOptions): Promise<void> {
  const { acc, stallWatchdog, toolWatch, toolActivity, send, sendActivity, enforceStreamBudget } = options;
  for await (const ev of stream) {
    stallWatchdog.touch();
    // While a call runs the turn waits on the tool, which has its own
    // bound: the watchdog is held from its `running` act to its result.
    toolWatch?.observe(ev);
    const effect = acc.apply(ev);
    options.onEffect?.(effect);
    if (effect.kind === "text") {
      if (effect.startedWriting) {
        sendActivity({ kind: "write", title: options.writing.title, detail: options.writing.detail });
      }
      // Patch protocol output is server-internal. The client receives a
      // normal same-identifier artifact only after every source anchor is
      // validated and the version is saved.
      if (options.forwardDeltas) send({ type: "delta", text: effect.text });
      enforceStreamBudget();
    } else if (effect.kind === "tool_call") {
      toolActivity.open(effect);
    } else if (effect.kind === "tool_status") {
      toolActivity.status(effect);
    } else if (effect.kind === "tool_progress") {
      toolActivity.progress(effect);
    } else if (effect.kind === "tool_result") {
      // Deliberately NOT followed by enforceStreamBudget(): that guard
      // projects micro-USD from token counts, and a tool payload spends
      // no tokens. The bound that applies here is the run's character
      // budget, already charged inside closeToolDetail.
      toolActivity.close(effect);
    } else if (effect.kind === "reasoning") {
      // `part` rides the SSE so the panel can build steps AS THEY
      // ARRIVE, from the same boundaries the API gave the adapter.
      send({ type: "reasoning", text: effect.text, part: effect.part });
      enforceStreamBudget();
    } else if (effect.kind === "sources") {
      for (const source of effect.added) {
        sendActivity({
          kind: "visit",
          title: "Visited source",
          detail: truncate(source.title && source.title !== source.url ? source.title : sourceHost(source.url), 96),
          url: source.url,
        });
      }
      if (effect.all.length) send({ type: "sources", sources: effect.all });
    } else if (effect.kind === "usage") {
      enforceStreamBudget();
    }
  }
}

/** "Selected model", and "Model changed" when the model used is not the one asked for. */
export function sendSelectedModel(
  sendActivity: SseSender["sendActivity"],
  input: { modelInfo: ModelInfo; routingNote: string | null; routingWarning: string | null }
): void {
  sendActivity({
    kind: "model",
    title: "Selected model",
    detail: input.routingNote ?? `${PROVIDERS[input.modelInfo.provider].label} · ${input.modelInfo.name}`,
  });
  if (input.routingWarning) {
    sendActivity({ kind: "warning", title: "Model changed", detail: input.routingWarning });
  }
}

/** The thinking effort this turn runs at, and the rows that say so (both turns). */
export function sendReasoningAndSearch(
  sendActivity: SseSender["sendActivity"],
  input: { reasoningEffort: ReasoningEffort | undefined; auto: boolean; webSearch: boolean; modelInfo: ModelInfo }
): void {
  const { reasoningEffort } = input;
  if (reasoningEffort) {
    sendActivity({
      kind: "reasoning",
      title: input.auto ? "Auto thinking" : "Reasoning mode enabled",
      detail: `${reasoningEffort[0].toUpperCase()}${reasoningEffort.slice(1)} effort`,
    });
  } else if (input.auto) {
    sendActivity({
      kind: "reasoning",
      title: "Auto thinking",
      detail: "Instant — no extra reasoning for this prompt",
    });
  }
  if (input.webSearch) {
    sendActivity({
      kind: "search",
      title: "Preparing web search",
      detail: searchToolLabel(input.modelInfo.provider),
    });
  }
}
