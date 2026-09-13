import "server-only";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { toWireTools, type McpToolset } from "@/lib/mcp";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { ClientSource } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";
import {
  toGeminiContents,
  resolveGroundingUrls,
  geminiThinkingBudget,
  geminiThinkingConfig,
  geminiGenerationConfig,
  geminiEndpoint,
  geminiModelPath,
  geminiRequestBody,
  geminiToolsPayload,
  getGoogleApiKeys,
  isGemini3OrLater,
  MAX_GEMINI_TOOL_ROUNDS,
  type GeminiPart,
  type GeminiContent,
} from "@/lib/gemini-core";
import {
  applyGeminiChunk,
  appendGeminiToolRound,
  emptyGeminiRound,
  extractGeminiSseEvents,
} from "@/lib/gemini-round";
import { GeminiProviderError, requestGeminiStream, type GeminiRequestContext } from "@/lib/gemini-network";

export {
  toGeminiContents,
  resolveGroundingUrls,
  geminiThinkingBudget,
  geminiThinkingConfig,
  geminiGenerationConfig,
  getGoogleApiKeys,
  isGemini3OrLater,
  type GeminiPart,
  type GeminiContent,
};

/** Convert tool declarations from McpToolset to Gemini functionDeclarations format. */
export function toGeminiFunctionDeclarations(toolset: McpToolset) {
  const wire = toWireTools(toolset.tools);
  return wire.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    parameters: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * Stream chat completions from Google Generative Language API (Gemini).
 * Supports turns, multimodality (images, PDFs), thinking / reasoning, tool loops,
 * Google search grounding, and usage tokens.
 */
export async function* streamGemini(
  model: ModelInfo,
  system: string,
  history: MessageForModel[],
  maxTokens: number,
  signal?: AbortSignal,
  reasoningEffort?: ReasoningEffort,
  webSearch?: boolean,
  toolset?: McpToolset,
  dynamicContext?: string,
  requestContext?: Partial<GeminiRequestContext>,
): AsyncGenerator<LlmEvent> {
  const apiKeys = getGoogleApiKeys();
  if (apiKeys.length === 0) throw new Error("Google API key is not configured.");
  const key = apiKeys[0];

  const contents = await toGeminiContents(history, model.vision);
  if (dynamicContext) {
    let lastUser = contents.length;
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    contents.splice(lastUser, 0, { role: "user", parts: [{ text: dynamicContext }] });
  }

  const url = geminiEndpoint(model, "streamGenerateContent");
  const geminiContext: GeminiRequestContext = {
    modelId: model.id,
    providerModel: model.providerModel,
    reasoningEffort: reasoningEffort ?? null,
    endpoint: `${geminiModelPath(model)}:streamGenerateContent`,
    requestId: requestContext?.requestId,
    generationId: requestContext?.generationId,
    conversationId: requestContext?.conversationId,
  };

  const hasTools = !!toolset && toolset.tools.length > 0;
  const functionDeclarations = hasTools ? toGeminiFunctionDeclarations(toolset) : [];
  const generationConfig = geminiGenerationConfig(model, maxTokens, reasoningEffort);

  const sources = new Map<string, ClientSource>();
  let cumInput = 0;
  let cumOutput = 0;
  let cumCached = 0;
  let cumThoughts = 0;
  let cumTotal = 0;
  let sawUsage = false;
  /** Did any ANSWER text reach the transcript this turn? (Thoughts don't count.) */
  let sawAnswer = false;
  let lastFinishReason: string | undefined;
  let groundedWithSearchWidget = false;

  const maxRounds = hasTools ? MAX_GEMINI_TOOL_ROUNDS + 1 : 1;

  for (let round = 0; round < maxRounds; round++) {
    const isFinalRound = round === maxRounds - 1;
    const requestBody = geminiRequestBody({
      contents,
      generationConfig,
      system,
      // `google_search` is a SERVER-side tool that resolves inside one request,
      // so it rides on every round — including the single round of a turn with
      // no function tools, which is where it used to be dropped entirely.
      tools: geminiToolsPayload({ model, functionDeclarations, webSearch, isFinalRound }),
    });

    const res = await requestGeminiStream({
      url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(requestBody),
      },
      signal,
      context: geminiContext,
      apiKeys,
    });

    // requestGeminiStream rejects successful responses without a body.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let streamBuffer = "";
    const state = emptyGeminiRound();

    const drain = function* (payloads: string[]) {
      for (const payload of payloads) {
        applyGeminiChunk(state, payload, sources);
        while (state.events.length > 0) {
          const ev = state.events.shift();
          if (!ev) continue;
          if (ev.type === "text") sawAnswer = true;
          yield ev;
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamBuffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = extractGeminiSseEvents(streamBuffer);
      streamBuffer = rest;
      yield* drain(payloads);
    }

    // The reader is done, so whatever is still buffered will never be followed
    // by the newline the mid-stream parser waits for. Gemini's final frame —
    // `finishReason` and `usageMetadata` — is routinely that frame. See the
    // header of `extractGeminiSseEvents`.
    streamBuffer += decoder.decode();
    if (streamBuffer) {
      const { payloads } = extractGeminiSseEvents(streamBuffer, true);
      streamBuffer = "";
      yield* drain(payloads);
    }

    if (state.finishReason) lastFinishReason = state.finishReason;
    if (state.searchEntryPoint) groundedWithSearchWidget = true;

    if (!state.sawSignal) {
      throw new GeminiProviderError({
        httpStatus: 502,
        googleStatus: "EMPTY_STREAM",
        message: "Google ended the stream without a candidate or usage record",
        context: geminiContext,
      });
    }

    if (state.sawUsage) {
      sawUsage = true;
      cumInput += state.usage.input;
      cumOutput += state.usage.output;
      cumCached += state.usage.cached;
      cumThoughts += state.usage.thoughts;
      cumTotal += state.usage.total;
    }

    if (hasTools && !isFinalRound && state.functionCalls.length > 0) {
      const responseParts: Array<{ name: string; response: Record<string, unknown> }> = [];

      for (const call of state.functionCalls) {
        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const label = toolset.labelFor(call.name);
        yield {
          type: "tool",
          server: label,
          name: call.name,
          phase: "call",
          callId,
          args: JSON.stringify(call.args),
        };

        const exec = await toolset.execute(call.name, call.args, signal, callId);
        responseParts.push({ name: call.name, response: { result: exec.body ?? exec.text } });

        yield {
          type: "tool",
          server: label,
          name: call.name,
          phase: "result",
          callId,
          result: exec.body,
          ok: exec.ok,
          durationMs: exec.durationMs,
        };
      }

      // Replays the assistant parts UNCHANGED, thought signatures included.
      appendGeminiToolRound(contents, state.assistantParts, responseParts);
      continue;
    }

    break;
  }

  if (sources.size > 0) {
    yield { type: "sources", sources: await resolveGroundingUrls([...sources.values()]) };
  }

  if (sawUsage) {
    yield {
      type: "usage",
      input: cumInput || undefined,
      output: cumOutput || undefined,
      reasoning: cumThoughts || undefined,
      total: cumTotal || undefined,
      cacheRead: cumCached || undefined,
    };
  }

  /*
   * A MISSING TERMINAL MARKER IS NOT A REASON TO DESTROY A DELIVERED ANSWER.
   *
   * This used to throw unconditionally, with a synthetic httpStatus 502 —
   * which `classifyProviderError` maps to `capacity`, which renders as "Gemini
   * is temporarily unavailable (a server error on their end)". So a turn whose
   * text had ALREADY streamed into the transcript was replaced, at the finish
   * line, with an outage notice about a provider that had just answered
   * correctly. The user saw their thought process, then "Generation failed".
   *
   * (The frame it was missing is the one `extractGeminiSseEvents` was dropping
   * for want of a trailing newline — fixed there, and this is the second half:
   * even when a terminator genuinely never arrives, an answer the reader can
   * see is worth more than a marker the reader cannot.)
   *
   * So: if answer text arrived, finish on it. `UNSPECIFIED` is what Google's
   * own enum calls a reason it did not state, and `normalizeFinishReason`
   * already treats anything it does not recognise as a normal stop.
   */
  if (!lastFinishReason && !sawAnswer) {
    throw new GeminiProviderError({
      // NOT 5xx. Nothing here says Google's servers failed: the stream opened,
      // carried no answer and ended without a terminator, which is a truncated
      // connection. Reporting it as a provider outage sent operators looking at
      // Google's status page for a fault on this side of the socket.
      httpStatus: 499,
      googleStatus: "MISSING_FINISH_REASON",
      message: "The model stream ended with no answer and no finish reason (network interrupted)",
      context: geminiContext,
    });
  }

  const finalRaw = lastFinishReason ?? "FINISH_REASON_UNSPECIFIED";
  // Operator-visible evidence that grounding actually ran: the UI announces
  // "Google Search grounding" from the request side, and for a long time that
  // announcement was the only trace of a search that never happened.
  console.info("[llm:gemini] stream finish", {
    model: model.providerModel,
    finishReason: finalRaw,
    webSearch: !!webSearch,
    grounded: sources.size > 0 || groundedWithSearchWidget,
    sources: sources.size,
    promptTokens: sawUsage ? cumInput : null,
    completionTokens: sawUsage ? cumOutput : null,
    thoughtTokens: sawUsage ? cumThoughts || null : null,
    cachedTokens: sawUsage ? cumCached || null : null,
  });
  yield { type: "finish", reason: normalizeFinishReason(finalRaw), raw: finalRaw };
}
