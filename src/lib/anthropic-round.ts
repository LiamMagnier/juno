import type Anthropic from "@anthropic-ai/sdk";
import type { ClientSource } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";

/**
 * Consuming ONE Anthropic streaming round.
 *
 * This lives apart from `src/lib/anthropic.ts` for one reason: that module is
 * `server-only` and reaches for an API key at import time, so nothing in it can
 * be exercised by a test. The block-reassembly below is the part of the tool
 * loop most worth exercising — it rebuilds the assistant turn that gets replayed
 * to the API on the next round, and a mistake there is not a visible glitch but
 * a 400 from Anthropic or, worse, a silently dropped tool call.
 *
 * Nothing here does I/O. It takes an async iterable of raw stream events, which
 * a test can hand-write.
 */

export interface AnthropicRoundUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  reasoning: number;
  webSearchRequests: number;
  /** Last `speed` the provider reported, or null when it reported none. */
  speed: string | null;
}

export function emptyAnthropicUsage(): AnthropicRoundUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    webSearchRequests: 0,
    speed: null,
  };
}

/** The usage shape Anthropic sends, which is looser than the SDK's declared type
 *  (fields are absent, null, or present depending on the event and the model). */
export type RawAnthropicUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  output_tokens_details?: { thinking_tokens?: number } | null;
  server_tool_use?: { web_search_requests?: number } | null;
  speed?: string | null;
};

/**
 * Fold a usage payload into the round's running total, taking the maximum.
 *
 * Anthropic repeats cumulative counters across `message_start` and
 * `message_delta`, and a delta may carry only `output_tokens`. Assigning would
 * therefore let a late delta wipe the input and cache figures that arrived
 * first, which understates the bill for the round.
 *
 * Maximum is right WITHIN a round and wrong ACROSS rounds — see
 * `addAnthropicUsage`, which is how rounds combine.
 */
export function foldAnthropicUsage(into: AnthropicRoundUsage, u: RawAnthropicUsage | null | undefined): void {
  if (!u) return;
  if (u.input_tokens != null && u.input_tokens > into.input) into.input = u.input_tokens;
  if (u.output_tokens != null && u.output_tokens > into.output) into.output = u.output_tokens;
  if (u.cache_read_input_tokens != null && u.cache_read_input_tokens > into.cacheRead) {
    into.cacheRead = u.cache_read_input_tokens;
  }
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const writeAgg = u.cache_creation_input_tokens ?? 0;
  if (write5m > into.cacheWrite5m) into.cacheWrite5m = write5m;
  if (write1h > into.cacheWrite1h) into.cacheWrite1h = write1h;
  const split = into.cacheWrite5m + into.cacheWrite1h;
  if (split > into.cacheWrite) into.cacheWrite = split;
  else if (writeAgg > into.cacheWrite) into.cacheWrite = writeAgg;
  const thinking = u.output_tokens_details?.thinking_tokens ?? 0;
  if (thinking > into.reasoning) into.reasoning = thinking;
  const searches = u.server_tool_use?.web_search_requests ?? 0;
  if (searches > into.webSearchRequests) into.webSearchRequests = searches;
  if (u.speed != null) into.speed = u.speed;
}

/**
 * Bank a finished round into the turn's total, by ADDITION.
 *
 * Every tool round is a separately billed request that re-sends the whole
 * conversation, so a six-round connector turn costs roughly six times the input
 * of a one-round answer. Carrying the maximum across rounds — which is what a
 * single shared accumulator did while this adapter only ever made one request —
 * would bill that turn as though it were one, and input is both the largest and
 * the fastest-growing side of it.
 */
export function addAnthropicUsage(total: AnthropicRoundUsage, round: AnthropicRoundUsage): void {
  total.input += round.input;
  total.output += round.output;
  total.cacheRead += round.cacheRead;
  total.cacheWrite += round.cacheWrite;
  total.cacheWrite5m += round.cacheWrite5m;
  total.cacheWrite1h += round.cacheWrite1h;
  total.reasoning += round.reasoning;
  total.webSearchRequests += round.webSearchRequests;
  if (round.speed != null) total.speed = round.speed;
}

