import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { summarySourcesStillHold } from "@/lib/memory-summary-changes";

/*
 * A summary must not bring back what was cleared while it was being written.
 *
 * Consolidation reads its sources, waits up to 45 seconds on a model, then
 * upserts. A reset, a delete or a forget in that window finished first, so
 * the upsert landed after it: the summary of the memory just erased, stamped
 * NEWER than the erasure. Deleted rows leave no marker and the summary
 * post-dates the new suppression, so nothing benched it — and since the reset
 * also set the fact count the rebuild rule compares to, nothing rebuilt it
 * either. "Start fresh" was undone by the consolidation the previous chat
 * turn had kicked off, for as long as no new fact happened to arrive.
 *
 * The real consolidation runs here — the source reads, the prompt, the
 * suppression scrub, the write — against an in-memory table, with a model
 * that clears memory while it "writes".
 */

type Row = { id: string; userId: string; content: string; kind: "FACT" | "SUPPRESSION"; status: string; projectId: string | null };
let rows: Row[] = [];
const upserts: string[] = [];
const at = new Date("2026-10-01T00:00:00Z");

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const key of ["userId", "kind", "status", "projectId"] as const) {
    if (key in where && typeof where[key] !== "object" && row[key] !== where[key]) return false;
    if (key === "projectId" && where[key] === null && row.projectId !== null) return false;
  }
  return true;
}
const view = (row: Row) => ({ ...row, createdAt: at, observedAt: at, source: "MANUAL", expiresAt: null });
const prisma = {
  memoryEntry: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).map(view),
    count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).length,
  },
  conversationMemory: { findMany: async () => [] },
  project: { findMany: async () => [] },
  connection: { findUnique: async () => null },
  settings: { findUnique: async () => null },
  memorySummary: {
    upsert: async () => {
      upserts.push("account");
      return {};
    },
    deleteMany: async () => ({ count: 0 }),
  },
  projectMemorySummary: {
    upsert: async () => {
      upserts.push("project");
      return {};
    },
    deleteMany: async () => ({ count: 0 }),
  },
};
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": {
    prisma,
    prismaUnguarded: { project: { findUnique: async () => ({ name: "Thesis", instructions: "" }) } },
  },
  "@/lib/message-crypto": {},
  "@/lib/field-crypto": { encryptField: (value: string) => value, decryptField: (value: string) => value },
  "@/lib/llm": {},
  "@/lib/models": { MODEL_LIST: [], getModel: () => undefined, DEFAULT_MODEL: "openai:test", FREE_DEFAULT_MODEL: "openai:test" },
  "@/lib/providers": { isProviderConfigured: () => false },
  "@/lib/model-metrics": { getModelMetrics: () => ({ speed: 1 }) },
  "@/lib/spend": {},
  "@/lib/usage": {},
  "@/lib/knowledge/embed": { configuredEmbeddingModels: () => [] },
  "@/lib/project-collaboration": { checkProjectAccess: async () => ({ allowed: true }) },
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

const fact = (id: string, content: string, projectId: string | null = null): Row => ({
  id,
  userId: "u1",
  content,
  kind: "FACT",
  status: "active",
  projectId,
});
const forget = (id: string, content: string): Row => ({ id, userId: "u1", content, kind: "SUPPRESSION", status: "active", projectId: null });

/** A model that runs `meanwhile` while it is "writing", then answers. */
const writer = (meanwhile: () => void) => async () => {
  meanwhile();
  return "## Work context\nThe user works at Acme.";
};

test("a reset while the account summary is being written is not undone by it", async () => {
  rows = [fact("f1", "The user works at Acme.")];
  upserts.length = 0;
  const outcome = await memory.consolidateMemories({ userId: "u1", llm: writer(() => (rows = [])) });
  assert.notEqual(outcome.status, "updated");
  assert.deepEqual(upserts, []);
});

test("a forget while the account summary is being written keeps it from being stored", async () => {
  rows = [fact("f1", "The user works at Acme.")];
  upserts.length = 0;
  const outcome = await memory.consolidateMemories({
    userId: "u1",
    llm: writer(() => rows.push(forget("s1", "The user works at Acme."))),
  });
  assert.notEqual(outcome.status, "updated");
  assert.deepEqual(upserts, []);
});

test("something learned meanwhile does not hold the summary back", async () => {
  rows = [fact("f1", "The user works at Acme.")];
  upserts.length = 0;
  const outcome = await memory.consolidateMemories({
    userId: "u1",
    llm: writer(() => rows.push(fact("f2", "The user prefers TypeScript."))),
  });
  assert.equal(outcome.status, "updated");
  assert.deepEqual(upserts, ["account"]);
});

test("a project fact deleted while its summary is being written is not brought back", async () => {
  rows = [fact("p1", "The thesis uses APA citations.", "proj"), fact("p2", "The thesis is on tidal energy.", "proj")];
  upserts.length = 0;
  const outcome = await memory.consolidateProjectMemory({
    userId: "u1",
    projectId: "proj",
    llm: writer(() => (rows = rows.filter((row) => row.id !== "p2"))),
  });
  assert.notEqual(outcome.status, "updated");
  assert.deepEqual(upserts, []);
});

test("an untouched project summary is still written", async () => {
  rows = [fact("p1", "The thesis uses APA citations.", "proj")];
  upserts.length = 0;
  const outcome = await memory.consolidateProjectMemory({ userId: "u1", projectId: "proj", llm: writer(() => {}) });
  assert.equal(outcome.status, "updated");
  assert.deepEqual(upserts, ["project"]);
});

test("only a removal makes the sources stale", () => {
  const used = { facts: [{ content: "A" }], suppressions: ["x"], lines: ["digest"] };
  assert.equal(summarySourcesStillHold(used, used), true);
  assert.equal(summarySourcesStillHold(used, { ...used, facts: [{ content: "A" }, { content: "B" }] }), true);
  assert.equal(summarySourcesStillHold(used, { ...used, suppressions: [] }), true);
  assert.equal(summarySourcesStillHold(used, { ...used, facts: [] }), false);
  assert.equal(summarySourcesStillHold(used, { ...used, lines: [] }), false);
  assert.equal(summarySourcesStillHold(used, { ...used, suppressions: ["x", "y"] }), false);
});
