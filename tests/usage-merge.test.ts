import test from "node:test";
import assert from "node:assert/strict";
import { mergeUsage, totalInputTokens } from "@/lib/usage-merge";

test("mergeUsage never lets a partial zero wipe a real input total", () => {
  let acc = mergeUsage({}, { input: 12_400, cacheWrite: 8_000, output: 1 });
  acc = mergeUsage(acc, { output: 180 }); // typical message_delta: output only
  assert.equal(acc.input, 12_400);
  assert.equal(acc.cacheWrite, 8_000);
  assert.equal(acc.output, 180);
});

test("mergeUsage takes the max of cumulative token fields", () => {
  let acc = mergeUsage({}, { input: 100, output: 10 });
  acc = mergeUsage(acc, { input: 5_000, output: 200, cacheRead: 9_000 });
  assert.equal(acc.input, 5_000);
  assert.equal(acc.output, 200);
  assert.equal(acc.cacheRead, 9_000);
});

test("mergeUsage ignores null/undefined without clearing", () => {
  let acc = mergeUsage({}, { input: 50, webSearchRequests: 3 });
  acc = mergeUsage(acc, { output: 20 });
  assert.equal(acc.input, 50);
  assert.equal(acc.webSearchRequests, 3);
  assert.equal(acc.output, 20);
});

test("totalInputTokens sums fresh + cache", () => {
  assert.equal(
    totalInputTokens({ input: 100, cacheRead: 900, cacheWrite1h: 200 }),
    1_200
  );
  assert.equal(totalInputTokens({ input: 100, cacheWrite: 50 }), 150);
});
