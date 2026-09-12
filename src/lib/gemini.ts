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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamBuffer += decoder.decode(value, { stream: true });
      const { payloads, rest } = extractGeminiSseEvents(streamBuffer);
      streamBuffer = rest;
      for (const payload of payloads) {
        applyGeminiChunk(state, payload, sources);
        while (state.events.length > 0) {
          const ev = state.events.shift();
          if (ev) yield ev;
        }
      }
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

  if (!lastFinishReason) {
    throw new GeminiProviderError({
      httpStatus: 502,
      googleStatus: "MISSING_FINISH_REASON",
      message: "Google ended the stream without a terminal finish reason",
      context: geminiContext,
    });
  }

  const finalRaw = lastFinishReason;
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
