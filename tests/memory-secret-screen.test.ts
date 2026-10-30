import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { planFactIngestion } from "@/lib/memory-lifecycle";

// The real save loop over a recording Prisma fixture: what an automatic save
// writes, and what it logs, when a candidate carries a secret.
const created: string[] = [];
const prisma = {
  memoryEntry: {
    findMany: async () => [],
    create: async ({ data }: { data: { content: string } }) => {
      created.push(data.content);
      return { id: `m${created.length}`, kind: "FACT", status: "active", embeddingModel: "fixture", ...data };
    },
    updateMany: async () => ({ count: 0 }),
  },
  settings: { findUnique: async () => null },
};
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma, prismaUnguarded: prisma },
  "@/lib/message-crypto": {},
  "@/lib/field-crypto": {},
  "@/lib/llm": {},
  // No embedding model configured: the save loop skips the vector write.
  "@/lib/knowledge/embed": { configuredEmbeddingModels: () => [] },
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
let memory: typeof import("@/lib/memory");
try {
  memory = require("../src/lib/memory");
} finally {
  moduleLoader._load = originalLoad;
}

const SECRET_FACTS = [
  "The user's Wi-Fi password is hunter2-orchard",
  "The user's OpenAI key is sk-abcdefghijklmnopqrstuvwx",
];
const PLAIN_FACT = "The user prefers passkeys over passwords";

async function capturingWarnings<T>(run: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    return { value: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

test("automatic memory saves drop a fact that looks like a secret and log only that one was dropped", async () => {
  // The `<juno:memory>` tag path.
  created.length = 0;
  const tag = await capturingWarnings(() => memory.saveAutoMemories("u1", [SECRET_FACTS[0], PLAIN_FACT], "c1"));
  assert.deepEqual(created, [PLAIN_FACT]);
  assert.equal(tag.value, 1);

  // The extractor path: the same loop, AUTO by default.
  created.length = 0;
  const extracted = await capturingWarnings(() =>
    memory.saveCandidates("u1", [...SECRET_FACTS, PLAIN_FACT], "c1", { allowedSensitiveTopics: [] }),
  );
  assert.deepEqual(created, [PLAIN_FACT]);
  assert.equal(extracted.value.secretSkipped, 2);
  assert.equal(extracted.value.created, 1);

  for (const { warnings } of [tag, extracted]) {
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /dropped \d automatic fact\(s\) that looked like a secret/);
    for (const secret of ["hunter2", "sk-abcdefghijklmnopqrstuvwx", "Wi-Fi"]) {
      assert.ok(!warnings[0].includes(secret), "the value never reaches the log");
    }
  }
});

test("a fact the person adds on the memory page is not screened", async () => {
  const context = { entries: [], suppressions: [], now: new Date("2026-01-01T00:00:00Z"), allowedSensitiveTopics: [] };
  assert.deepEqual(planFactIngestion({ content: SECRET_FACTS[0], source: "AUTO" }, context), {
    action: "skip",
    reason: "secret",
  });
  assert.equal(planFactIngestion({ content: SECRET_FACTS[0], source: "MANUAL" }, context).action, "create");

  created.length = 0;
  const manual = await capturingWarnings(() =>
    memory.saveCandidates("u1", [SECRET_FACTS[0]], "page", { source: "MANUAL", allowedSensitiveTopics: [] }),
  );
  assert.deepEqual(created, [SECRET_FACTS[0]]);
  assert.equal(manual.value.secretSkipped, 0);
  assert.deepEqual(manual.warnings, []);
});
