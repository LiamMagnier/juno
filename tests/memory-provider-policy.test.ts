import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveBackgroundCandidates } from "@/lib/background-provider-policy";

/*
 * MEMORY EMBEDDINGS RESPECT THE CONVERSATION'S PROVIDER (MEM-01).
 *
 * `same_provider`, the default, promises that the provider picked for a
 * conversation is the provider that sees it. The chat turn's memory read
 * never said which provider that was, so the query embed fell back to the
 * account default's: with the default on Qwen, a chat on Claude sent the
 * person's message to Qwen's embeddings endpoint. The provider is now
 * required wherever a query is ranked, and there is no fallback.
 *
 * getMemoryProfile runs for real here, over an in-memory table whose
 * account default is a Qwen model, so the old fallback would show.
 */

const facts = [
  { id: "f1", content: "The user drinks espresso every morning.", embeddingModel: "qwen:text-embedding-v4" },
  { id: "f2", content: "The user lives in Porto.", embeddingModel: "qwen:text-embedding-v4" },
].map((row) => ({
  ...row,
  normalized: row.content.toLowerCase(),
  category: "preference",
  kind: "FACT",
  status: "active",
  projectId: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  lastVerifiedAt: null,
  lastUsedAt: null,
  expiresAt: null,
  confidence: 0.9,
  source: "user",
  sensitivity: null,
  notRelevantAt: null,
}));

const prisma = {
  memorySummary: { findUnique: async () => null },
  memoryEntry: {
    findMany: async ({ where }: { where: { kind?: string; embeddingModel?: string } }) =>
      where.kind === "FACT" && !where.embeddingModel ? facts : [],
    findFirst: async () => null,
    updateMany: async () => ({ count: 0 }),
  },
  settings: {
    findUnique: async () => ({ defaultModel: "qwen:qwen3.8-flash", backgroundProviderMode: "same_provider" }),
  },
};
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma, prismaUnguarded: {} },
  "@/lib/message-crypto": {},
  "@/lib/field-crypto": { encryptField: (value: string) => value, decryptField: (value: string) => value },
  "@/lib/llm": {},
  "@/lib/models": {
    MODEL_LIST: [],
    getModel: (id: string) => ({ id, provider: id.split(":")[0] }),
    DEFAULT_MODEL: "qwen:qwen3.8-flash",
    FREE_DEFAULT_MODEL: "qwen:qwen3.8-flash",
  },
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

function spyEmbed() {
  const calls: Array<{ conversationProvider: unknown; preferModelId: unknown }> = [];
  const embed = (async (options: { conversationProvider?: string | null; preferModelId?: string }) => {
    calls.push({ conversationProvider: options.conversationProvider, preferModelId: options.preferModelId });
    return { ok: false, reason: "denied" };
  }) as never;
  return { calls, embed };
}

test("the query is embedded on the turn's provider, pinned to the stored vector space", async () => {
  const { calls, embed } = spyEmbed();
  await memory.getMemoryProfile("u1", { query: "how do I take my coffee?", conversationProvider: "qwen", embed });
  assert.deepEqual(calls, [{ conversationProvider: "qwen", preferModelId: "qwen:text-embedding-v4" }]);
});

test("a chat on another provider is never handed the account default's provider", async () => {
  const { calls, embed } = spyEmbed();
  const profile = await memory.getMemoryProfile("u1", { query: "when do I drink espresso?", conversationProvider: "anthropic", embed });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conversationProvider, "anthropic", "not qwen, the account default's provider");
  // A refused embed still selects lexically.
  assert.ok(profile.recent.some((fact) => fact.includes("espresso")));
});

test("no provider means no provider: the default is not looked up", async () => {
  const { calls, embed } = spyEmbed();
  await memory.getMemoryProfile("u1", { query: "how do I take my coffee?", conversationProvider: null, embed });
  assert.equal(calls[0].conversationProvider, null);
});

test("under same_provider the policy permits only the conversation's provider, and nothing without one", () => {
  const policy = { mode: "same_provider" as const, allowedProviders: null, selectedProvider: null };
  const candidates = [{ provider: "qwen", id: "qwen:text-embedding-v4" }, { provider: "openai", id: "openai:text-embedding-3-small" }];
  assert.deepEqual(resolveBackgroundCandidates({ policy, conversationProvider: "anthropic", candidates }).candidates, []);
  assert.deepEqual(resolveBackgroundCandidates({ policy, conversationProvider: null, candidates }).candidates, []);
  assert.deepEqual(
    resolveBackgroundCandidates({ policy, conversationProvider: "qwen", candidates }).candidates.map((c) => c.provider),
    ["qwen"]
  );
});

test("the profile's embed has no account-default fallback", () => {
  const source = readFileSync(new URL("../src/lib/memory.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function semanticEvidenceFor("), source.indexOf("export type MemoryProfileOptions"));
  assert.doesNotMatch(fn, /accountBackgroundProvider/);
});

test("every turn path that ranks memory passes the turn's provider", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(read("src/app/api/chat/route.ts"), /resolveMemory\(\{[\s\S]*?conversationProvider: modelInfo\.provider,[\s\S]*?\}\)/);
  assert.match(read("src/lib/chat/turn/memory.ts"), /query: latestUserMessage,\s*conversationProvider,/);
  assert.match(read("src/lib/chat/turn/run-turn.ts"), /saveAutoMemories\([\s\S]{0,400}conversationProvider: modelInfo\.provider/);
  assert.match(read("src/lib/research/private-retrieval.ts"), /getMemoryProfile\(userId, \{[^}]*conversationProvider \}\)/);
  assert.match(read("scripts/work-runner.ts"), /getMemoryProfile\(input\.userId, \{[\s\S]{0,120}conversationProvider: input\.conversationProvider/);
});