export interface AnthropicToolUse {
  /** The provider's `tool_use.id`, which is what goes back as `tool_result.tool_use_id`. */
  id: string;
  name: string;
  /** The accumulated `input_json_delta` fragments, unparsed. */
  json: string;
  /** The id the rest of the turn knows the call by (SPEC §4.3); equals `id` unless it had to be suffixed. */
  callId: string;
  /** The model step the call was made in. */
  round: number;
  /** Position among the step's client calls, 0-based. */
  index: number;
  /** False when the stream ended before the block closed — a response cut off mid-call. */
  complete: boolean;
}

export interface AnthropicRoundResult {
  /**
   * The assistant turn's content blocks in wire order, ready to be replayed to
   * the API verbatim. Order matters as much as content: a thinking block carries
   * a signature Anthropic verifies, and it must still precede the tool_use it
   * reasoned toward.
   */
  blocks: Anthropic.Messages.ContentBlockParam[];
  toolUses: AnthropicToolUse[];
  stopReason: string | null;
  usage: AnthropicRoundUsage;
  /** The model step the response ENDED in: the one the caller closes with `round_end`. */
  round: number;
  /** Provider searches made in that last step (the ones before it were closed here). */
  serverTools: number;
}

/**
 * Parse streamed `input_json_delta` fragments into an argument object.
 *
 * Used only where an OBJECT is required whatever arrived: the `input` of a
 * block replayed to Anthropic, and a provider search's query. A client tool's
 * arguments are never parsed here — the raw text goes to the dispatcher, which
 * tells the model when it is not valid JSON instead of running the tool with
 * `{}` (RC-14).
 */
