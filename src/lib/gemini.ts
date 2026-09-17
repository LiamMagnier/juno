import "server-only";
import {
  GEMINI_CONTINUE_INSTRUCTION,
  MAX_GEMINI_CONTINUATIONS,
  decideGeminiFinish,
  geminiShouldContinue,
  type GeminiFinishDecision,
} from "@/lib/gemini-finish";
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
  geminiContinuationConfig,
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
  appendGeminiContinuation,
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
  // `let`, because a continuation pass rebuilds it at the thinking floor.
  let generationConfig = geminiGenerationConfig(model, maxTokens, reasoningEffort);

  const sources = new Map<string, ClientSource>();
  let cumInput = 0;
  let cumOutput = 0;
  let cumCached = 0;
  let cumThoughts = 0;
  let cumTotal = 0;
  let sawUsage = false;
  /** Did any ANSWER text reach the transcript this turn? (Thoughts don't count.) */
  let sawAnswer = false;
  /**
   * The answer's tail, for `looksTruncated`. Capped rather than accumulated in
   * full: the question is only ever about how the text ENDS, and holding a
   * whole reply here to inspect its last character would double this turn's
   * memory for nothing.
   */
  let answerTail = "";
  /** Wire-shape evidence, for the log line when a turn ends with no terminator. */
  let frames = 0;
  let framesUnparsed = 0;
  let lastPayloadKeys = "";
  let lastFinishReason: string | undefined;
  let groundedWithSearchWidget = false;

  const maxRounds = hasTools ? MAX_GEMINI_TOOL_ROUNDS + 1 : 1;

  /*
   * TWO NESTED LOOPS, AND THEY ARE NOT THE SAME LOOP.
   *
   * The inner one is the TOOL loop: rounds of one conversation, where the model
   * asked for something and the answer to it goes back in.
   *
   * The outer one is CONTINUATION, and it exists because Gemini 3 charges
   * thinking and prose to a single `maxOutputTokens` ceiling. A turn at HIGH
   * expands its reasoning to fill nearly all of it and then writes the answer in
   * whatever is left, so a request that asked for Google's own published maximum
   * comes back cut off mid-sentence after a few thousand tokens. The manual
   * lever loops: Continue re-runs the turn at the same level into the same
   * budget and gets the same split back. `geminiShouldContinue` argues how
   * narrow this is kept; `geminiContinuationConfig` is where the second pass
   * gets its room.
   *
   * Nested rather than merged, because a continuation is a fresh tool budget:
   * the resumed answer may still need to look something up, and it should not be
   * refused because the first pass spent the rounds.
   */
  let continuations = 0;
  let decision: GeminiFinishDecision;
  /** The LAST attempt's counts — see where they are taken, below. */
  let attemptOutput = 0;
  let attemptThoughts = 0;

  for (;;) {
    /*
     * PER ATTEMPT, NOT PER TURN. Left at the previous attempt's value, a
     * continuation that ends without a terminal frame would be judged on the
     * earlier pass's MAX_TOKENS — reporting a resumed answer as truncated
     * however cleanly it finished, which is the false "hit the limit" label
     * this module exists to stop printing.
     */
    lastFinishReason = undefined;
    const startOutput = cumOutput;
    const startThoughts = cumThoughts;

    /*
     * A FAILED CONTINUATION MUST NOT TAKE THE ANSWER WITH IT.
     *
     * Everything below can throw — an empty stream, a 500, a dropped socket —
     * and on the FIRST attempt that is correct: there is nothing to lose and
     * the reader is owed the real error. On a continuation it is catastrophic.
     * The turn already has an answer on screen; throwing here would replace it
     * with a provider-outage notice, which is the exact "Generation failed"
     * printed over delivered text that the comment at the foot of this file
     * exists to record. The reader would have lost a good partial reply BECAUSE
     * Juno tried to make it longer.
     *
     * So a continuation that fails simply ends the turn where the previous
     * attempt left it: `decision` still holds that attempt's verdict, so the
     * label and the note are the ones the reader would have got had this pass
     * never been attempted. Logged at warn, because a provider failing every
     * continuation is worth knowing about and is invisible from the transcript.
     */
    try {
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
            frames += 1;
            // KEYS ONLY, never values: this line exists to identify a wire shape,
            // and the values are the user's conversation.
            try {
              lastPayloadKeys = Object.keys(JSON.parse(payload) as object).join(",");
            } catch {
              framesUnparsed += 1;
            }
            applyGeminiChunk(state, payload, sources);
            while (state.events.length > 0) {
              const ev = state.events.shift();
              if (!ev) continue;
              if (ev.type === "text") {
                sawAnswer = true;
                answerTail = (answerTail + ev.text).slice(-4096);
              }
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
    } catch (error) {
      if (continuations === 0) throw error;
      console.warn("[llm:gemini] continuation failed; keeping the answer so far", {
        model: model.providerModel,
        attempt: continuations,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }

    /*
     * THE COUNTS THIS ATTEMPT PRODUCED, not the turn's running total, and both
     * readers of them are per-request questions.
     *
     * "Did the model run out of room?" is asked of one ceiling and one request.
     * Carry the first pass's 59k of thinking into the second and every
     * continuation looks starved — including one that thought for nothing and
     * wrote 60k of prose — so the adapter would spend its whole allowance every
     * single time. And the reader's sentence ("thinking used X of the Y this
     * model can produce in one reply") is a claim about ONE reply.
     *
     * On a turn that is never continued — every turn that is not this bug —
     * these are identical to the cumulative figures, so nothing else moves.
     */
    attemptOutput = cumOutput - startOutput;
    attemptThoughts = cumThoughts - startThoughts;

    decision = decideGeminiFinish({
      lastFinishReason: lastFinishReason ?? null,
      sawUsage,
      answerTokens: attemptOutput,
      thoughtTokens: attemptThoughts,
      maxTokens,
      answerTail,
      continued: continuations,
    });

    const canContinue =
      continuations < MAX_GEMINI_CONTINUATIONS &&
      // An aborted turn is a reader who has stopped reading. Spending another
      // request to finish prose for them is the one case where continuing is
      // strictly worse than the stub.
      !signal?.aborted &&
      geminiShouldContinue(decision.reason, {
        sawUsage,
        answerTokens: attemptOutput,
        thoughtTokens: attemptThoughts,
        maxTokens,
      });

    if (!canContinue) break;

    continuations += 1;
    console.info("[llm:gemini] resuming a thinking-starved answer", {
      model: model.providerModel,
      reasoningEffort: reasoningEffort ?? null,
      attempt: continuations,
      thoughtTokens: attemptThoughts,
      answerTokens: attemptOutput,
      maxOutputTokens: maxTokens,
    });
    appendGeminiContinuation(contents, answerTail, GEMINI_CONTINUE_INSTRUCTION);
    // Rebuilt rather than mutated: `geminiRequestBody` is handed this object on
    // every round, and "this pass runs at a different level" should be one
    // readable assignment rather than a field poked in place.
    generationConfig = geminiContinuationConfig(model, maxTokens);
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
   * AND `FINISH_REASON_UNSPECIFIED` WAS THE WRONG SENTINEL. It falls through
   * `normalizeFinishReason` to `"unknown"`, and `"unknown"` is a deliberate,
   * LOUD state: the UI titles it "Stream ended unexpectedly" over "The provider
   * closed the stream without a recognized finish reason" and marks the turn
   * Failed. That state is reserved for reasons Google DID send and Juno cannot
   * honestly restate — MALFORMED_FUNCTION_CALL, LANGUAGE, OTHER — which is a
   * different situation from no reason arriving at all. Routing this case there
   * turned a hard error into a red banner printed over a complete answer, which
   * is what the user then reported. Two wrong messages in a row for one cause.
   *
   * So the two situations are now separated, and this one is decided on
   * EVIDENCE rather than on a sentinel:
   *
   *   usage arrived and the answer is at the cap  -> "length" (Continue helps)
   *   usage arrived and it is not                 -> "stop"   (it finished)
   *   no usage at all                             -> "stop", and logged
   *
   * The last case is a judgement, and it is the right one: the alternative is
   * telling someone their finished answer failed. It is logged at warn with the
   * wire shape (frame counts, the last payload's KEYS — never its values) so
   * the cause stays findable instead of being smoothed over.
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

  // Decided inside the attempt loop, because the loop has to read it to know
  // whether to run again. `for (;;)` has no exit that skips the assignment, so
  // by the time control reaches here it is always the last attempt's verdict.
  const finalDecision = decision!;
  const finalRaw = finalDecision.raw;
  if (finalDecision.decidedOnEvidence) {
    console.warn("[llm:gemini] no terminal frame; finishing on evidence", {
      model: model.providerModel,
      reasoningEffort: reasoningEffort ?? null,
      decided: finalRaw,
      atCap: finalDecision.atCap,
      truncated: finalDecision.truncated,
      sawAnswer,
      sawUsage,
      // The last attempt's, matching the verdict they produced. The turn's
      // totals are on the usage event above.
      completionTokens: sawUsage ? attemptOutput : null,
      thoughtTokens: sawUsage ? attemptThoughts : null,
      continuations,
      maxOutputTokens: maxTokens,
      frames,
      framesUnparsed,
      lastPayloadKeys,
    });
  }

  // Operator-visible evidence that grounding actually ran: the UI announces
  // "Google Search grounding" from the request side, and for a long time that
  // announcement was the only trace of a search that never happened.
  console.info("[llm:gemini] stream finish", {
    model: model.providerModel,
    finishReason: finalRaw,
    continuations,
    webSearch: !!webSearch,
    grounded: sources.size > 0 || groundedWithSearchWidget,
    sources: sources.size,
    promptTokens: sawUsage ? cumInput : null,
    completionTokens: sawUsage ? cumOutput : null,
    thoughtTokens: sawUsage ? cumThoughts || null : null,
    cachedTokens: sawUsage ? cumCached || null : null,
  });
  yield { type: "finish", reason: finalDecision.reason, raw: finalRaw, note: finalDecision.note };
}
