import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { RunWorkerInput, WorkerTools } from "@/lib/research/agents/protocol";
import { runWorkerLoop, type Adapter, type Turn } from "@/lib/research/agents/worker-loop";
import { MODEL_LIST } from "@/lib/models";
import { estimateGenerationCostUsd } from "@/lib/pricing";
import { estimateTurnCostUsd } from "@/lib/turn-pricing";

/*
 * A research worker makes 26 to 81 model calls. Each is priced by the
 * provider on its own ("Each request is priced on its own"), so a long-context
 * surcharge applies only to a single request whose own prompt crosses the
 * threshold. Pricing the loop's cumulative tokens as ONE request applied
 * Haiku 5.5's >100K rate (5x) to every token of every call
 * (docs/handoff/2026-10-31/cost/metering-findings.md, M2).
 */

const step = (input: number, output: number, read: number, write5m: number, done = false): Turn => ({
  calls: [done ? { id: "d", name: "done", args: { summary: "found it" } } : { id: "s", name: "search", args: { query: "q" } }],
  text: "",
  inputTokens: input,
  outputTokens: output,
  cache: { read, write: 0, write5m, write1h: 0 },
});

function adapterFor(turns: Turn[]): Adapter {
  let at = 0;
  return {
    async next() {
      return turns[Math.min(at++, turns.length - 1)]!;
    },
    pushToolResults() {},
    elideOldResults() {},
  };
}

const tools: WorkerTools = {
  async search() {
    return { result: { hits: [] } };
  },
  async openPage(url) {
    return { result: { ok: true, sourceId: "s", url, title: "", summary: "", chunkCount: 0, chunks: [], alreadyRead: false } };
  },
  async findInPage() {
    return { result: { ok: true, matches: [] } };
  },
  async noteFinding() {
    return { result: { ok: true } };
  },
};

const input: RunWorkerInput = {
  userId: "user_1",
  brief: {
    delegation: { workerId: "w1-1", objectiveId: "o", objective: "o", whatToFind: "", boundaries: "" },
    round: 1,
    goal: "g",
    brief: "",
    constraints: [],
    visited: [],
  },
  tools,
  limits: { maxToolCalls: 40, wallClockMs: 5_000 },
};

test("every model call reaches the worker's outcome as its own request", async () => {
  const outcome = await runWorkerLoop(input, adapterFor([step(1000, 50, 800, 100), step(1500, 60, 1200, 200, true)]), { label: "t" });
  assert.deepEqual(outcome.requests, [
    { promptTokens: 1000, completionTokens: 50, cacheRead: 800, cacheWrite: 0, cacheWrite5m: 100, cacheWrite1h: 0 },
    { promptTokens: 1500, completionTokens: 60, cacheRead: 1200, cacheWrite: 0, cacheWrite5m: 200, cacheWrite1h: 0 },
  ]);
});

test("a 24-call Haiku 5.5 worker is priced per request, not as one long-context request", async () => {
  const haiku = MODEL_LIST.find((m) => m.id === "anthropic:claude-haiku-5-5");
  assert.ok(haiku, "anthropic:claude-haiku-5-5 is in the catalog");
  // 24 calls of ~20K tokens each: no call crosses 100K, the sum (480K) does.
  const turns = Array.from({ length: 24 }, (_, i) => step(20_000, 400, 17_000, 600, i === 23));
  const outcome = await runWorkerLoop(input, adapterFor(turns), { label: haiku.id });
  const total = {
    promptTokens: outcome.inputTokens,
    completionTokens: outcome.outputTokens,
    cacheRead: outcome.cache.read,
    cacheWrite5m: outcome.cache.write5m,
  };
  const perRequest = estimateTurnCostUsd(haiku, total, outcome.requests).costUsd;
  const sumOfCalls = outcome.requests.reduce((usd, r) => usd + estimateGenerationCostUsd(haiku, r).costUsd, 0);
  const asOneRequest = estimateGenerationCostUsd(haiku, total).costUsd;

  assert.ok(Math.abs(perRequest - sumOfCalls) < 1e-9, `per-request ${perRequest} equals the sum of the calls ${sumOfCalls}`);
  assert.ok(asOneRequest > perRequest * 4.5, `one-request pricing (${asOneRequest}) carried the 5x surcharge over ${perRequest}`);
});

test("the worker bills its requests one by one", () => {
  const worker = readFileSync("src/lib/research/agents/worker.ts", "utf8");
  assert.match(worker, /estimateTurnCostUsd\(model, [^)]*loop\.requests\)/);
  assert.match(worker, /requestUsages: loop\.requests/);
});
