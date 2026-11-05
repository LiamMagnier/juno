import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

/*
 * Rewording a "never remember" entry is a forget, and has to bench the summary
 * the way one does.
 *
 * A block-list row can be reworded — on the memory page's pencil and by a
 * device's `memory.update` — and both paths keep that possible on purpose.
 * The summary written before is benched by `summaryPredatesForget`, which was
 * handed the NEWEST SUPPRESSION'S CREATION TIME. A reworded row keeps its
 * creation time, so changing "forget my old job" into "forget where I live"
 * left a summary that says where they live injected into every chat, until
 * something unrelated rebuilt it; and `maybeConsolidate`, asking the same
 * question, saw no reason to.
 *
 * getMemoryProfile and newestSuppressionAt run for real here, over an
 * in-memory table.
 */

const created = new Date("2026-10-01T00:00:00Z");
const summarized = new Date("2026-10-02T00:00:00Z");
const reworded = new Date("2026-10-03T00:00:00Z");
const suppression = { id: "s1", content: "The user lives in Lisbon.", createdAt: created, updatedAt: reworded };

const prisma = {
  memorySummary: {
    findUnique: async () => ({ content: "## Personal context\nThe user lives in Lisbon.", updatedAt: summarized, entryCount: 1 }),
  },
  memoryEntry: {
    findMany: async ({ where }: { where: { kind?: string } }) => (where.kind === "SUPPRESSION" ? [suppression] : []),
    findFirst: async ({ where }: { where: { kind?: string } }) => (where.kind === "SUPPRESSION" ? suppression : null),
    updateMany: async () => ({ count: 0 }),
  },
  settings: { findUnique: async () => null },
};
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma, prismaUnguarded: {} },
  "@/lib/message-crypto": {},
  "@/lib/field-crypto": { encryptField: (value: string) => value, decryptField: (value: string) => value },
  "@/lib/llm": {},
  "@/lib/models": { MODEL_LIST: [], getModel: () => undefined, DEFAULT_MODEL: "openai:test", FREE_DEFAULT_MODEL: "openai:test" },
  "@/lib/providers": { isProviderConfigured: () => false },
  "@/lib/model-metrics": { getModelMetrics: () => ({ speed: 1 }) },
  "@/lib/spend": {},
  "@/lib/usage": {},
  "@/lib/knowledge/embed": { configuredEmbeddingModels: () => [] },
  "@/lib/project-collaboration": {},
  "@/lib/chat/branches": { ON_ACTIVE_PATH: {} },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let memory: typeof import("@/lib/memory");
try {
  memory = require("../src/lib/memory");
} finally {
  moduleLoader._load = originalLoad;
}

test("a summary written before a block-list entry was reworded is not injected", async () => {
  const profile = await memory.getMemoryProfile("u1", { conversationProvider: null, query: "where should I eat tonight?" });
  assert.equal(profile.summary, null);
});

test("the rebuild rule sees a reworded block-list entry as the newest forget", async () => {
  assert.deepEqual(await memory.newestSuppressionAt("u1"), reworded);
});
