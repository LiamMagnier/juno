/**
 * The Gemini adapter's request, stream-reading and replay loop (SPEC §5.0,
 * §5.3), free of `server-only`.
 *
 * `gemini.ts` keeps the API keys, the retrying fetch and the history conversion
 * (which reads attachment bytes from storage) and hands this loop a transport
 * that yields the decoded SSE `data:` payloads. Everything that decides what is
 * SENT lives here, so a test drives a whole tool turn offline and asserts on
 * the bodies: which schema field a tool's parameters ride in, what a
 * `functionResponse` carries, and how the final request turns tools off.
 */

import { GeminiProviderError, type GeminiRequestContext } from "@/lib/gemini-network";
import {
  GEMINI_CONTINUE_INSTRUCTION,
  MAX_GEMINI_CONTINUATIONS,
  decideGeminiFinish,
  geminiShouldContinue,
  type GeminiFinishDecision,
} from "@/lib/gemini-finish";
import {
  geminiContinuationConfig,
  geminiFunctionDeclarations,
  geminiGenerationConfig,
  geminiRequestBody,
  geminiStructuredConfig,
  geminiToolConfig,
  geminiToolsPayload,
  isGemini3OrLater,
  type GeminiContent,
  type GeminiFunctionResponse,
  type GeminiPart,
} from "@/lib/gemini-core";
import { appendGeminiContinuation, appendGeminiToolRound, applyGeminiChunk, emptyGeminiRound, type GeminiRoundState } from "@/lib/gemini-round";
import { callIdIssuer, signalOrNever, toolRoundRunner, type ToolRoundRunner } from "@/lib/llm/tool-round";
import { NO_RESULT_TEXT } from "@/lib/llm/tool-round.prompt";
import type { AdapterRequest, ProviderTransport } from "@/lib/llm/types";
import { sendableToolImages, toolImageIntro, withheldImagesNote } from "@/lib/tool-result-images";
import type { BatchResult, ToolCallInput } from "@/lib/tools/dispatch";
import type { ClientSource } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";

export interface GeminiLoopDeps {
  /** `request(body, signal)` → the stream's decoded `data:` payloads, as JSON text. */
  transport: ProviderTransport;
  /** The conversation (dynamic context already placed). The loop appends to its own copy. */
  contents: GeminiContent[];
  /** Carried on provider errors and log lines. */
  context: GeminiRequestContext;
  /**
   * Grounding sources before they are reported — `gemini.ts` resolves Google's
   * redirect links to the publishers' URLs. Identity by default.
   */
  resolveSources?: (sources: ClientSource[]) => Promise<ClientSource[]>;
  /** Replaces the runner `toolRoundRunner(req)` would pick. Tests only. */
  runTools?: ToolRoundRunner | null;
}

/** Google's Search Suggestions markup is kept to this size on the record (SPEC §2.4). */
const SEARCH_SUGGESTIONS_MAX_BYTES = 16 * 1024;

