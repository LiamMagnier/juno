/**
 * Anthropic prompt-cache placement for the conversation, shared by the chat
 * adapter (src/lib/anthropic.ts) and the tool-loop adapter
 * (src/lib/llm/anthropic-loop.ts). Pure: no SDK client, no I/O.
 *
 * See docs/pricing/COST_ENGINEERING.md for why the marker moves every request.
 */
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Text blocks that carry per-generation context (a message's `volatileTail`).
 * The conversation breakpoint is never placed on one: it changes every turn,
 * so a cache entry ending in it is one no later request can read.
 */
const VOLATILE_BLOCKS = new WeakSet<object>();

/** A text block the conversation breakpoint must stay in front of. */
export function volatileTextBlock(text: string): Anthropic.TextBlockParam {
  const block: Anthropic.TextBlockParam = { type: "text", text };
  VOLATILE_BLOCKS.add(block);
  return block;
}

export function isVolatileBlock(block: unknown): boolean {
  return typeof block === "object" && block !== null && VOLATILE_BLOCKS.has(block);
}

/**
 * Put the conversation's prompt-cache breakpoint on the newest message.
 *
 * With the cached system prompt this caches the whole growing conversation
 * prefix: each turn reads the previous turn's cache (~0.1x input cost) and
 * writes only the delta. Anthropic ignores the marker below its minimum size.
 *
 * MOVED, NOT ADDED, and called again before every request of a tool loop. A
 * loop re-sends the whole conversation each round; with the marker pinned to
 * the user's message, every tool result and assistant step appended after it
 * was billed as fresh input on every later round of the same turn. Moving the
 * marker to the newest tool_result lets round N+1 read what round N wrote
 * (the 20-block lookback finds it). One marker at a time keeps the request
 * inside Anthropic's four-breakpoint limit (tools, two system tiers, this).
 *
 * The marker skips a trailing volatile block (`volatileTextBlock`): the
 * per-turn context after the user's words is not part of the prefix the next
 * turn will send. A newest message that is the assistant's own (a
 * `pause_turn` continuation, whose server-tool blocks are not marker targets)
 * keeps the previous marker where it is.
 */
export function markConversationCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return;
  const cacheControl = { type: "ephemeral" as const };
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if ("cache_control" in block && (block as { cache_control?: unknown }).cache_control) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content || "(no content)", cache_control: cacheControl }];
    return;
  }
  let index = last.content.length - 1;
  while (index > 0 && isVolatileBlock(last.content[index])) index -= 1;
  const block = last.content[index];
  // cache_control is honored on text/image/document/tool_result blocks — exactly what history holds.
  if (block && !isVolatileBlock(block)) (block as { cache_control?: typeof cacheControl }).cache_control = cacheControl;
}

/**
 * `markConversationCacheBreakpoint` without touching the caller's history: the
 * messages for ONE request, with the marker on that request's newest message.
 *
 * The tool loops keep one growing `messages` array across rounds and send it
 * each time; marking it in place would leave the previous round's marker on a
 * block a scripted transport (or a retry) still holds. Only the newest message
 * and its marked block are copied; everything else is shared.
 */
export function withConversationCacheBreakpoint(messages: readonly Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out = [...messages];
  const last = out[out.length - 1];
  if (!last || last.role !== "user") return out;
  const cacheControl = { type: "ephemeral" as const };
  if (typeof last.content === "string") {
    out[out.length - 1] = { ...last, content: [{ type: "text", text: last.content || "(no content)", cache_control: cacheControl }] };
    return out;
  }
  let index = last.content.length - 1;
  while (index > 0 && isVolatileBlock(last.content[index])) index -= 1;
  const block = last.content[index];
  if (!block || isVolatileBlock(block)) return out;
  const content = [...last.content];
  content[index] = { ...block, cache_control: cacheControl } as (typeof content)[number];
  out[out.length - 1] = { ...last, content };
  return out;
}

/**
 * A user message's own words and its per-generation tail, split. `tail` is
 * null when the message has none or its content does not end with it (a
 * caller rewrote the content after attaching the tail): then the whole
 * content is the message's own, which is the safe reading — at worst one
 * turn's cache entry ends after context the next turn will not repeat.
 */
export function splitVolatileTail(message: { role: string; content: string; volatileTail?: string }): {
  own: string;
  tail: string | null;
} {
  const tail = message.volatileTail;
  if (message.role !== "USER" || !tail || !message.content.endsWith(tail)) return { own: message.content, tail: null };
  return { own: message.content.slice(0, message.content.length - tail.length).replace(/\s+$/, ""), tail };
}
