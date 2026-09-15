import type { GeminiContent, GeminiPart } from "@/lib/gemini-core";
import type { ClientSource } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";

/**
 * Consuming ONE Gemini streaming round.
 *
 * Split out of `src/lib/gemini.ts` for the same reason `anthropic-round.ts` was
 * split out of `anthropic.ts`: that module is `server-only` and reads an API key,
 * so nothing in it can be exercised by a test — and the part most worth
 * exercising is exactly the part that rebuilds the assistant turn replayed on
 * the next tool round. A dropped `thoughtSignature` there is not a visible
 * glitch; it is a 400 from Google on round two of every turn that carries a
 * tool, which includes every turn with web search on.
 *
 * Nothing here does I/O. It takes decoded SSE payloads, which a test can
 * hand-write.
 */

/** The subset of a Gemini SSE frame Juno reads. */
export interface GeminiChunkPart {
  text?: string;
  thought?: boolean;
  /** Opaque Gemini 3 reasoning token — echoed back verbatim, never synthesised. */
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

export interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiChunkPart[] };
    finishReason?: string;
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
      searchEntryPoint?: { renderedContent?: string };
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

export interface GeminiRoundUsage {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  total: number;
}

export interface GeminiRoundState {
  /** Display events produced by this chunk, drained by the adapter in order. */
  events: LlmEvent[];
  /** The assistant turn, in wire order, ready to be replayed verbatim. */
  assistantParts: GeminiPart[];
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
  usage: GeminiRoundUsage;
  sawUsage: boolean;
  /** Any candidate or usage record at all — an empty stream is a provider fault. */
  sawSignal: boolean;
  finishReason: string | null;
  /** Google's required search-attribution widget, when grounding ran. */
  searchEntryPoint: string | null;
}

export function emptyGeminiRound(): GeminiRoundState {
  return {
    events: [],
    assistantParts: [],
    functionCalls: [],
    usage: { input: 0, output: 0, cached: 0, thoughts: 0, total: 0 },
    sawUsage: false,
    sawSignal: false,
    finishReason: null,
    searchEntryPoint: null,
  };
}

/**
 * Split a decoded SSE buffer into complete `data:` payloads.
 *
 * Returns the unconsumed tail so a frame straddling two network chunks is not
 * parsed in halves.
 */
export function extractGeminiSseEvents(
  buffer: string,
  /**
   * THE LAST FRAME HAS NO NEWLINE AFTER IT, and without this flag it was
   * thrown away — which is the whole of "Gemini is temporarily unavailable".
   *
   * Mid-stream the loop below is correct: a `data:` line is only complete once
   * its terminating newline has arrived, so an unterminated tail must stay in
   * `rest` until the next read. But at end-of-stream there is no next read. A
   * server that does not send a trailing newline after its final frame leaves
   * that frame stranded in `rest` for ever, and Gemini's final frame is the
   * one carrying `finishReason` and `usageMetadata`.
   *
   * The consequence was not a missing token count. `streamGemini` throws
   * `MISSING_FINISH_REASON` with a synthetic httpStatus 502 when no terminal
   * reason arrived, `classifyProviderError` maps anything >= 500 to `capacity`,
   * and `capacity` renders as "temporarily unavailable (a server error on
   * their end)" — so a request Google answered correctly, whose text had
   * already streamed into the transcript, was destroyed at the finish line and
   * blamed on Google. It showed up as "works for short replies, fails for long
   * ones, fails every time on High thinking" because the more frames a
   * response has, the likelier its last one is to end on the read boundary
   * with the terminator unflushed.
   *
   * Pass `flush` once, after the reader reports done.
   */
  flush = false,
): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n")) !== -1) {
    const line = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 1);
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (json) payloads.push(json);
  }
  if (flush) {
    const line = rest.trim();
    rest = "";
    if (line.startsWith("data:")) {
      const json = line.slice(5).trim();
      // Still only a COMPLETE frame: a genuinely truncated stream leaves
      // invalid JSON here, and `applyGeminiChunk` drops it as it always has.
      if (json) payloads.push(json);
    }
  }
  return { payloads, rest };
}

/**
 * Fold one usage record into the round.
 *
 * Gemini repeats CUMULATIVE counters on every frame, so the maximum is right
 * within a round: a final frame that reports only some of the fields cannot
 * then erase the ones that arrived earlier. (Rounds are summed by the caller —
 * each tool round is a separately billed request that re-sends the whole
 * conversation.)
 */
export function foldGeminiUsage(into: GeminiRoundUsage, usage: GeminiChunk["usageMetadata"]): void {
  if (!usage) return;
  into.input = Math.max(into.input, usage.promptTokenCount ?? 0);
  into.output = Math.max(into.output, usage.candidatesTokenCount ?? 0);
  into.cached = Math.max(into.cached, usage.cachedContentTokenCount ?? 0);
  into.thoughts = Math.max(into.thoughts, usage.thoughtsTokenCount ?? 0);
  into.total = Math.max(into.total, usage.totalTokenCount ?? 0);
}

