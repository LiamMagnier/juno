import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { toolFeesUsd } from "@/lib/pricing";
import {
  GEMINI_FREE_GROUNDING_QUERIES_PER_MONTH,
  JUNO_TOOL_MODEL_PREFIX,
  RUN_CODE_MICRO_USD_PER_SECOND,
  TOOL_USAGE_COPY,
  ToolFeeAccumulator,
  countsAsReply,
  createGroundingQuotaReader,
  enginePriceMicroUsd,
  groundingSpendFields,
  isJunoToolSpendModel,
  recordToolFees,
  runCodeFeeMicroUsd,
  splitGroundingQueries,
  startOfMonthUtc,
  toolFeeSpendRows,
  usageModelLabel,
  type ToolFeeSpendRow,
} from "@/lib/tools/metering";

/*
 * Juno's own tool fees (SPEC §3.9): third-party money spent on the user's
 * behalf, billed as its own `kind: "chat"`, `model: "juno-tool:<id>"` ledger
 * rows, written even when the turn fails, and kept out of the reply counts.
 */

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

test("metering keeps server-only out of its static graph", () => {
  assert.doesNotMatch(read("src/lib/tools/metering.ts"), /^import (?!type ).*$/m);
});

test("engine prices are the list prices, Exa with its highlights", () => {
  assert.equal(enginePriceMicroUsd("tavily", 5), 8_000);
  assert.equal(enginePriceMicroUsd("serper", 5), 1_000);
  assert.equal(enginePriceMicroUsd("serper", 10), 1_000);
  assert.equal(enginePriceMicroUsd("serper", 11), 2_000);
  assert.equal(enginePriceMicroUsd("brave", 8), 5_000);
  // $7/1k requests, $1/1k results beyond ten, $1/1k highlights (one per result).
  assert.equal(enginePriceMicroUsd("exa", 5), 7_000 + 5_000);
  assert.equal(enginePriceMicroUsd("exa", 12), 7_000 + 2_000 + 12_000);
  assert.equal(enginePriceMicroUsd("exa", 0), 7_000);
});

test("run_code is billed at 46 µUSD per sandbox second, at least one second", () => {
  assert.equal(RUN_CODE_MICRO_USD_PER_SECOND, 46);
  assert.equal(runCodeFeeMicroUsd(200), 46, "a sub-second run is a second");
  assert.equal(runCodeFeeMicroUsd(1_000), 46);
  assert.equal(runCodeFeeMicroUsd(30_000), 1_380);
  assert.equal(runCodeFeeMicroUsd(Number.NaN), 46);
  assert.equal(runCodeFeeMicroUsd(2_000, 100), 200);
});

test("the accumulator sums per tool, skips free calls, and totals for the budget guard", () => {
  const fees = new ToolFeeAccumulator();
  fees.add("web_search", 8_000);
  fees.add("web_search", 1_000);
  fees.add("run_code", 1_380);
  fees.add("web_fetch", 0);
  fees.add("calculate", -5);
  fees.add("web_search", Number.NaN);
  assert.equal(fees.total(), 10_380);
  assert.deepEqual(fees.rows(), [
    { tool: "web_search", microUsd: 9_000, calls: 2 },
    { tool: "run_code", microUsd: 1_380, calls: 1 },
  ]);
});

test("fee rows are kind chat, model juno-tool:<id>, costed in dollars, never as toolFeesUsd", () => {
  const fees = new ToolFeeAccumulator();
  fees.add("web_search", 12_000);
  fees.add("run_code", 460);
  const rows = toolFeeSpendRows(fees, { userId: "u1", source: "app" });
  assert.deepEqual(rows, [
    { userId: "u1", model: "juno-tool:web_search", kind: "chat", source: "app", promptTokens: 0, completionTokens: 0, costUsd: 0.012 },
    { userId: "u1", model: "juno-tool:run_code", kind: "chat", source: "app", promptTokens: 0, completionTokens: 0, costUsd: 0.00046 },
  ]);
  for (const row of rows) {
    assert.ok(row.model.startsWith(JUNO_TOOL_MODEL_PREFIX));
    assert.ok(!("toolFeesUsd" in row), "a tool fee would override the provider's own search fee");
  }
});

test("fee rows are written on a failed turn, and only once", async () => {
  const written: ToolFeeSpendRow[] = [];
  const record = async (row: ToolFeeSpendRow) => {
    written.push(row);
  };

  // A provider error after a paid search: no token row, but the search is billed.
  const fees = new ToolFeeAccumulator();
  fees.add("web_search", 8_000);
  await assert.rejects(async () => {
    try {
      throw new Error("provider_error");
    } finally {
      await recordToolFees(fees, record, { userId: "u1", source: "web" });
    }
  });
  assert.deepEqual(written.map((row) => row.model), ["juno-tool:web_search"]);

  // A normal end writes before the token row; the route's finally then writes nothing.
  const ok = new ToolFeeAccumulator();
  ok.add("run_code", 46);
  assert.equal(await recordToolFees(ok, record, { userId: "u1", source: "web" }), 1);
  assert.equal(await recordToolFees(ok, record, { userId: "u1", source: "web" }), 0);
  assert.equal(written.length, 2);

  // A writer that throws does not take the settlement with it.
  const flaky = new ToolFeeAccumulator();
  flaky.add("web_search", 1_000);
  assert.equal(await recordToolFees(flaky, async () => { throw new Error("db down"); }, { userId: "u1", source: "web" }), 1);

  // Nothing billed, nothing written.
  assert.equal(await recordToolFees(new ToolFeeAccumulator(), record, { userId: "u1", source: "web" }), 0);
});

