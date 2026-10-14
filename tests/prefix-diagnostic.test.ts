import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { volatileTextBlock } from "@/lib/anthropic-cache";
import { comparePrefix, createPrefixTracker, hashCacheKey, snapshotPrefix, verdictLabel } from "@/lib/llm/prefix-diagnostic";
import { usageDelta, withFirstToken } from "@/lib/llm/request-meter";
import { costPerAcceptedResult } from "@/lib/metering/cost-per-accepted";
import { aggregateOutcomes } from "@/lib/router/evidence";

test("the diagnostic modules stay free of server-only", () => {
  for (const file of ["src/lib/llm/prefix-diagnostic.ts", "src/lib/llm/request-meter.ts", "src/lib/metering/cost-per-accepted.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /^import "server-only";/m, file);
  }
});

const body = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  model: "claude-sonnet-5-5",
  tools: [{ name: "lookup", input_schema: { type: "object" } }],
  system: [{ type: "text", text: "rules", cache_control: { type: "ephemeral", ttl: "1h" } }],
  messages,
  ...extra,
});

test("a moved marker, a string-vs-block message and a volatile tail are not prefix changes", () => {
  const a = snapshotPrefix("anthropic", body([{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }, volatileTextBlock("ctx")] }]));
  const b = snapshotPrefix(
    "anthropic",
    body([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: [{ type: "text", text: "more", cache_control: { type: "ephemeral" } }] },
    ])
  );
  assert.deepEqual(comparePrefix(a, b), { status: "stable" });
});

test("the first divergence in render order is the one reported", () => {
  const base = snapshotPrefix("anthropic", body([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]));
  const rewritten = snapshotPrefix("anthropic", body([{ role: "user", content: "a" }, { role: "assistant", content: "B" }, { role: "user", content: "c" }]));
  assert.equal(verdictLabel(comparePrefix(base, rewritten)), "history_rewritten@1");
  const toolsChanged = snapshotPrefix("anthropic", body([{ role: "user", content: "a" }], { tools: [{ input_schema: { type: "object" }, name: "lookup" }] }));
  assert.equal(verdictLabel(comparePrefix(base, toolsChanged)), "tools", "key order is a wire change");
  const thinking = snapshotPrefix("anthropic", body([{ role: "user", content: "a" }], { output_config: { effort: "high" } }));
  assert.equal(verdictLabel(comparePrefix(base, thinking)), "settings");
  const truncated = snapshotPrefix("anthropic", body([{ role: "user", content: "a" }]));
  assert.equal(verdictLabel(comparePrefix(base, truncated)), "history_truncated@1");
});

test("a per-request item is ignored only while it trails the history", () => {
  const date = { role: "system", content: "Today" };
  const trailing = snapshotPrefix("compat", { model: "m", messages: [{ role: "user", content: "a" }, date] }, new Set([date]));
  assert.equal(trailing.messages.length, 1);
  const date2 = { role: "system", content: "Today" };
  const spliced = snapshotPrefix("compat", { model: "m", messages: [date2, { role: "user", content: "a" }] }, new Set([date2]));
  assert.equal(spliced.messages.length, 2, "in the middle it is part of the prefix");
});

test("the tracker compares with recent requests of the same key, keeps hashes only, and expires them", () => {
  let now = 0;
  const tracker = createPrefixTracker({ ttlMs: 1000, now: () => now });
  const s1 = snapshotPrefix("compat", { model: "m", messages: [{ role: "user", content: "a" }] });
  const s2 = snapshotPrefix("compat", { model: "m", messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
  assert.equal(tracker.observe("conv", s1).status, "first");
  assert.equal(tracker.observe("conv", s2).status, "stable");
  assert.equal(tracker.observe("other", s2).status, "first", "keys do not share entries");
  assert.equal(tracker.observe(undefined, s2).status, "first");
  now = 5000;
  assert.equal(tracker.observe("conv", s2).status, "first", "older than the TTL: nothing to read");
  assert.equal(hashCacheKey("conv").length, 16);
  assert.doesNotMatch(JSON.stringify(s2), /"a"|"b"/);
});

test("usageDelta keeps only what one request added; withFirstToken passes the return value through", async () => {
  assert.deepEqual(usageDelta({ input: 10, output: 5 }, { input: 25, output: 5, cacheRead: 3 }), { input: 15, cacheRead: 3 });
  let first = 0;
  async function* inner(): AsyncGenerator<{ type: string }, number> {
    yield { type: "usage" };
    yield { type: "text" };
    yield { type: "text" };
    return 7;
  }
  const request = { firstToken: () => void (first += 1), end: () => null };
  const gen = withFirstToken(inner(), request);
  let step = await gen.next();
  const seen: string[] = [];
  while (!step.done) {
    seen.push(step.value.type);
    step = await gen.next();
  }
  assert.equal(step.value, 7);
  assert.deepEqual(seen, ["usage", "text", "text"]);
  assert.equal(first, 2, "called per token; the meter keeps the first");
});

test("cost per accepted result divides everything spent on a task class by the answers kept", () => {
  const row = (modelId: string, over: Partial<Parameters<typeof aggregateOutcomes>[0][number]>) => ({
    modelId,
    taskClass: "coding" as const,
    completionState: "completed",
    userRegenerated: false,
    userSwitchedModel: false,
    userEdited: false,
    feedback: null,
    toolRounds: 0,
    retryCount: 0,
    latencyMs: 100,
    costMicroUsd: 1000,
    ...over,
  });
  const cells = aggregateOutcomes([
    row("cheap", { userRegenerated: true }),
    row("cheap", { feedback: "DOWN" }),
    row("cheap", {}),
    row("strong", { costMicroUsd: 2500 }),
    row("strong", { costMicroUsd: null }),
  ]).values();
  const rows = costPerAcceptedResult(cells);
  assert.deepEqual(rows.map((r) => [r.modelId, r.turns, r.accepted]), [[null, 5, 3], ["cheap", 3, 1], ["strong", 2, 2]]);
  const [all, cheap, strong] = rows;
  // cheap: $0.003 spent for one kept answer; strong: $0.0025 over 1 of 2 costed turns → $0.005 for 2.
  assert.equal(cheap.costPerAcceptedUsd, 0.003);
  assert.equal(strong.costCoverage, 0.5);
  assert.equal(strong.costPerAcceptedUsd, 0.0025);
  assert.ok(Math.abs((all.totalCostUsd ?? 0) - (0.0055 * 5) / 4) < 1e-12);
  assert.deepEqual(costPerAcceptedResult(aggregateOutcomes([row("x", { completionState: "failed" })]).values())[0].costPerAcceptedUsd, null);
});
