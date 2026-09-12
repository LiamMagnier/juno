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
export function extractGeminiSseEvents(buffer: string): { payloads: string[]; rest: string } {
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
