import test from "node:test";
import assert from "node:assert/strict";
import { createStreamBudgetGuard } from "@/lib/chat-budget-guard";

/*
 * The mid-stream ceiling: the point of it is that a user cannot be billed a
 * cent past their remaining plan budget. It ran twice in the chat route,
 * byte-identical, with no coverage at all — a duplicated money path.
 */

const rates = { input: 1, output: 10 }; // micro-USD per token

function guard(over: Partial<Parameters<typeof createStreamBudgetGuard>[0]> = {}) {
  const halts: number[] = [];
  const g = createStreamBudgetGuard({
    ceilingMicroUsd: 1_000,
    rates,
    inputChars: 0,
    usage: () => ({ promptTokens: 0, completionTokens: 0, outputChars: 0, reasoningChars: 0 }),
    onHalt: () => halts.push(1),
    ...over,
  });
  return { g, halts };
}

test("does nothing while the projected cost is under the ceiling", () => {
  const { g, halts } = guard({
    usage: () => ({ promptTokens: 100, completionTokens: 10, outputChars: 0, reasoningChars: 0 }),
  });
  g.enforce(); // 100*1 + 10*10 = 200, under 1000
  assert.equal(halts.length, 0);
  assert.equal(g.halted, false);
});

test("halts the moment the projection reaches the ceiling", () => {
  const { g, halts } = guard({
    usage: () => ({ promptTokens: 500, completionTokens: 50, outputChars: 0, reasoningChars: 0 }),
  });
  g.enforce(); // 500 + 500 = 1000, exactly at the ceiling
  assert.equal(halts.length, 1);
  assert.equal(g.halted, true);
});

test("halts once, not once per event", () => {
  // enforce() is called on every streamed chunk. Without the latch the abort
  // would be re-issued and the "usage limit" warning re-sent dozens of times.
  const { g, halts } = guard({
    usage: () => ({ promptTokens: 10_000, completionTokens: 0, outputChars: 0, reasoningChars: 0 }),
  });
  for (let i = 0; i < 25; i++) g.enforce();
  assert.equal(halts.length, 1);
});

test("an unlimited plan never halts", () => {
  const { g, halts } = guard({
    ceilingMicroUsd: null,
    usage: () => ({ promptTokens: 10 ** 9, completionTokens: 10 ** 9, outputChars: 0, reasoningChars: 0 }),
  });
  g.enforce();
  assert.equal(halts.length, 0);
  assert.equal(g.halted, false);
});

test("falls back to characters before the provider reports tokens", () => {
  // Providers report usage late or not at all. Until they do, the estimate has
  // to come from the text — otherwise the ceiling is unenforced for most of the
  // stream, which is precisely when it matters.
  const { g, halts } = guard({
    ceilingMicroUsd: 1_000,
    inputChars: 4_000, // -> 1000 input tokens -> 1000 µUSD on its own
    usage: () => ({
      promptTokens: undefined,
      completionTokens: undefined,
      outputChars: 0,
      reasoningChars: 0,
    }),
  });
  g.enforce();
  assert.equal(halts.length, 1);
});

test("reasoning characters count toward the ceiling", () => {
  // Thinking tokens are billed. A guard that ignored them would let a
  // reasoning-heavy turn run well past the budget while looking cheap.
  const visibleOnly = guard({
    ceilingMicroUsd: 1_000,
    usage: () => ({ promptTokens: 0, completionTokens: undefined, outputChars: 40, reasoningChars: 0 }),
  });
  visibleOnly.g.enforce();
  assert.equal(visibleOnly.halts.length, 0);

  const withReasoning = guard({
    ceilingMicroUsd: 1_000,
    usage: () => ({ promptTokens: 0, completionTokens: undefined, outputChars: 40, reasoningChars: 400 }),
  });
  withReasoning.g.enforce();
  assert.equal(withReasoning.halts.length, 1, "reasoning must be billed against the ceiling");
});

test("reported tokens win over the character estimate", () => {
  const { g, halts } = guard({
    ceilingMicroUsd: 1_000,
    inputChars: 4_000_000, // would blow the ceiling on its own
    usage: () => ({ promptTokens: 1, completionTokens: 1, outputChars: 0, reasoningChars: 0 }),
  });
  g.enforce();
  assert.equal(halts.length, 0, "a real token count must not be second-guessed by the char floor");
});

test("usage is re-read on every check, not captured once", () => {
  let completion = 0;
  const { g, halts } = guard({
    ceilingMicroUsd: 1_000,
    usage: () => ({ promptTokens: 0, completionTokens: completion, outputChars: 0, reasoningChars: 0 }),
  });
  g.enforce();
  assert.equal(halts.length, 0);
  completion = 100; // 100 * 10 = 1000
  g.enforce();
  assert.equal(halts.length, 1, "the guard must see counts that grew since the last check");
});

test("cached prompt tokens are priced at the cache-read rate, not the input rate", () => {
  // 900 of 1,000 prompt tokens came from the provider's cache. At the full
  // input rate that is 1,000 + 0 = 1,000 and halts; at the cache rate it is
  // 100 + 900 × 0.1 = 190 and runs. A guard that cannot tell the two apart
  // halts turns the plan could afford, on exactly the long chats caching
  // exists for.
  const { g, halts } = guard({
    rates: { input: 1, output: 10, cacheRead: 0.1 },
    usage: () => ({ promptTokens: 1_000, completionTokens: 0, cacheReadTokens: 900, outputChars: 0, reasoningChars: 0 }),
  });
  g.enforce();
  assert.equal(halts.length, 0);
});

test("Anthropic reports cached reads OUTSIDE the prompt count, and they are still billed", () => {
  // 50 fresh tokens and 40,000 cached ones. Subtracting the cached count from
  // the fresh one (the OpenAI convention) would price this turn at ~5 —
  // effectively free — when it really costs 50 + 4,000 = 4,050 at a cache
  // rate of 0.1. The exclusive flag keeps the fresh count whole.
  const { g, halts } = guard({
    ceilingMicroUsd: 4_000,
    rates: { input: 1, output: 10, cacheRead: 0.1 },
    usage: () => ({
      promptTokens: 50,
      completionTokens: 0,
      cacheReadTokens: 40_000,
      promptTokensIncludeCacheRead: false,
      outputChars: 0,
      reasoningChars: 0,
    }),
  });
  g.enforce(); // 50 + 4,000 = 4,050 ≥ 4,000
  assert.equal(halts.length, 1);
});

test("a cached count larger than the prompt count cannot make a turn look free", () => {
  // OpenAI reports cached tokens INSIDE the prompt count and Anthropic outside
  // it; the guard only needs an upper bound, so the cached share is capped at
  // the prompt count rather than driving the projection negative.
  const { g, halts } = guard({
    rates: { input: 1, output: 10, cacheRead: 0.1 },
    usage: () => ({ promptTokens: 1_000, completionTokens: 100, cacheReadTokens: 5_000, outputChars: 0, reasoningChars: 0 }),
  });
  g.enforce(); // 1,000 × 0.1 + 100 × 10 = 1,100 ≥ 1,000
  assert.equal(halts.length, 1);
});

test("without a cache rate every prompt token is priced at the input rate", () => {
  const { g, halts } = guard({
    usage: () => ({ promptTokens: 1_000, completionTokens: 0, cacheReadTokens: 900, outputChars: 0, reasoningChars: 0 }),
  });
  g.enforce(); // 1,000 × 1 = 1,000, at the ceiling
  assert.equal(halts.length, 1);
});
