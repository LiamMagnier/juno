import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo } from "@/lib/models";
import type { LlmEvent } from "@/types/llm";
import type { RecordSpendInput } from "@/lib/spend";

// Run the real utility walk and its finally/ledger boundary. Only external
// providers, account state and database writes are replaced by deterministic
// fixtures; the pricing, policy resolution and failure classification run.
const model = {
  id: "openai:test-utility",
  provider: "openai",
  providerModel: "gpt-4.1-mini",
  name: "Utility fixture",
  family: "gpt",
  minPlan: "FREE",
  cost: 1,
  modality: "chat",
} as ModelInfo;
let events: LlmEvent[] = [];
let failure: unknown;
let calls = 0;
const writes: RecordSpendInput[] = [];
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma: {}, prismaUnguarded: {} },
  "@/lib/message-crypto": {},
  "@/lib/field-crypto": {},
  "@/lib/llm": { streamChat: async function* () {
    calls += 1;
    for (const event of events) yield event;
    if (failure) throw failure;
  } },
  "@/lib/models": { MODEL_LIST: [model], getModel: () => model },
  "@/lib/providers": { isProviderConfigured: () => true },
  "@/lib/model-metrics": { getModelMetrics: () => ({ speed: 100 }) },
  "@/lib/spend": {
    checkBudget: async () => ({ allowed: true }),
    recordSpend: async (input: RecordSpendInput) => { writes.push(input); return true; },
  },
  "@/lib/usage": { getUserPlan: async () => "PRO" },
  "@/lib/knowledge/embed": {},
  "@/lib/project-collaboration": {},
  "@/lib/chat/branches": { ON_ACTIVE_PATH: { onActivePath: true } },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let runUtilityPrompt: typeof import("@/lib/memory").runUtilityPrompt;
try {
  ({ runUtilityPrompt } = require("../src/lib/memory"));
} finally {
  moduleLoader._load = originalLoad;
}

async function run(input: { status?: number; events?: LlmEvent[]; error?: unknown } = {}) {
  events = input.events ?? [];
  failure = input.error ?? (input.status ? Object.assign(new Error("Request rejected"), { status: input.status }) : undefined);
  calls = 0;
  writes.length = 0;
  return runUtilityPrompt({
    system: "Generate a title for this conversation.",
    userMsg: "Explain how database transactions work.",
    maxTokens: 32,
    label: "utility-billing-fixture",
    userId: "account-a",
    policy: { mode: "same_provider" },
    conversationProvider: "openai",
    parse: (text) => text || null,
  });
}

test("rejected utility requests spend no credits and create no billable ledger row", async () => {
  for (const status of [400, 401, 402, 403, 404, 413, 422, 429]) {
    const result = await run({ status });
    assert.equal(calls, 1);
    assert.equal(result.result, null);
    assert.equal(result.costMicroUsd, 0, `HTTP ${status} must not be billed as prompt characters`);
    assert.equal(writes.length, 0);
  }
});

test("partial output, even followed by a rejection-shaped error, remains billed", async () => {
  const result = await run({ status: 429, events: [{ type: "text", text: "Database transactions" }] });
  assert.ok((result.costMicroUsd ?? 0) > 0);
  assert.equal(writes.length, 1);
  assert.ok((writes[0].completionTokens ?? 0) > 0);
});

test("an accepted stream's zero usage event does not turn a subsequent failure into a rejection", async () => {
  const result = await run({ status: 400, events: [{ type: "usage", input: 0, output: 0 }] });
  assert.ok((result.costMicroUsd ?? 0) > 0, "missing telemetry after acceptance retains the character estimate");
  assert.equal(writes.length, 1);
});

test("ambiguous transport failure without telemetry retains the conservative estimate", async () => {
  const result = await run({ error: new Error("Connection closed before usage") });
  assert.ok((result.costMicroUsd ?? 0) > 0);
  assert.equal(writes.length, 1);
});

test("successful requests retain one ledger row with the same cost returned to the caller", async () => {
  const result = await run({ events: [
    { type: "text", text: "Database transactions" },
    { type: "usage", input: 100, output: 10 },
  ] });
  assert.equal(result.result, "Database transactions");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].promptTokens, 100);
  assert.equal(writes[0].completionTokens, 10);
  assert.equal(result.costMicroUsd, Math.round((writes[0].costUsd ?? 0) * 1_000_000));
});
