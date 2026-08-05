import test from "node:test";
import assert from "node:assert/strict";
import { buildUsage } from "@/lib/chat-usage";
import type { ModelInfo } from "@/lib/models";

/*
 * buildUsage produces the per-message cost receipt. It lived inside the
 * 2,600-line chat route, which no test can import (it pulls in Prisma and the
 * Next server runtime), so the money arithmetic had no coverage at all.
 */

const model = {
  id: "anthropic:claude-sonnet-5",
  provider: "anthropic",
  providerModel: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  family: "sonnet",
  status: "current",
  minPlan: "FREE",
  cost: 2,
  reasoning: true,
  vision: true,
  modality: "chat",
  webSearch: false,
  contextWindow: 1_000_000,
  description: "test",
} as ModelInfo;

test("reported token counts drive the cost", () => {
  const usage = buildUsage(model, { input: 10_000, output: 1_000 });
  assert.ok(usage.cost > 0);
  assert.equal(usage.output, 1_000);
  assert.equal(usage.totalInput, 10_000);
  assert.equal(usage.costMicroUsd, Math.round(usage.cost * 1_000_000));
});

test("cache reads and writes count towards displayed input", () => {
  const usage = buildUsage(model, { input: 1_000, output: 10, cacheRead: 5_000, cacheWrite: 2_000 });
  assert.equal(usage.totalInput, 8_000);
  assert.equal(usage.cacheRead, 5_000);
  assert.equal(usage.cacheWrite, 2_000);
  assert.match(usage.detail, /8,000 input \(7,000 cached\)/);
});

test("split 5m/1h cache writes win over the flat figure", () => {
  const usage = buildUsage(model, {
    input: 1_000,
    output: 10,
    cacheWrite: 999_999,
    cacheWrite5m: 300,
    cacheWrite1h: 700,
  });
  assert.equal(usage.cacheWrite, 1_000, "the split values are authoritative when present");
});

test("negative and missing counts are floored at zero, not propagated", () => {
  const usage = buildUsage(model, { input: -5, output: -5, reasoning: -1, cacheRead: -100 });
  assert.ok(usage.totalInput >= 0);
  assert.equal(usage.reasoning, 0);
  assert.equal(usage.cacheRead, 0);
  assert.ok(usage.cost >= 0);
});

/*
 * The regression this file exists for.
 *
 * pricing.ts floors the completion estimate on character count when a provider
 * under-reports usage (`charOut > completion` wins). On a canvas edit the chat
 * route REPLACES the assistant text with the whole rebuilt artifact — so
 * passing that text's length here billed the user for the entire artifact
 * instead of the patch the model actually emitted. recordSpend already used the
 * model's real output length; the receipt and the ledger disagreed.
 */
test("completionChars floors the cost when the provider under-reports", () => {
  const patchLength = 200;
  const rebuiltArtifactLength = 50_000;

  const honest = buildUsage(model, { input: 1_000, output: 0, completionChars: patchLength });
  const inflated = buildUsage(model, { input: 1_000, output: 0, completionChars: rebuiltArtifactLength });

  assert.ok(
    inflated.cost > honest.cost,
    "a larger completionChars must produce a larger cost — this is the floor that made the bug matter"
  );
  assert.ok(
    inflated.output > honest.output,
    "the floor also inflates the reported output token count"
  );
});

test("the character floor cannot lower a well-reported cost", () => {
  const reported = buildUsage(model, { input: 1_000, output: 5_000 });
  const withTinyChars = buildUsage(model, { input: 1_000, output: 5_000, completionChars: 1 });
  assert.equal(
    withTinyChars.output,
    reported.output,
    "a small char count must not reduce a figure the provider actually reported"
  );
});

test("the detail line omits sections that have no value", () => {
  const bare = buildUsage(model, {});
  assert.doesNotMatch(bare.detail, /cached/);
  assert.doesNotMatch(bare.detail, /search/);

  const searched = buildUsage(model, { input: 100, output: 10, webSearchRequests: 1 });
  assert.match(searched.detail, /1 search\b/, "singular");
  const searchedMore = buildUsage(model, { input: 100, output: 10, webSearchRequests: 2, xSearchRequests: 1 });
  assert.match(searchedMore.detail, /3 searches/, "plural, and both search kinds sum");
});
