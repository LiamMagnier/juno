import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workRunPricing } from "@/lib/metering/work-pricing";
import { MODEL_LIST, resolveModel, type ModelInfo } from "@/lib/models";
import { estimateGenerationCostUsd, longContextPricing, tokenRate, type GenerationCostOpts } from "@/lib/pricing";
import { WorkBudgetGuard, type WorkModelPricing } from "../runner/agent-core/src/work/budget";
import type { Usage } from "../runner/agent-core/src/types";

/*
 * A Work run is billed what its budget guard counted, request by request
 * (metering-findings.md, M1). Two things made that 5.6x to 22x the provider's
 * bill: the guard priced cache READS at the full input rate, and the ledger
 * then re-priced the run's CUMULATIVE tokens as one request and kept the
 * higher figure, so GPT's >272K and Haiku 5.5's >100K surcharges applied to
 * runs none of whose requests came near them. Pinned here with the repo's own
 * pricing functions: the guard equals the sum of per-request costs, and the
 * ledger bills the guard's figure.
 */

const NO_CEILING = { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 };

/** One step as the runner reports it, and the same request as a pricing receipt. */
interface Step {
  usage: Usage;
  receipt: GenerationCostOpts;
}

/** One request's runner usage and its receipt in the provider's own convention. */
function step(model: ModelInfo, input: number, read: number, written: number, output: number): Step {
  return {
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: written },
    // Anthropic's input count excludes the cache buckets; OpenAI-compatible
    // labs count them inside it (`normalizeUsage`).
    receipt:
      model.provider === "anthropic"
        ? { promptTokens: input - read - written, completionTokens: output, cacheRead: read, cacheWrite5m: written }
        : { promptTokens: input, completionTokens: output, cacheRead: read, cacheWrite: written },
  };
}

/** The findings' 40-step run: 12K context, +1.2K a step, 700 out, newest block written, the rest read. */
function fortyStepRun(model: ModelInfo): Step[] {
  return Array.from({ length: 40 }, (_, i) => {
    const context = 12_000 + 1_200 * i;
    const newest = i === 0 ? 12_000 : 1_200;
    return step(model, context, context - newest, newest, 700);
  });
}

function guardCost(pricing: WorkModelPricing, steps: readonly Step[]): number {
  const guard = new WorkBudgetGuard({ budget: NO_CEILING, pricing });
  for (const s of steps) guard.record(s.usage);
  return guard.usage.costMicroUsd;
}

const microUsd = (usd: number) => Math.round(usd * 1_000_000);
const truth = (model: ModelInfo, steps: readonly Step[]) =>
  steps.reduce((usd, s) => usd + estimateGenerationCostUsd(model, s.receipt).costUsd, 0);

const RUN_MODELS = ["anthropic:claude-sonnet-5-5", "anthropic:claude-haiku-5-5", "openai:gpt-6.1-sol"];

test("Work pricing carries the catalog's cache-read rate and long-context tier", () => {
  for (const id of RUN_MODELS) {
    const model = resolveModel(id);
    assert.ok(model, `${id} is in the catalog`);
    const pricing = workRunPricing(model, model.provider);
    assert.equal(pricing.cacheReadMicroUsdPerMillion, microUsd(tokenRate(model).cacheRead), id);
    assert.deepEqual(pricing.longContext ?? null, longContextPricing(model), id);
  }
});

test("a 40-step cached run is billed the sum of its requests, not 5x it", () => {
  for (const id of RUN_MODELS) {
    const model = resolveModel(id)!;
    const steps = fortyStepRun(model);
    const pricing = workRunPricing(model, model.provider);
    const provider = truth(model, steps);
    const guard = guardCost(pricing, steps);
    // The guard rounds once per step; nothing else separates the two.
    assert.ok(Math.abs(guard - provider * 1_000_000) <= steps.length, `${id}: guard ${guard} vs per-request ${provider * 1e6}`);

    // What the ledger charged before: a guard with no read rate and no
    // per-request tier, maxed against the cumulative tokens priced as one.
    const before = Math.max(
      guardCost({ ...pricing, cacheReadMicroUsdPerMillion: undefined, longContext: undefined }, steps),
      microUsd(
        estimateGenerationCostUsd(model, {
          promptTokens: steps.reduce((n, s) => n + s.usage.inputTokens, 0),
          completionTokens: steps.reduce((n, s) => n + s.usage.outputTokens, 0),
        }).costUsd
      )
    );
    assert.ok(before > 5 * guard, `${id}: before ${before} was more than 5x the per-request ${guard}`);
  }
});

