import "server-only";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";
import { getModelMetrics } from "@/lib/model-metrics";
import { geminiLoop } from "@/lib/llm/gemini-loop";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import type { LlmEvent } from "@/types/llm";
import {
  toGeminiContents,
  resolveGroundingUrls,
  geminiThinkingBudget,
  geminiThinkingConfig,
  geminiGenerationConfig,
  geminiEndpoint,
  geminiModelPath,
  getGoogleApiKeys,
  isGemini3OrLater,
  type GeminiPart,
  type GeminiContent,
} from "@/lib/gemini-core";
import { extractGeminiSseEvents } from "@/lib/gemini-round";
import { requestGeminiStream, type GeminiRequestContext } from "@/lib/gemini-network";

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

/**
 * The retrying fetch as the loop's transport: one streamed GenerateContent
 * request per call, yielding each decoded `data:` payload.
 *
 * THE LAST FRAME HAS NO NEWLINE AFTER IT on some responses, and it is the one
 * carrying `finishReason` and `usageMetadata`: whatever is still buffered when
 * the reader is done is flushed as a frame of its own (see
 * `extractGeminiSseEvents`).
 */
function fetchTransport(url: string, apiKeys: string[], context: GeminiRequestContext): ProviderTransport {
  return {
    async *request(body, signal) {
      const res = await requestGeminiStream({
        url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKeys[0] },
          body: JSON.stringify(body),
        },
        signal,
        context,
        apiKeys,
      });
      // requestGeminiStream rejects successful responses without a body.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ended = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { payloads, rest } = extractGeminiSseEvents(buffer);
          buffer = rest;
          yield* payloads;
        }
        ended = true;
      } finally {
        // The loop stopped reading before the body ended: close the request
        // rather than leave Google streaming into a reader nobody drains.
        if (!ended) await reader.cancel().catch(() => undefined);
      }
      buffer += decoder.decode();
      if (buffer) yield* extractGeminiSseEvents(buffer, true).payloads;
    },
  };
}

/**
 * Gemini, through the shared loop (SPEC §5.0, §5.3): turns, multimodality,
 * thinking, the tool loop, Google Search grounding and usage. This module wires
 * the keys, the network and the history conversion — which reads attachment
 * bytes from storage — into `geminiLoop`, where everything that is sent is
 * decided.
 */
export async function* streamGemini(req: AdapterRequest): AsyncGenerator<LlmEvent> {
  const { model } = req;
  const apiKeys = getGoogleApiKeys();
  if (apiKeys.length === 0 && !req.transport) throw new Error("Google API key is not configured.");

  const contents = await toGeminiContents(
    req.history,
    model.vision,
    undefined,
    attachmentTextBudget(getModelMetrics(model).contextTokens)
  );
  if (req.dynamicContext) {
    let lastUser = contents.length;
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    contents.splice(lastUser, 0, { role: "user", parts: [{ text: req.dynamicContext }] });
  }

  const context: GeminiRequestContext = {
    modelId: model.id,
    providerModel: model.providerModel,
    reasoningEffort: req.reasoningEffort ?? null,
    endpoint: `${geminiModelPath(model)}:streamGenerateContent`,
    requestId: req.requestContext?.requestId,
    generationId: req.requestContext?.generationId,
    conversationId: req.requestContext?.conversationId,
  };

  yield* geminiLoop(req, {
    transport: req.transport ?? fetchTransport(geminiEndpoint(model, "streamGenerateContent"), apiKeys, context),
    contents,
    context,
    resolveSources: resolveGroundingUrls,
  });
}

/*
 * A MISSING TERMINAL MARKER IS NOT A REASON TO DESTROY A DELIVERED ANSWER, and
 * FINISH_REASON_UNSPECIFIED is not the sentinel for one: see the end of
 * `geminiLoop` (src/lib/llm/gemini-loop.ts), which decides that case on
 * evidence — usage at the cap is `length`, usage below it is `stop`, and only
 * a stream with neither an answer nor a terminator is an error.
 */
