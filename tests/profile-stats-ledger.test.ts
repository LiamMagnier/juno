import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

// Run the real GET handler. The legacy implementation repriced token totals
// without cache/batch/request receipts, then UPDATED the user's budget ledger.
// These deliberately discounted fixtures must remain exactly as settled.
type Spend = {
  id: string;
  userId: string;
  model: string;
  kind: string;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number | null;
  createdAt: Date;
};
type Query = { where: {
  userId: string;
  kind?: { not: string };
  model?: { not: { startsWith: string } };
  createdAt?: { gte: Date };
} };
let user: { id: string } | null;
let spends: Spend[];
let queries: Query[];
let updates: unknown[];
let repricings: number;

const stubs: Record<string, unknown> = {
  "@/lib/session": { getCurrentUser: async () => user },
  "@/lib/spend": { eurPerUsd: () => 0.9 },
  "@/lib/models": { resolveModel: () => ({ id: "model" }) },
  "@/lib/pricing": { recomputeCostMicroUsd: () => { repricings += 1; return 100_000_000; } },
  "@/lib/prisma": { prisma: {
    user: { findUnique: async ({ where }: { where: { id: string } }) => {
      assert.equal(where.id, user?.id);
      return { createdAt: new Date("2025-01-01T00:00:00Z") };
    } },
    apiSpend: {
      findMany: async (query: Query) => {
        queries.push(query);
        const { where } = query;
        return spends.filter((row) =>
          row.userId === where.userId &&
          (!where.kind || row.kind !== where.kind.not) &&
          (!where.model || !row.model.startsWith(where.model.not.startsWith)) &&
          (!where.createdAt || row.createdAt >= where.createdAt.gte)
        ).map((row) => ({ ...row }));
      },
      update: async (write: unknown) => { updates.push(write); return {}; },
    },
  } },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let GET: typeof import("../src/app/api/profile/stats/route").GET;
try {
  ({ GET } = require("../src/app/api/profile/stats/route"));
} finally {
  moduleLoader._load = originalLoad;
}

function reset(rows: Array<Partial<Spend>>) {
  user = { id: "owner-a" };
  spends = rows.map((row, index) => ({
    id: `spend-${index}`,
    userId: "owner-a",
    model: "openai:gpt-5.4",
    kind: "chat",
    promptTokens: 100_000,
    completionTokens: 1_000,
    costMicroUsd: 62_500,
    createdAt: new Date(),
    ...row,
  }));
  queries = [];
  updates = [];
  repricings = 0;
}

test("cached, batch and per-request prices survive profile reads without being repriced or written", async () => {
  const fixtures = [
    { id: "cached", costMicroUsd: 62_500 },
    { id: "batch", model: "anthropic:claude-sonnet-5", kind: "utility", costMicroUsd: 105_000 },
    { id: "two-short-requests", promptTokens: 300_000, completionTokens: 2_000, costMicroUsd: 780_000 },
  ];
  for (const row of fixtures) {
    reset([row]);
    const before = structuredClone(spends);
    for (let read = 0; read < 2; read += 1) {
      const response = await GET();
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.lifetime.costMicroUsd, row.costMicroUsd, row.id);
      assert.equal(body.lifetime.storedCostMicroUsd, row.costMicroUsd, row.id);
      assert.equal(body.lifetime.byKind[0].costMicroUsd, row.costMicroUsd, row.id);
      assert.equal(body.lifetime.byModel[0].costMicroUsd, row.costMicroUsd, row.id);
    }
    assert.equal(repricings, 0, "incomplete token totals cannot replace a settled price");
    assert.deepEqual(updates, [], "GET must never alter monthly budget charges");
    assert.deepEqual(spends, before);
  }
});

test("settled tool, utility, zero and retired-model charges stay in cost totals and outside reply counts as appropriate", async () => {
  reset([
    { id: "chat", costMicroUsd: 62_500 },
    { id: "batch", kind: "utility", costMicroUsd: 105_000 },
    { id: "search", model: "juno-tool:web_search", promptTokens: 0, completionTokens: 0, costMicroUsd: 5_000 },
    { id: "retired", model: "retired-model", costMicroUsd: 10_000 },
    { id: "free", costMicroUsd: 0 },
    { id: "other-owner", userId: "owner-b", costMicroUsd: 9_000_000 },
  ]);
  const body = await (await GET()).json();
  assert.equal(body.lifetime.costMicroUsd, 182_500);
  assert.equal(body.lifetime.messages, 3);
  assert.equal(body.yearMessages, 3);
  const byKind = new Map<string, number>(body.lifetime.byKind.map((row: { kind: string; costMicroUsd: number }) => [row.kind, row.costMicroUsd]));
  assert.equal(byKind.get("chat"), 77_500);
  assert.equal(byKind.get("utility"), 105_000);
  assert.equal(queries.length, 2);
  assert.ok(queries.every((query) => query.where.userId === "owner-a"));
  assert.equal(repricings, 0);
  assert.deepEqual(updates, []);
});

test("malformed legacy costs never produce invented charges or mutate stored rows", async () => {
  reset([
    ...[-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.5, null].map((costMicroUsd) => ({ costMicroUsd })),
    { costMicroUsd: 12_345 },
  ]);
  const before = structuredClone(spends);
  const body = await (await GET()).json();
  assert.equal(body.lifetime.costMicroUsd, 12_345);
  assert.equal(body.lifetime.storedCostMicroUsd, 12_345);
  assert.equal(repricings, 0);
  assert.deepEqual(updates, []);
  assert.deepEqual(spends, before);
});

test("unauthenticated profile reads never access the spend ledger", async () => {
  reset([{ costMicroUsd: 100 }]);
  user = null;
  assert.equal((await GET()).status, 401);
  assert.deepEqual(queries, []);
  assert.deepEqual(updates, []);
});
