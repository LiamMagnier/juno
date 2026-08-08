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
  id: string;
  name: string;
  /** The accumulated `input_json_delta` fragments, unparsed. */
  json: string;
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
}

/**
 * Parse streamed `input_json_delta` fragments into tool arguments.
 *
 * A truncated or malformed accumulation becomes `{}` rather than throwing: the
 * approval broker classifies and previews whatever it is handed, and an empty
 * object is both honest about what arrived and safe — `classifyExternalAction`
 * reads the absence of argument tokens as LESS evidence, never as more
 * permission.
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

/**
 * Read one round of the stream, yielding display events and returning the
 * structured turn.
 *
 * @param seen URLs already reported as sources this TURN, mutated here. Shared
 *        across rounds so a page cited in round one is not re-announced in
 *        round three.
 */
export async function* readAnthropicRound(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  opts: { labelFor?: (toolName: string) => string; seen: Set<string> }
): AsyncGenerator<LlmEvent, AnthropicRoundResult> {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  // Open blocks by wire index. Anthropic may interleave deltas for several
  // indices, so they cannot be accumulated into a single "current" block.
  const partial = new Map<number, { block: Anthropic.Messages.ContentBlockParam; json: string }>();
  const toolUses: AnthropicToolUse[] = [];
  const usage = emptyAnthropicUsage();
  let stopReason: string | null = null;

  for await (const event of stream) {
    if (event.type === "message_start") {
      foldAnthropicUsage(usage, event.message.usage as RawAnthropicUsage);
    } else if (event.type === "content_block_start") {
      const raw = event.content_block as { type?: string; id?: string; name?: string; content?: unknown };
      if (raw.type === "text") {
        partial.set(event.index, { block: { type: "text", text: "" }, json: "" });
      } else if (raw.type === "thinking") {
        partial.set(event.index, { block: { type: "thinking", thinking: "", signature: "" }, json: "" });
      } else if (raw.type === "redacted_thinking") {
        // Opaque to Juno by design, and must be echoed back untouched or the
        // replayed turn fails signature verification.
        blocks.push(event.content_block as Anthropic.Messages.ContentBlockParam);
      } else if (raw.type === "tool_use") {
        partial.set(event.index, {
          block: { type: "tool_use", id: raw.id ?? "", name: raw.name ?? "", input: {} },
          json: "",
        });
        yield {
          type: "tool",
          server: opts.labelFor?.(raw.name ?? "") ?? "connector",
          name: raw.name ?? "tool",
          phase: "call",
          callId: raw.id ?? "",
          // NO `args` HERE, AND THIS IS NOT AN OVERSIGHT. `content_block_start`
          // carries the tool's id and name and nothing else: the arguments
          // arrive afterwards as `input_json_delta` fragments and are only
          // whole at `content_block_stop`. Anything read here would be `{}`.
          // Anthropic attaches them to the RESULT event instead
          // (anthropic.ts), which is the whole reason the wire contract lets
          // args ride on either act. Deferring this yield until the arguments
          // exist would cost the panel the live row — "Using Linear" would
          // appear only after Linear had already answered.
        };
      } else if (raw.type === "web_search_tool_result") {
        const content = raw.content;
        if (Array.isArray(content)) {
          const sources: ClientSource[] = content
            .filter((c: { type?: string; url?: string }) => c?.type === "web_search_result" && c?.url && !opts.seen.has(c.url))
            .map((c: { url: string; title?: string }) => {
              opts.seen.add(c.url);
              return { title: c.title || c.url, url: c.url, snippet: "" };
            });
          if (sources.length) yield { type: "sources", sources };
        }
      }
    } else if (event.type === "content_block_delta") {
      const open = partial.get(event.index);
      if (event.delta.type === "text_delta") {
        if (open?.block.type === "text") open.block.text += event.delta.text;
        yield { type: "text", text: event.delta.text };
      } else if (event.delta.type === "thinking_delta") {
        if (open?.block.type === "thinking") open.block.thinking += event.delta.thinking;
        yield { type: "reasoning", text: event.delta.thinking };
      } else if (event.delta.type === "signature_delta") {
        if (open?.block.type === "thinking") open.block.signature += event.delta.signature;
      } else if (event.delta.type === "input_json_delta") {
        if (open) open.json += event.delta.partial_json;
      }
    } else if (event.type === "content_block_stop") {
      const open = partial.get(event.index);
      if (open) {
        partial.delete(event.index);
        if (open.block.type === "tool_use") {
          open.block.input = safeToolInput(open.json);
          toolUses.push({ id: open.block.id, name: open.block.name, json: open.json });
        }
        blocks.push(open.block);
      }
    } else if (event.type === "message_delta") {
      foldAnthropicUsage(usage, event.usage as RawAnthropicUsage);
      stopReason = (event.delta as { stop_reason?: string | null }).stop_reason ?? null;
    }
  }

  return { blocks, toolUses, stopReason, usage };
}