test("Gemini grounding: only the queries beyond the monthly free quota are billed", () => {
  assert.equal(GEMINI_FREE_GROUNDING_QUERIES_PER_MONTH, 5_000);
  assert.deepEqual(splitGroundingQueries({ monthToDate: 100, queries: 3 }), { free: 3, billable: 0, total: 3 });
  assert.deepEqual(splitGroundingQueries({ monthToDate: 4_999, queries: 3 }), { free: 1, billable: 2, total: 3 });
  assert.deepEqual(splitGroundingQueries({ monthToDate: 9_000, queries: 3 }), { free: 0, billable: 3, total: 3 });
  // Unknown month-to-date: the quota is treated as spent, never as free.
  assert.deepEqual(splitGroundingQueries({ monthToDate: null, queries: 4 }), { free: 0, billable: 4, total: 4 });

  // Only the billable count reaches recordSpend (and the budget guard) as webSearchRequests.
  const fields = groundingSpendFields(splitGroundingQueries({ monthToDate: 4_999, queries: 3 }));
  assert.deepEqual(fields, { webSearchRequests: 2, groundingQueries: 3 });
  assert.deepEqual(groundingSpendFields(splitGroundingQueries({ monthToDate: 0, queries: 3 })), { groundingQueries: 3 });
  assert.deepEqual(groundingSpendFields(splitGroundingQueries({ monthToDate: 0, queries: 0 })), {});
  assert.ok(Math.abs(toolFeesUsd("google", { webSearchRequests: fields.webSearchRequests }) - 0.028) < 1e-9);
});

test("the month-to-date reader caches per process, refreshes by month and fails closed", async () => {
  let now = Date.UTC(2026, 8, 24, 12);
  const loads: Date[] = [];
  let value = 1_000;
  const reader = createGroundingQuotaReader(
    async (since) => {
      loads.push(since);
      return value;
    },
    { now: () => now },
  );
  assert.equal(await reader.monthToDate(), 1_000);
  assert.equal(loads[0].toISOString(), "2026-09-01T00:00:00.000Z");
  reader.note(5);
  value = 2_000;
  assert.equal(await reader.monthToDate(), 1_005, "cached for five minutes, plus this process's own queries");
  now += 5 * 60_000;
  assert.equal(await reader.monthToDate(), 2_000);
  now = Date.UTC(2026, 9, 1, 0, 1);
  assert.equal(await reader.monthToDate(), 2_000);
  assert.equal(loads.at(-1)?.toISOString(), "2026-10-01T00:00:00.000Z", "a new month reloads at once");
  assert.equal(loads.length, 3);

  const broken = createGroundingQuotaReader(async () => {
    throw new Error("db down");
  });
  assert.equal(await broken.monthToDate(), null);
  assert.equal(startOfMonthUtc(new Date(Date.UTC(2026, 11, 31, 23, 59))).toISOString(), "2026-12-01T00:00:00.000Z");
});

test("juno-tool rows are not replies, and the usage views group them as Tools", () => {
  assert.equal(countsAsReply({ kind: "chat", model: "anthropic:claude-sonnet-5" }), true);
  assert.equal(countsAsReply({ kind: null, model: "openai:gpt-6" }), true);
  assert.equal(countsAsReply({ kind: "utility", model: "anthropic:claude-haiku-4-5" }), false);
  assert.equal(countsAsReply({ kind: "chat", model: "juno-tool:web_search" }), false);
  assert.equal(isJunoToolSpendModel("juno-tool:run_code"), true);
  assert.equal(isJunoToolSpendModel("juno-toolkit"), false);
  assert.equal(usageModelLabel("juno-tool:web_search"), TOOL_USAGE_COPY.group);
  assert.equal(usageModelLabel(" anthropic:claude-sonnet-5 "), "anthropic:claude-sonnet-5");
  assert.equal(usageModelLabel(null), "unknown");

  // The two usage views read the rule rather than re-spelling it.
  const stats = read("src/app/api/profile/stats/route.ts");
  assert.match(stats, /kind: \{ not: "utility" \},\s*model: \{ not: \{ startsWith: JUNO_TOOL_MODEL_PREFIX \} \},/);
  assert.match(stats, /\(s\.kind \|\| "chat"\) !== "utility" && isJunoToolSpendModel\(s\.model\)/);
  assert.match(stats, /usageModelLabel\(spend\.model\)/);
  const breakdown = read("src/lib/usage-breakdown.ts");
  assert.match(breakdown, /foldModelTotals\(modelRows\.map\(\(row\) => \(\{ model: usageModelLabel\(row\.model\)/);
});

test("the ledger has a nullable groundingQueries column, added expand-only", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model ApiSpend \{[\s\S]*?groundingQueries Int\?[\s\S]*?\n\}/);
  const migration = read("prisma/migrations/20260924180000_api_spend_grounding_queries/migration.sql");
  assert.match(migration, /ALTER TABLE "ApiSpend" ADD COLUMN IF NOT EXISTS "groundingQueries" INTEGER;/);
  assert.doesNotMatch(migration, /UPDATE|NOT NULL|DROP/i);
});
