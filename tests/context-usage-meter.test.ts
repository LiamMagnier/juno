import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contextSplit } from "@/components/chat/context-usage-meter";

const usage = (inputTokens: number, cachedTokens: number | null, windowTokens: number) =>
  ({ key: "context_usage", inputTokens, cachedTokens, windowTokens }) as const;

test("the window splits into cache hits, fresh input and what remains", () => {
  const split = contextSplit(usage(12_000, 9_000, 200_000));
  assert.deepEqual(
    { cached: split.cached, fresh: split.fresh, remaining: split.remaining, window: split.window, cacheReported: split.cacheReported },
    { cached: 9_000, fresh: 3_000, remaining: 188_000, window: 200_000, cacheReported: true },
  );
  assert.equal(split.used, 0.06);
});

test("a provider that reports no cache hits draws all input as fresh, and says so", () => {
  const split = contextSplit(usage(5_000, null, 128_000));
  assert.equal(split.cacheReported, false);
  assert.equal(split.cached, 0);
  assert.equal(split.fresh, 5_000);
});

test("counts are clamped: cache never exceeds input, input never exceeds the window", () => {
  const over = contextSplit(usage(300_000, 400_000, 200_000));
  assert.equal(over.cached, 200_000);
  assert.equal(over.fresh, 0);
  assert.equal(over.remaining, 0);
  assert.equal(over.used, 1);
});

test("fresh input and cache hits each have their own colour, label and exact count", () => {
  const meter = readFileSync("src/components/chat/context-usage-meter.tsx", "utf8");
  const tokens = readFileSync("src/components/ui/signature.css", "utf8");
  assert.match(tokens, /--ctx-fresh:/);
  assert.match(tokens, /--ctx-cache:/);
  assert.match(meter, /"Cache hits", exact\(split\.cached\)/);
  assert.match(meter, /"Fresh input"/);
  assert.match(meter, /"Remaining", exact\(split\.remaining\)/);
  assert.match(meter, /does not report cache hits/);
});
