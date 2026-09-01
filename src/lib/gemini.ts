import "server-only";
import { normalizeFinishReason } from "@/lib/finish-reason";
import { providerApiKey } from "@/lib/providers";
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
  MAX_GEMINI_TOOL_ROUNDS,
  type GeminiPart,
  type GeminiContent,
} from "@/lib/gemini-core";
import { GeminiProviderError, requestGeminiStream, type GeminiRequestContext } from "@/lib/gemini-network";

export {
  toGeminiContents,
  resolveGroundingUrls,
  geminiThinkingBudget,
  geminiThinkingConfig,
  geminiGenerationConfig,
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

export function getGoogleApiKeys(): string[] {
  const keys = [
    providerApiKey("google"),
    process.env.GOOGLE_API_KEY,
    process.env.GEMINI_LIVE_API_KEY,
    process.env.GEMINI_API_KEY,
  ].filter((k): k is string => typeof k === "string" && k.trim().length > 0);
  return [...new Set(keys)];
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

function resolveGeminiApiPath(providerModel: string): string {
  const clean = providerModel.replace(/^models\//, "");
  const map: Record<string, string> = {
    "gemini-3.7-flash": "gemini-2.5-flash",
    "gemini-3.6-flash": "gemini-2.5-flash",
    "gemini-3.5-flash": "gemini-2.5-flash",
    "gemini-3.1-flash-lite": "gemini-2.5-flash",
    "gemini-3.1-pro-preview": "gemini-2.5-pro",
    "gemini-3-flash-preview": "gemini-2.5-flash",
  };
  const resolved = map[clean] ?? clean;
  return `models/${resolved}`;
}

  const path = resolveGeminiApiPath(model.providerModel);
  const url = `https://generativelanguage.googleapis.com/v1beta/${path}:streamGenerateContent?alt=sse`;
  const geminiContext: GeminiRequestContext = {
    modelId: model.id,
    providerModel: model.providerModel,
    reasoningEffort: reasoningEffort ?? null,
    endpoint: `${path}:streamGenerateContent`,
    requestId: requestContext?.requestId,
    generationId: requestContext?.generationId,
    conversationId: requestContext?.conversationId,
  };

  const hasTools = !!toolset && toolset.tools.length > 0;
  const toolsPayload: Array<Record<string, unknown>> = [];
  if (hasTools) {
    toolsPayload.push({ functionDeclarations: toGeminiFunctionDeclarations(toolset) });
  }
  if (webSearch) {
    toolsPayload.push({ google_search: {} });
  }

  const generationConfig = geminiGenerationConfig(model, maxTokens, reasoningEffort);

  const sources = new Map<string, ClientSource>();
  let cumInput = 0;
  let cumOutput = 0;
  let cumCached = 0;
  let cumThoughts = 0;
  let cumTotal = 0;
  let sawUsage = false;
  let lastFinishReason: string | undefined;

  const maxRounds = hasTools ? MAX_GEMINI_TOOL_ROUNDS + 1 : 1;

  for (let round = 0; round < maxRounds; round++) {
    const isFinalRound = round === maxRounds - 1;
    const requestBody: Record<string, unknown> = {
      contents,
      generationConfig,
    };
    if (system?.trim()) {
      requestBody.systemInstruction = { parts: [{ text: system }] };
    }
    if (toolsPayload.length > 0 && !isFinalRound) {
      requestBody.tools = toolsPayload;
    }

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
    let roundInput = 0;
    let roundOutput = 0;
    let roundCached = 0;
    let roundThoughts = 0;
    let roundTotal = 0;
    let roundSawUsage = false;

    const roundAssistantParts: GeminiPart[] = [];
    const pendingFunctionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let roundSawSignal = false;

    const handleChunk = (jsonText: string) => {
      let data: {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown> } }> };
          finishReason?: string;
          groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
        }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          cachedContentTokenCount?: number;
          thoughtsTokenCount?: number;
          totalTokenCount?: number;
        };
      };
      try {
        data = JSON.parse(jsonText);
      } catch {
        return;
      }

      const candidate = data.candidates?.[0];
      if (candidate || data.usageMetadata) roundSawSignal = true;
      if (candidate?.finishReason) {
        lastFinishReason = candidate.finishReason;
      }

      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall?.name) {
          const name = part.functionCall.name;
          const args = part.functionCall.args ?? {};
          pendingFunctionCalls.push({ name, args });
          roundAssistantParts.push({ functionCall: { name, args } });
        } else if (part.text) {
          roundAssistantParts.push(part.thought ? { thought: true, text: part.text } : { text: part.text });
          if (part.thought) {
            yieldEvents.push({ type: "reasoning", text: part.text });
          } else {
            yieldEvents.push({ type: "text", text: part.text });
          }
        }
      }

      for (const ch of candidate?.groundingMetadata?.groundingChunks ?? []) {
        const web = ch.web;
        if (web?.uri && !sources.has(web.uri)) {
          sources.set(web.uri, { title: web.title || web.uri, url: web.uri, snippet: "" });
        }
      }

      if (data.usageMetadata) {
        roundSawUsage = true;
        roundInput = data.usageMetadata.promptTokenCount ?? roundInput;
        roundOutput = data.usageMetadata.candidatesTokenCount ?? roundOutput;
        roundCached = data.usageMetadata.cachedContentTokenCount ?? roundCached;
        roundThoughts = data.usageMetadata.thoughtsTokenCount ?? roundThoughts;
        roundTotal = data.usageMetadata.totalTokenCount ?? roundTotal;
      }
    };

    const yieldEvents: LlmEvent[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamBuffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = streamBuffer.indexOf("\n")) !== -1) {
        const line = streamBuffer.slice(0, idx).trim();
        streamBuffer = streamBuffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (json) {
          handleChunk(json);
          while (yieldEvents.length > 0) {
            const ev = yieldEvents.shift();
            if (ev) yield ev;
          }
        }
      }
    }

    if (!roundSawSignal) {
      throw new GeminiProviderError({
        httpStatus: 502,
        googleStatus: "EMPTY_STREAM",
        message: "Google ended the stream without a candidate or usage record",
        context: geminiContext,
      });
    }

    if (roundSawUsage) {
      sawUsage = true;
      cumInput += roundInput;
      cumOutput += roundOutput;
      cumCached += roundCached;
      cumThoughts += roundThoughts;
      cumTotal += roundTotal;
    }

    if (hasTools && !isFinalRound && pendingFunctionCalls.length > 0) {
      contents.push({ role: "model", parts: roundAssistantParts });
      const responseParts: GeminiPart[] = [];

      for (const call of pendingFunctionCalls) {
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
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: { result: exec.body ?? exec.text },
          },
        });

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

      contents.push({ role: "user", parts: responseParts });
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
  yield { type: "finish", reason: normalizeFinishReason(finalRaw), raw: finalRaw };
}