export async function* geminiLoop(req: AdapterRequest, deps: GeminiLoopDeps): AsyncGenerator<LlmEvent> {
  const { model, loop, maxTokens, signal } = req;
  const structured = req.responseSchema ?? null;
  const runTools = structured ? null : deps.runTools !== undefined ? deps.runTools : toolRoundRunner(req);
  const toolset = runTools ? req.toolset : undefined;
  const declarations = toolset ? geminiFunctionDeclarations(toolset) : [];
  const webSearch = req.webSearch && !structured;
  const gemini3 = isGemini3OrLater(model);
  const callIdFor = callIdIssuer(req.batch?.seenCallIds);
  const resolveSources = deps.resolveSources ?? (async (list: ClientSource[]) => list);

  const contents = [...deps.contents];
  const baseConfig = (config: Record<string, unknown>) =>
    structured ? { ...config, ...geminiStructuredConfig(structured.schema) } : config;
  // `let`, because a continuation pass rebuilds it at the thinking floor.
  let generationConfig = baseConfig(geminiGenerationConfig(model, maxTokens, req.reasoningEffort));

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
   * The answer's tail, for `looksTruncated`. Capped: the question is only ever
   * about how the text ENDS, and holding a whole reply here would double this
   * turn's memory for nothing.
   */
  let answerTail = "";
  /** Wire-shape evidence, for the log line when a turn ends with no terminator. */
  let frames = 0;
  let framesUnparsed = 0;
  let lastPayloadKeys = "";
  let lastFinishReason: string | undefined;
  let groundedWithSearchWidget = false;

  /** The model step; a continuation resumes the same one (its text is glued, not a new paragraph). */
  let round = 0;
  let roundServerTools = 0;
  let roundFinal = false;
  /** Every grounding query this turn, before the free-quota split (SPEC §3.9). */
  let groundingQueries = 0;
  /** The final request's declarations are withheld instead of kept under mode NONE (probe P2 fallback). */
  let withholdOnFinal = false;
  /** The last request still asked for tools it could not be given. */
  let unansweredCalls = false;

  /**
   * One request, read to the end. Yields the text and thinking as they stream
   * and returns the request's state. Mode `NONE` on the final request is
   * unprobed (P2): if Google rejects it before streaming, the request is sent
   * once more with the declarations withheld, as the adapter did before, and
   * the rest of the turn does the same.
   */
  async function* readRequest(final: boolean): AsyncGenerator<LlmEvent, GeminiRoundState> {
    const build = () => {
      const withhold = final && withholdOnFinal;
      return geminiRequestBody({
        contents,
        generationConfig,
        system: req.system,
        tools: geminiToolsPayload({ model, functionDeclarations: declarations, webSearch, withholdDeclarations: withhold }),
        toolConfig: geminiToolConfig({ final, declarations: declarations.length > 0 && !withhold }),
      });
    };
    let opened: { iterator: AsyncIterator<unknown>; first: IteratorResult<unknown> };
    try {
      opened = await openStream(deps.transport, build(), signal);
    } catch (error) {
      const modeNoneSent = final && declarations.length > 0 && !withholdOnFinal;
      if (!modeNoneSent || !(error instanceof GeminiProviderError) || error.status !== 400) throw error;
      console.warn("[llm:gemini] final request rejected with mode NONE; withholding declarations", {
        model: model.providerModel,
        message: error.message,
      });
      withholdOnFinal = true;
      opened = await openStream(deps.transport, build(), signal);
    }

    const state = emptyGeminiRound(round);
    const drain = function* (payload: string) {
      frames += 1;
      // KEYS ONLY, never values: this line identifies a wire shape, and the
      // values are the user's conversation.
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
    };
    for (let step = opened.first; !step.done; step = await opened.iterator.next()) {
      if (typeof step.value === "string") yield* drain(step.value);
    }

    if (state.finishReason) lastFinishReason = state.finishReason;
    if (state.searchEntryPoint) groundedWithSearchWidget = true;
    if (!state.sawSignal) {
      throw new GeminiProviderError({
        httpStatus: 502,
        googleStatus: "EMPTY_STREAM",
        message: "Google ended the stream without a candidate or usage record",
        context: deps.context,
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
    return state;
  }

  /** The searches Google ran inside the request, as provider-search calls (SPEC §5.3 items 7, 11). */
  function* searchEvents(state: GeminiRoundState): Generator<LlmEvent> {
    const queries = state.webSearchQueries;
    const html = state.searchEntryPoint ? capBytes(state.searchEntryPoint, SEARCH_SUGGESTIONS_MAX_BYTES) : null;
    for (let i = 0; i < queries.length; i++) {
      // Gemini gives its searches no ids; one per query, unique in the turn.
      const callId = `ps_${round}_${groundingQueries + i}`;
      yield { type: "server_tool", phase: "call", tool: "provider_web_search", callId, round, query: queries[i] };
      yield {
        type: "server_tool",
        phase: "result",
        tool: "provider_web_search",
        callId,
        round,
        ok: true,
        // Google's widget belongs to the response, not to one query: it rides
        // on the last of them.
        ...(html && i === queries.length - 1 ? { web: { engine: "gemini", searchSuggestionsHtml: html } } : {}),
      };
    }
    groundingQueries += queries.length;
    roundServerTools += queries.length;
  }

  const usageEvent = (): LlmEvent => ({
    type: "usage",
    input: cumInput || undefined,
    output: cumOutput || undefined,
    reasoning: cumThoughts || undefined,
    total: cumTotal || undefined,
    cacheRead: cumCached || undefined,
    round,
    ...(groundingQueries > 0 ? { groundingQueries } : {}),
  });

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
   * Both spend the ONE loop budget (SPEC §4.1): a continuation is a request
   * like any other, and its tool rounds do not get a fresh allowance.
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
     * earlier pass's MAX_TOKENS.
     */
    lastFinishReason = undefined;
    const startOutput = cumOutput;
    const startThoughts = cumThoughts;

    /*
     * A FAILED CONTINUATION MUST NOT TAKE THE ANSWER WITH IT. On the first
     * attempt an error is the reader's to see; on a continuation the turn
     * already has an answer on screen, and throwing would replace it with an
     * outage notice BECAUSE Juno tried to make it longer. So a continuation that
     * fails ends the turn where the previous attempt left it.
     */
    try {
      let malformedRetried = false;
      for (;;) {
        const { final } = loop.beginRequest();
        roundFinal = final;
        const answerBefore = sawAnswer;
        const state = yield* readRequest(final);
        yield* searchEvents(state);

        /*
         * MALFORMED_FUNCTION_CALL: the model wrote a call Google could not
         * parse. The same request is sent once more (SPEC §5.3 item 8) —
         * unless answer text already streamed, which a resend would repeat.
         * A second one ends the turn as it did before.
         */
        if (state.finishReason === "MALFORMED_FUNCTION_CALL" && !malformedRetried && sawAnswer === answerBefore) {
          malformedRetried = true;
          yield usageEvent();
          continue;
        }

        const calls = state.functionCalls;
        const dispatch = !!runTools && !final && calls.length > 0;
        if (!dispatch) {
          unansweredCalls = calls.length > 0;
          yield usageEvent();
          break;
        }

        yield { type: "round_end", round, tools: calls.length, serverTools: roundServerTools, final, stop: state.finishReason };
        yield usageEvent();

        const inputs: ToolCallInput[] = calls.map((call, index) => {
          const callId = callIdFor(call.id, round, index);
          return {
            name: call.name,
            callId,
            ...(call.id ? { providerCallId: call.id } : {}),
            round,
            index,
            argsText: JSON.stringify(call.args),
          };
        });
        for (const input of inputs) {
          yield {
            type: "tool",
            phase: "call",
            server: toolset!.labelFor(input.name),
            name: input.name,
            callId: input.callId,
            ...(input.providerCallId && input.providerCallId !== input.callId ? { providerCallId: input.providerCallId } : {}),
            round,
            index: input.index,
            args: input.argsText,
          };
        }
        const results = yield* runTools!(inputs, signalOrNever(signal), loop.nextIsFinal());
        const followUp = geminiToolResponses(inputs, results, { vision: model.vision, gemini3 });
        // Replays the assistant parts UNCHANGED, thought signatures and call ids included.
        appendGeminiToolRound(contents, state.assistantParts, followUp.responses, followUp.images);
        round += 1;
        roundServerTools = 0;
        malformedRetried = false;
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
     * THE COUNTS THIS ATTEMPT PRODUCED, not the turn's running total: both
     * readers of them ("did the model run out of room?", and the sentence the
     * reader is told) are questions about one request's ceiling.
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
      // The budget is the turn's, continuations included.
      loop.requests < loop.budget &&
      // An aborted turn is a reader who has stopped reading.
      !signal?.aborted &&
      !structured &&
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
      reasoningEffort: req.reasoningEffort ?? null,
      attempt: continuations,
      thoughtTokens: attemptThoughts,
      answerTokens: attemptOutput,
      maxOutputTokens: maxTokens,
    });
    appendGeminiContinuation(contents, answerTail, GEMINI_CONTINUE_INSTRUCTION);
    generationConfig = baseConfig(geminiContinuationConfig(model, maxTokens));
  }

  // The answer step ends here, after any continuation of it.
  yield {
    type: "round_end",
    round,
    tools: 0,
    serverTools: roundServerTools,
    final: roundFinal,
    stop: lastFinishReason ?? null,
  };

  if (sources.size > 0) {
    // Grounding links never enter the provenance ledger: Google's terms forbid
    // using them to find pages to crawl (SPEC §5.3 item 7).
    yield { type: "sources", sources: await resolveSources([...sources.values()]), origin: "provider_grounding" };
  }

  /*
   * A MISSING TERMINAL MARKER IS NOT A REASON TO DESTROY A DELIVERED ANSWER.
   * An answer the reader can see is worth more than a marker the reader cannot:
   * with usage, the evidence decides between `length` and `stop`; with no
   * usage and no answer, the connection was cut and that is the error.
   */
  if (!lastFinishReason && !sawAnswer) {
    throw new GeminiProviderError({
      // NOT 5xx: nothing says Google's servers failed; the stream opened,
      // carried no answer and ended without a terminator.
      httpStatus: 499,
      googleStatus: "MISSING_FINISH_REASON",
      message: "The model stream ended with no answer and no finish reason (network interrupted)",
      context: deps.context,
    });
  }

  const finalDecision = decision!;
  if (finalDecision.decidedOnEvidence) {
    console.warn("[llm:gemini] no terminal frame; finishing on evidence", {
      model: model.providerModel,
      reasoningEffort: req.reasoningEffort ?? null,
      decided: finalDecision.raw,
      atCap: finalDecision.atCap,
      truncated: finalDecision.truncated,
      sawAnswer,
      sawUsage,
      completionTokens: sawUsage ? attemptOutput : null,
      thoughtTokens: sawUsage ? attemptThoughts : null,
      continuations,
      maxOutputTokens: maxTokens,
      frames,
      framesUnparsed,
      lastPayloadKeys,
    });
  }

  // Operator-visible evidence that grounding actually ran.
  console.info("[llm:gemini] stream finish", {
    model: model.providerModel,
    finishReason: finalDecision.raw,
    continuations,
    requests: loop.requests,
    webSearch,
    grounded: sources.size > 0 || groundedWithSearchWidget,
    sources: sources.size,
    groundingQueries,
    promptTokens: sawUsage ? cumInput : null,
    completionTokens: sawUsage ? cumOutput : null,
    thoughtTokens: sawUsage ? cumThoughts || null : null,
    cachedTokens: sawUsage ? cumCached || null : null,
  });

  if (unansweredCalls) {
    // The last request still asked for tools after the budget ran out: the
    // turn stopped using tools before it answered, which Continue resumes.
    yield { type: "finish", reason: "length", raw: lastFinishReason ?? "TOOL_BUDGET", note: finalDecision.note };
    return;
  }
  yield { type: "finish", reason: finalDecision.reason, raw: finalDecision.raw, note: finalDecision.note };
}

/**
 * The follow-up of a tool round: one `functionResponse` per call, in call
 * order (SPEC §5.3 items 1, 3, 4).
 *
 * `response.result` is the MODEL-FACING text — anything not authored by Juno
 * is inside the untrusted envelope, the one boundary every other adapter
 * already drew (RC-7, INV-30; this used to send the envelope-stripped body). A
 * failure goes back as `response.error` with its code, and the provider's own
 * call id comes back as `id`. On Gemini 3 a tool's pictures ride in the
 * response's own `parts`; older models get them as a separate user turn.
 */
export function geminiToolResponses(
  calls: readonly ToolCallInput[],
  results: readonly BatchResult[],
  opts: { vision: boolean; gemini3: boolean },
): { responses: GeminiFunctionResponse[]; images?: { intro: string; parts: GeminiPart[] } } {
  const separate: GeminiPart[] = [];
  let intro = "";
  const responses = calls.map((call, i): GeminiFunctionResponse => {
    const result = results[i]?.callId === call.callId ? results[i] : results.find((r) => r.callId === call.callId);
    const images = sendableToolImages(result?.images, opts.vision);
    const text = withheldImagesNote(result?.text ?? NO_RESULT_TEXT, result?.images, images.length);
    const inline = images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.base64 } }));
    if (!opts.gemini3 && inline.length) {
      separate.push(...inline);
      if (!intro) intro = toolImageIntro(call.name, images);
    }
    return {
      ...(call.providerCallId ? { id: call.providerCallId } : {}),
      name: call.name,
      response:
        result && !result.isError
          ? { result: text }
          : { error: { code: result?.errorCode ?? "tool_error", message: text } },
      ...(opts.gemini3 && inline.length ? { parts: inline } : {}),
    };
  });
  return { responses, ...(separate.length ? { images: { intro, parts: separate } } : {}) };
}

async function openStream(
  transport: ProviderTransport,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ iterator: AsyncIterator<unknown>; first: IteratorResult<unknown> }> {
  const iterator = transport.request(body, signal)[Symbol.asyncIterator]();
  return { iterator, first: await iterator.next() };
}

/** `text` cut to at most `max` UTF-8 bytes, never mid-character. */
function capBytes(text: string, max: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  return new TextDecoder().decode(bytes.slice(0, max)).replace(/�$/, "");
}