/**
 * Apply one decoded SSE payload to the round.
 *
 * @param sources URLs already reported this TURN, mutated here, so a page cited
 *        in round one is not announced again in round three.
 */
export function applyGeminiChunk(
  state: GeminiRoundState,
  jsonText: string,
  sources: Map<string, ClientSource>,
): void {
  let data: GeminiChunk;
  try {
    data = JSON.parse(jsonText) as GeminiChunk;
  } catch {
    // A truncated or keep-alive frame is not a provider fault; `sawSignal`
    // stays false and the caller decides whether the whole round was empty.
    return;
  }

  const candidate = data.candidates?.[0];
  if (candidate || data.usageMetadata) state.sawSignal = true;
  if (candidate?.finishReason) state.finishReason = candidate.finishReason;

  for (const part of candidate?.content?.parts ?? []) {
    // Echo EXACTLY what arrived. On parallel calls only some parts carry a
    // signature, and Google validates the token against the part it was issued
    // for — copying one across parts or inventing one fails the same way
    // dropping it does.
    const signature = part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {};
    if (part.functionCall?.name) {
      const name = part.functionCall.name;
      const args = part.functionCall.args ?? {};
      state.functionCalls.push({ name, args });
      state.assistantParts.push({ functionCall: { name, args }, ...signature });
    } else if (part.text) {
      state.assistantParts.push(
        part.thought ? { thought: true, text: part.text, ...signature } : { text: part.text, ...signature },
      );
      state.events.push(part.thought ? { type: "reasoning", text: part.text } : { type: "text", text: part.text });
    }
  }

  const grounding = candidate?.groundingMetadata;
  for (const chunk of grounding?.groundingChunks ?? []) {
    const web = chunk.web;
    if (web?.uri && !sources.has(web.uri)) {
      sources.set(web.uri, { title: web.title || web.uri, url: web.uri, snippet: "" });
    }
  }
  // Google's grounding terms require the Search Suggestions widget to be shown
  // alongside grounded answers; it was parsed away and never surfaced.
  const entryPoint = grounding?.searchEntryPoint?.renderedContent;
  if (entryPoint && !state.searchEntryPoint) state.searchEntryPoint = entryPoint;

  if (data.usageMetadata) {
    state.sawUsage = true;
    foldGeminiUsage(state.usage, data.usageMetadata);
  }
}

/**
 * Append a finished tool round to the conversation.
 *
 * The assistant turn goes back with its parts UNCHANGED — signatures included —
 * followed by one `functionResponse` per call, in call order. Both halves are
 * required: Gemini rejects a `functionResponse` whose `functionCall` is missing
 * from history, and rejects the `functionCall` if its `thoughtSignature` was
 * stripped on the way through.
 */
export function appendGeminiToolRound(
  contents: GeminiContent[],
  assistantParts: GeminiPart[],
  responses: Array<{ name: string; response: Record<string, unknown> }>,
): void {
  contents.push({ role: "model", parts: assistantParts });
  contents.push({
    role: "user",
    parts: responses.map((r) => ({ functionResponse: { name: r.name, response: r.response } })),
  });
}

/**
 * How much of the cut-off answer the continuation is shown.
 *
 * The transcript already holds the whole reply — the reader can see it — so
 * this is not about carrying the text, it is about giving the model enough
 * runway to match its own voice, format and place in the argument. Two thousand
 * characters is a few paragraphs, or the open code fence and the function it is
 * halfway through, which is what "resume from exactly here" needs.
 *
 * Deliberately NOT the full answer: re-sending 60k tokens of prose the model has
 * already been billed for, on a request whose entire purpose is to buy room for
 * more prose, spends the thing it is trying to save.
 */
export const GEMINI_CONTINUE_TAIL_CHARS = 2000;

/**
 * Stage a continuation: the tail of what the model wrote, as the model's own
 * turn, followed by the instruction to resume.
 *
 * The model turn matters more than the instruction. A prompt that merely
 * DESCRIBES the partial answer ("you were writing about X, carry on") makes the
 * model re-enter the topic from outside and write an introduction; handing it
 * back its own last words, in its own role, puts it mid-sentence — which is
 * where the seam has to be invisible.
 *
 * Mutates `contents` in place, like `appendGeminiToolRound` beside it, because
 * the adapter threads one array through every round of a turn.
 */
export function appendGeminiContinuation(
  contents: GeminiContent[],
  answerTail: string,
  instruction: string,
): void {
  const tail = answerTail.slice(-GEMINI_CONTINUE_TAIL_CHARS);
  // An empty tail would stage a model turn with no text, which Gemini rejects as
  // a malformed request — a 400 in place of the rest of somebody's answer. The
  // caller already refuses to continue an empty answer; this keeps that a local
  // fact rather than a call-site obligation.
  if (tail.length > 0) contents.push({ role: "model", parts: [{ text: tail }] });
  contents.push({ role: "user", parts: [{ text: instruction }] });
}
