import test from "node:test";
import assert from "node:assert/strict";
import {
  accumulateToolCallDeltas,
  addCompatUsage,
  emptyCompatUsage,
  finalizeToolCalls,
  foldCompatUsage,
  reasoningDetailsDelta,
  shouldRunToolRound,
  type CompatToolCall,
  type CompatToolCallDelta,
} from "@/lib/openai-compat-round";

/*
 * Thirteen providers share one adapter, and each streams these fields slightly
 * differently from the OpenAI reference. The failure modes are silent: a
 * parallel tool call that never runs, a cache write billed once per chunk.
 */

function accumulate(...batches: CompatToolCallDelta[][]): CompatToolCall[] {
  const acc = new Map<string, CompatToolCall>();
  for (const batch of batches) accumulateToolCallDeltas(acc, batch);
  return finalizeToolCalls(acc);
}

test("parallel calls with NO index are two calls, not one", () => {
  const calls = accumulate(
    [{ id: "call_a", function: { name: "search", arguments: '{"q":' } }],
    [{ id: "call_b", function: { name: "fetch", arguments: '{"url":' } }],
    [{ id: "call_a", function: { arguments: '"juno"}' } }],
    [{ id: "call_b", function: { arguments: '"https://x"}' } }],
  );
  assert.deepEqual(calls, [
    { id: "call_a", name: "search", args: '{"q":"juno"}' },
    { id: "call_b", name: "fetch", args: '{"url":"https://x"}' },
  ]);
});

test("an index that restarts at 0 per call does not merge two calls", () => {
  const calls = accumulate(
    [{ index: 0, id: "call_a", function: { name: "search", arguments: "{}" } }],
    [{ index: 0, id: "call_b", function: { name: "fetch", arguments: "{}" } }],
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ["search", "fetch"]);
});

test("the ordinary OpenAI shape still accumulates by index, in order", () => {
  const calls = accumulate(
    [
      { index: 0, id: "call_a", function: { name: "a", arguments: '{"x' } },
      { index: 1, id: "call_b", function: { name: "b", arguments: '{"y' } },
    ],
    [
      { index: 0, function: { arguments: '":1}' } },
      { index: 1, function: { arguments: '":2}' } },
    ],
  );
  assert.deepEqual(calls, [
    { id: "call_a", name: "a", args: '{"x":1}' },
    { id: "call_b", name: "b", args: '{"y":2}' },
  ]);
});

test("argument fragments with neither id nor index continue the open call", () => {
  const calls = accumulate(
    [{ id: "call_a", function: { name: "a", arguments: '{"x' } }],
    [{ function: { arguments: '":1}' } }],
  );
  assert.deepEqual(calls, [{ id: "call_a", name: "a", args: '{"x":1}' }]);
});

test("a fragment that never became a real call is not a call", () => {
  const acc = new Map<string, CompatToolCall>();
  accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: "{}" } }]);
  assert.deepEqual(finalizeToolCalls(acc), []);
  accumulateToolCallDeltas(acc, undefined);
  assert.deepEqual(finalizeToolCalls(acc), []);
});

test("having calls is the signal — finish_reason 'stop' still runs them", () => {
  // Several compat hosts report `stop` while emitting tool_calls. Gating the
  // loop on finish_reason === "tool_calls" dropped those calls and answered
  // with nothing.
  assert.equal(shouldRunToolRound({ hasTools: true, isFinalRound: false, callCount: 1, finishReason: "stop" }), true);
  assert.equal(
    shouldRunToolRound({ hasTools: true, isFinalRound: false, callCount: 1, finishReason: "tool_calls" }),
    true,
  );
  assert.equal(shouldRunToolRound({ hasTools: true, isFinalRound: false, callCount: 1 }), true);
  // Truncated arguments are worse to execute than to surface.
  assert.equal(
    shouldRunToolRound({ hasTools: true, isFinalRound: false, callCount: 1, finishReason: "length" }),
    false,
  );
  assert.equal(shouldRunToolRound({ hasTools: true, isFinalRound: true, callCount: 1, finishReason: "stop" }), false);
  assert.equal(shouldRunToolRound({ hasTools: false, isFinalRound: false, callCount: 1 }), false);
  assert.equal(shouldRunToolRound({ hasTools: true, isFinalRound: false, callCount: 0 }), false);
});

test("repeated cumulative usage is counted ONCE — writes and searches included", () => {
  // Under stream_options.include_usage many hosts repeat the whole usage object
  // on every chunk. Cache writes and server-tool counts used to be ADDED each
  // time, so the same billable event was charged once per chunk.
  const round = emptyCompatUsage();
  const chunk = {
    prompt_tokens: 1_000,
    completion_tokens: 400,
    prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 200 },
    completion_tokens_details: { reasoning_tokens: 350 },
    total_tokens: 1_400,
    server_side_tool_usage: { web_search_requests: 2, x_search_requests: 1 },
  };
  foldCompatUsage(round, chunk);
  foldCompatUsage(round, chunk);
  foldCompatUsage(round, chunk);
  assert.deepEqual(round, {
    input: 1_000,
    output: 400,
    cacheRead: 800,
    cacheWrite: 200,
    reasoning: 350,
    total: 1_400,
    webSearchRequests: 2,
    xSearchRequests: 1,
  });
});

test("a final frame that omits fields cannot erase them", () => {
  const round = emptyCompatUsage();
  foldCompatUsage(round, { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1_000 });
  foldCompatUsage(round, { completion_tokens: 120 });
  assert.equal(round.input, 900);
  assert.equal(round.output, 120);
  assert.equal(round.total, 1_000);
});

test("both reasoning spellings are read, and DeepSeek's cache hit counts as a read", () => {
  const a = emptyCompatUsage();
  foldCompatUsage(a, { reasoning_tokens: 77 });
  assert.equal(a.reasoning, 77);
  const b = emptyCompatUsage();
  foldCompatUsage(b, { prompt_cache_hit_tokens: 640 });
  assert.equal(b.cacheRead, 640);
  // A DeepSeek cache MISS is uncached input already inside prompt_tokens; it is
  // not a write, and counting it as one billed that input twice.
  const c = emptyCompatUsage();
  foldCompatUsage(c, { prompt_cache_miss_tokens: 640 });
  assert.equal(c.cacheWrite, 0);
});

test("rounds are SUMMED, because each is a separately billed request", () => {
  const total = emptyCompatUsage();
  const round = emptyCompatUsage();
  foldCompatUsage(round, { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200 });
  addCompatUsage(total, round);
  addCompatUsage(total, round);
  assert.equal(total.input, 2_000);
  assert.equal(total.output, 400);
  assert.equal(total.total, 2_400);
});

test("cumulative and delta reasoning_details both stream exactly once", () => {
  // MiniMax repeats everything so far; other hosts send only the new text.
  assert.equal(reasoningDetailsDelta("", "abc"), "abc");
  assert.equal(reasoningDetailsDelta("abc", "abcdef"), "def");
  assert.equal(reasoningDetailsDelta("abc", "def"), "def");
});