export function safeToolInput(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface ReadAnthropicRoundOptions {
  labelFor?: (toolName: string) => string;
  /**
   * URLs already reported as sources this TURN, mutated here. Shared across
   * rounds so a page cited in round one is not re-announced in round three.
   */
  seen: Set<string>;
  /** The model step this response starts in (SPEC §2.9). Default 0. */
  round?: number;
  /** Whether this request was the tools-off final one; stamped on mid-response `round_end`s. */
  final?: boolean;
  /** Issues a client call's id (SPEC §4.3). Default: the provider's own id. */
  callIdFor?: (providerCallId: string, round: number, index: number) => string;
  /**
   * The step each surfaced provider search was made in, by its `srvtoolu_…`
   * id — the TURN's, mutated here, like `seen`. A `pause_turn` can end on a
   * search that has not run yet; its `web_search_tool_result` then arrives in
   * the NEXT response, and only a map that outlives the response can pair it
   * with its call. Default: a fresh map (one response on its own).
   */
  searchRound?: Map<string, number>;
}

/**
 * Read one response of the stream, yielding display events and returning the
 * structured turn.
 *
 * STEPS INSIDE ONE RESPONSE (SPEC §5.1 item 2). Claude's web search runs inside
 * the response: it writes, searches, reads the results and writes on. The text
 * after a search is the model resuming after a tool, which is what a new round
 * means, so once a search's result has arrived in a step that already had text,
 * the step is closed here with `round_end{tools: 0, serverTools}` and the text
 * that follows belongs to the next round. Both steps' text is answer text
 * (`tools: 0`); the answer joins them with a paragraph break rather than gluing
 * "…let me check.The answer is…" together.
 */
export async function* readAnthropicRound(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  opts: ReadAnthropicRoundOptions,
): AsyncGenerator<LlmEvent, AnthropicRoundResult> {
  /*
   * The assistant turn, keyed by WIRE INDEX rather than by arrival order.
   *
   * Blocks reach this loop at two different moments — `redacted_thinking` and
   * the server-tool result blocks are complete at `content_block_start`, while
   * text, thinking and both kinds of tool use are only whole at
   * `content_block_stop` — so pushing them into a flat array as they arrive can
   * reorder the turn whenever the two kinds interleave. Order is part of the
   * contract Anthropic verifies on replay (a thinking block must still precede
   * the tool_use it reasoned toward), so the index decides it, not the clock.
   */
  const blockByIndex = new Map<number, Anthropic.Messages.ContentBlockParam>();
  // Open blocks by wire index. Anthropic may interleave deltas for several
  // indices, so they cannot be accumulated into a single "current" block.
  const partial = new Map<number, OpenBlock>();
  const toolUses: AnthropicToolUse[] = [];
  const usage = emptyAnthropicUsage();
  let stopReason: string | null = null;

  let round = opts.round ?? 0;
  /** Client calls made in the current step, for their `index`. */
  let stepCalls = 0;
  /** Provider searches surfaced in the current step. */
  let stepServerTools = 0;
  /** Text was written in the current step, so a finished search closes it. */
  let stepHasText = false;
  /** The step each surfaced search was made in, by its `srvtoolu_…` id. */
  const searchRound = opts.searchRound ?? new Map<string, number>();
  const callIdFor = opts.callIdFor ?? ((id: string) => id);

  for await (const event of stream) {
    if (event.type === "message_start") {
      foldAnthropicUsage(usage, event.message.usage as RawAnthropicUsage);
    } else if (event.type === "content_block_start") {
      const raw = event.content_block as RawStartBlock;
      if (raw.type === "text") {
        partial.set(event.index, { kind: "text", block: { type: "text", text: "" }, json: "" });
      } else if (raw.type === "thinking") {
        partial.set(event.index, { kind: "thinking", block: { type: "thinking", thinking: "", signature: "" }, json: "" });
      } else if (raw.type === "tool_use") {
        const id = raw.id ?? "";
        const name = raw.name ?? "";
        const index = stepCalls++;
        const callId = callIdFor(id, round, index);
        const use: AnthropicToolUse = { id, name, json: "", callId, round, index, complete: false };
        toolUses.push(use);
        partial.set(event.index, { kind: "tool_use", block: { type: "tool_use", id, name, input: {} }, json: "", use });
        yield {
          type: "tool",
          server: opts.labelFor?.(name) ?? "connector",
          name: name || "tool",
          phase: "call",
          callId,
          ...(callId !== id && id ? { providerCallId: id } : {}),
          round,
          index,
          // NO `args` HERE, AND THIS IS NOT AN OVERSIGHT. `content_block_start`
          // carries the tool's id and name and nothing else: the arguments
          // arrive afterwards as `input_json_delta` fragments and are only
          // whole at `content_block_stop`. Anything read here would be `{}`.
          // They reach the dispatcher whole, which puts them on the first
          // `queued` act and on the result. Deferring this yield until the
          // arguments exist would cost the panel the live row — "Using Linear"
          // would appear only after Linear had already answered.
        };
      } else if (raw.type === "server_tool_use") {
        // Streams its input like a client tool_use (RC-11): the query arrives
        // as `input_json_delta` and is whole at `content_block_stop`. The block
        // stays in the assistant turn either way — a `pause_turn` can end ON a
        // search that has not run yet, and continuing it means sending it back
        // with its real input, not the `{}` it started with.
        partial.set(event.index, {
          kind: "server_tool_use",
          block: event.content_block as unknown as Anthropic.Messages.ContentBlockParam,
          json: "",
          startInput: raw.input,
          // Only Claude's own top-level web search is a search the reader sees.
          // Dynamic filtering runs code that calls tools of its own; those
          // blocks carry a `caller` and are replayed, never surfaced.
          surfaced: raw.name === "web_search" && !raw.caller,
        });
      } else if (typeof raw.type === "string") {
        // Complete at start and opaque to Juno: `redacted_thinking` (must be
        // echoed back untouched or the replayed turn fails signature
        // verification), `web_search_tool_result`, and the result blocks of
        // dynamic filtering's nested code execution. PART OF THE ASSISTANT
        // TURN, all of them: dropping the search results from the replay made
        // Claude search again next round, billed again each time.
        blockByIndex.set(event.index, event.content_block as unknown as Anthropic.Messages.ContentBlockParam);
      }

      if (raw.type === "web_search_tool_result") {
        const content = raw.content;
        const hits = Array.isArray(content)
          ? content.filter((c): c is { type: string; url: string; title?: string } =>
              isRecord(c) && c.type === "web_search_result" && typeof c.url === "string" && c.url.length > 0,
            )
          : [];
        const sources: ClientSource[] = hits
          .filter((c) => !opts.seen.has(c.url))
          .map((c) => {
            opts.seen.add(c.url);
            return { title: c.title || c.url, url: c.url, snippet: "" };
          });
        const callRound = raw.tool_use_id ? searchRound.get(raw.tool_use_id) : undefined;
        if (raw.tool_use_id && callRound !== undefined) {
          // A 200 carrying `web_search_tool_result_error` is how a failed server
          // search arrives; the content is an object, not a list.
          yield {
            type: "server_tool",
            phase: "result",
            tool: "provider_web_search",
            callId: raw.tool_use_id,
            round: callRound,
            results: hits.length,
            ok: Array.isArray(content),
          };
        }
        if (sources.length) yield { type: "sources", sources, origin: "provider_search" };
        if (callRound !== undefined && callRound === round && stepHasText) {
          yield { type: "round_end", round, tools: 0, serverTools: stepServerTools, final: !!opts.final, stop: null };
          round += 1;
          stepCalls = 0;
          stepServerTools = 0;
          stepHasText = false;
        }
      }
    } else if (event.type === "content_block_delta") {
      const open = partial.get(event.index);
      if (event.delta.type === "text_delta") {
        if (open?.kind === "text" && open.block.type === "text") open.block.text += event.delta.text;
        if (event.delta.text) stepHasText = true;
        yield { type: "text", text: event.delta.text, round };
      } else if (event.delta.type === "thinking_delta") {
        if (open?.kind === "thinking" && open.block.type === "thinking") open.block.thinking += event.delta.thinking;
        yield { type: "reasoning", text: event.delta.thinking, round };
      } else if (event.delta.type === "signature_delta") {
        if (open?.kind === "thinking" && open.block.type === "thinking") open.block.signature += event.delta.signature;
      } else if (event.delta.type === "input_json_delta") {
        if (open) open.json += event.delta.partial_json;
      }
    } else if (event.type === "content_block_stop") {
      const open = partial.get(event.index);
      if (!open) continue;
      partial.delete(event.index);
      if (open.kind === "tool_use" && open.block.type === "tool_use") {
        open.block.input = safeToolInput(open.json);
        open.use.json = open.json;
        open.use.complete = true;
      } else if (open.kind === "server_tool_use") {
        const input = open.json.trim() ? safeToolInput(open.json) : isRecord(open.startInput) ? open.startInput : {};
        (open.block as unknown as { input: Record<string, unknown> }).input = input;
        const id = (open.block as unknown as { id?: string }).id;
        if (open.surfaced && id) {
          searchRound.set(id, round);
          stepServerTools += 1;
          yield {
            type: "server_tool",
            phase: "call",
            tool: "provider_web_search",
            callId: id,
            round,
            ...(typeof input.query === "string" ? { query: input.query } : {}),
          };
        }
      }
      // A text block that opened but never received a delta is a real wire
      // event (Claude often opens one before deciding to call a tool). It
      // must NOT be replayed: the Messages API rejects an assistant turn
      // containing an empty or whitespace-only text block with
      // `400 messages: text content blocks must be non-empty`, which would
      // fail round two of a turn that was otherwise fine.
      if (open.block.type === "text" && !open.block.text.trim()) continue;
      blockByIndex.set(event.index, open.block);
    } else if (event.type === "message_delta") {
      foldAnthropicUsage(usage, event.usage as RawAnthropicUsage);
      stopReason = (event.delta as { stop_reason?: string | null }).stop_reason ?? null;
    }
  }

  // A block still open here was cut off mid-stream (`max_tokens` mid-call).
  // A client call is kept, marked incomplete, so the caller can close its row;
  // a half-written block is never replayed.
  for (const open of partial.values()) {
    if (open.kind === "tool_use") open.use.json = open.json;
  }

  const blocks = [...blockByIndex.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  return { blocks, toolUses, stopReason, usage, round, serverTools: stepServerTools };
}

/** The fields of a `content_block_start` block the reader looks at. */
type RawStartBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  /** Present on blocks issued by dynamic filtering's code, not by Claude directly. */
  caller?: unknown;
};

type OpenBlock =
  | { kind: "text" | "thinking"; block: Anthropic.Messages.ContentBlockParam; json: string }
  | { kind: "tool_use"; block: Anthropic.Messages.ContentBlockParam; json: string; use: AnthropicToolUse }
  | {
      kind: "server_tool_use";
      block: Anthropic.Messages.ContentBlockParam;
      json: string;
      startInput: unknown;
      surfaced: boolean;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
