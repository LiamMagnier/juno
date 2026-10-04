import test from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { isVolatileBlock, markConversationCacheBreakpoint, volatileTextBlock } from "@/lib/anthropic-cache";

type Block = { type: string; cache_control?: unknown };

function markers(messages: Anthropic.MessageParam[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  messages.forEach((message, i) => {
    if (typeof message.content === "string") return;
    (message.content as Block[]).forEach((block, j) => {
      if (block.cache_control) out.push([i, j]);
    });
  });
  return out;
}

test("a plain history gets one marker on the newest user message", () => {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "next" },
  ];
  markConversationCacheBreakpoint(messages);
  assert.deepEqual(markers(messages), [[2, 0]]);
});

test("the marker MOVES to the newest tool result on every round of a tool loop", () => {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "look this up" }];
  markConversationCacheBreakpoint(messages);
  assert.deepEqual(markers(messages), [[0, 0]]);

  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: {} }] });
  messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result one" }] });
  markConversationCacheBreakpoint(messages);
  // Exactly one conversation marker, on the newest block: round 2 reads round 1's prefix.
  assert.deepEqual(markers(messages), [[2, 0]]);

  messages.push({ role: "assistant", content: [{ type: "tool_use", id: "t2", name: "search", input: {} }] });
  messages.push({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t2", content: "a" },
      { type: "tool_result", tool_use_id: "t3", content: "b" },
    ],
  });
  markConversationCacheBreakpoint(messages);
  assert.deepEqual(markers(messages), [[4, 1]]);
});

test("the marker stays in front of a volatile per-turn context block", () => {
  const tail = volatileTextBlock("# Context for this message\nretrieved passage");
  assert.ok(isVolatileBlock(tail));
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "earlier" },
    { role: "assistant", content: "answer" },
    { role: "user", content: [{ type: "text", text: "my question" }, tail] },
  ];
  markConversationCacheBreakpoint(messages);
  assert.deepEqual(markers(messages), [[2, 0]]);
  assert.equal((tail as Block).cache_control, undefined);
});

test("an assistant continuation (pause_turn) keeps the previous marker", () => {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "search the web" }];
  markConversationCacheBreakpoint(messages);
  messages.push({ role: "assistant", content: [{ type: "text", text: "partial" }] });
  markConversationCacheBreakpoint(messages);
  assert.deepEqual(markers(messages), [[0, 0]]);
});

test("a message that is only volatile context gets no marker rather than a useless one", () => {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: [volatileTextBlock("context")] }];
  markConversationCacheBreakpoint(messages);
  assert.deepEqual(markers(messages), []);
});

test("withConversationCacheBreakpoint marks a copy and leaves the loop's history unmarked", async () => {
  const { withConversationCacheBreakpoint } = await import("@/lib/anthropic-cache");
  const tail = volatileTextBlock("ctx");
  const history: Anthropic.MessageParam[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: [{ type: "text", text: "q" }, tail] },
  ];
  const sent = withConversationCacheBreakpoint(history);
  assert.deepEqual(markers(sent), [[2, 0]]);
  assert.deepEqual(markers(history), []);
  // The volatile block itself is shared, never marked.
  assert.equal((sent[2].content as unknown[])[1], tail);
});

test("splitVolatileTail separates the user's words from this generation's context", async () => {
  const { splitVolatileTail } = await import("@/lib/anthropic-cache");
  const tail = "# Context for this message\npassage";
  assert.deepEqual(splitVolatileTail({ role: "USER", content: `hello\n\n${tail}`, volatileTail: tail }), { own: "hello", tail });
  // Content rewritten after the tail was attached: everything is the user's own.
  assert.deepEqual(splitVolatileTail({ role: "USER", content: "rewritten", volatileTail: tail }), { own: "rewritten", tail: null });
  assert.deepEqual(splitVolatileTail({ role: "ASSISTANT", content: `x${tail}`, volatileTail: tail }), { own: `x${tail}`, tail: null });
});