test("an uncatalogued model is never billed below any model of its lab, at any request size", () => {
  // Small and fresh, cached under every threshold, and cached past all of them.
  const shapes: Array<[number, number, number, number]> = [
    [50_000, 0, 0, 2_000],
    [150_000, 140_000, 5_000, 2_000],
    [300_000, 280_000, 10_000, 2_000],
  ];
  for (const provider of ["anthropic", "openai", "no-such-lab"]) {
    const pricing = workRunPricing(null, provider);
    const lab = MODEL_LIST.filter((m) => m.modality === "chat" && (provider === "no-such-lab" || m.provider === provider));
    for (const model of lab) {
      for (const [input, read, written, output] of shapes) {
        const s = step(model, input, read, written, output);
        const billed = guardCost(pricing, [s]);
        const real = microUsd(estimateGenerationCostUsd(model, s.receipt).costUsd);
        assert.ok(billed + 1 >= real, `${provider} fallback ${billed} under ${model.id} ${real} at ${input}`);
      }
    }
  }
});

test("the Work ledger bills the guard's per-request cost, not a cumulative recompute", () => {
  const spend = readFileSync("src/lib/spend.ts", "utf8");
  const work = spend.slice(spend.indexOf("export async function recordWorkRunSpend"));
  assert.match(work.slice(0, work.indexOf("\n}\n")), /preReconciled: true/);
});

// The ledger boundary itself, with Prisma faked. Run with
// --experimental-test-module-mocks and --conditions=react-server.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const boundaryTest = canMockModules ? test : test.skip;
type Row = { userId: string; model: string; kind: string; promptTokens: number; completionTokens: number; costMicroUsd: number; idempotencyKey?: string };
const rows: Row[] = [];
if (canMockModules) {
  const sum = (field: "costMicroUsd" | "promptTokens" | "completionTokens", where: { idempotencyKey?: { startsWith: string } }) =>
    rows.filter((row) => row.idempotencyKey?.startsWith(where.idempotencyKey?.startsWith ?? "")).reduce((n, row) => n + row[field], 0);
  const unavailable = () => Promise.reject(new Error("not faked"));
  mock.module("@/lib/prisma", {
    namedExports: {
      prisma: {
        apiSpend: {
          async create({ data }: { data: Row }) {
            rows.push(data);
            return data;
          },
          async aggregate({ where }: { where: { idempotencyKey?: { startsWith: string } } }) {
            return {
              _sum: {
                costMicroUsd: sum("costMicroUsd", where),
                promptTokens: sum("promptTokens", where),
                completionTokens: sum("completionTokens", where),
              },
            };
          },
        },
        // The spend-period commit is best-effort and logs its own failure.
        $queryRaw: unavailable,
        $transaction: unavailable,
        spendPeriod: { findUnique: unavailable, upsert: unavailable, findFirst: unavailable, create: unavailable },
        user: { findUnique: unavailable },
        subscription: { findFirst: unavailable, findUnique: unavailable },
      },
    },
  });
}

boundaryTest("a parked and resumed Sonnet run lands on the ledger at the guard's figure", async () => {
  rows.length = 0;
  const { recordWorkRunSpend } = await import("@/lib/spend");
  const model = resolveModel("anthropic:claude-sonnet-5-5")!;
  const steps = fortyStepRun(model);
  const guard = new WorkBudgetGuard({ budget: NO_CEILING, pricing: workRunPricing(model, model.provider) });
  for (const s of steps.slice(0, 20)) guard.record(s.usage);
  const parked = guard.usage;
  await recordWorkRunSpend({ userId: "u1", runId: "r1", model: model.id, cumulativeCostMicroUsd: parked.costMicroUsd, inputTokens: parked.inputTokens, outputTokens: parked.outputTokens });
  for (const s of steps.slice(20)) guard.record(s.usage);
  const finished = guard.usage;
  await recordWorkRunSpend({ userId: "u1", runId: "r1", model: model.id, cumulativeCostMicroUsd: finished.costMicroUsd, inputTokens: finished.inputTokens, outputTokens: finished.outputTokens, terminal: true });

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.costMicroUsd, parked.costMicroUsd);
  assert.equal(rows.reduce((n, row) => n + row.costMicroUsd, 0), finished.costMicroUsd);
  // The token counts still add up to the run's, so the next delta is right.
  assert.equal(rows.reduce((n, row) => n + row.promptTokens, 0), finished.inputTokens);
  assert.equal(rows.reduce((n, row) => n + row.completionTokens, 0), finished.outputTokens);
  assert.ok(Math.abs(finished.costMicroUsd - truth(model, steps) * 1_000_000) <= steps.length);
});
