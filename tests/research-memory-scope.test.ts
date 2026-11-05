import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { searchPrivateSourcesWith } from "@/lib/research/private-retrieval-core";

/*
 * Deep Research reads memory the way the chat it runs in does.
 *
 * A chat filed in a project reads that project's memory in isolation — its
 * facts and summary, never the account's personal ones — and a project that
 * turned memory recall off reads none (getMemoryProfile, the chat turn's
 * resolveMemory, the voice memory route). Research's memory source called
 * getMemoryProfile with the user and the query only, so a run started in a
 * project chat was handed the ACCOUNT's facts: what its owner said about
 * their health or their family, in a report filed in a work project, and
 * none of the project's own notes. The port was never even told which
 * conversation it was answering for.
 */

const profileCalls: Array<{ userId: string; opts: Record<string, unknown> }> = [];
let workspaceConfig: unknown = null;
const prisma = {
  settings: { findUnique: async () => ({ memoryEnabled: true }) },
  conversation: {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      where.id === "project-chat" && where.userId === "u1" ? { projectId: "proj" } : where.id === "plain-chat" ? { projectId: null } : null,
  },
  projectWorkspace: {
    findFirst: async ({ where }: { where: { projectId: string; userId: string } }) =>
      where.projectId === "proj" && where.userId === "u1" && workspaceConfig ? { config: workspaceConfig } : null,
  },
};
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma },
  "@/lib/knowledge/retrieve": {},
  "@/lib/memory": {
    loadBackgroundProviderPolicy: async () => ({ mode: "same_provider" }),
    getMemoryProfile: async (userId: string, opts: Record<string, unknown>) => {
      profileCalls.push({ userId, opts });
      return { recent: ["The user writes in British English."] };
    },
  },
  "@/lib/mcp": {},
  "@/lib/connectors": { getConnector: () => null, isConnectorConfigured: () => false },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let productionPrivatePorts: typeof import("@/lib/research/private-retrieval").productionPrivatePorts;
try {
  ({ productionPrivatePorts } = require("../src/lib/research/private-retrieval"));
} finally {
  moduleLoader._load = originalLoad;
}

test("the memory source is told which conversation the run is for", async () => {
  const seen: Array<Record<string, unknown>> = [];
  await searchPrivateSourcesWith(
    {
      async memory(input) {
        seen.push(input);
        return [];
      },
    },
    {
      userId: "u1",
      runId: "r1",
      conversationId: "project-chat",
      options: [{ key: "memory", kind: "memory", defaultOn: false }],
      enabled: ["memory"],
      questions: ["How should the thesis cite sources?"],
    }
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].conversationId, "project-chat");
});

test("a run in a project chat reads that project's memory, not the account's", async () => {
  profileCalls.length = 0;
  workspaceConfig = null;
  await productionPrivatePorts().memory!({ userId: "u1", conversationId: "project-chat", query: "citations" });
  assert.equal(profileCalls.length, 1);
  assert.equal(profileCalls[0].opts.projectId, "proj");
});

test("a run in an ordinary chat reads the account's memory", async () => {
  profileCalls.length = 0;
  await productionPrivatePorts().memory!({ userId: "u1", conversationId: "plain-chat", query: "citations" });
  assert.equal(profileCalls.length, 1);
  assert.equal(profileCalls[0].opts.projectId ?? null, null);
});

test("a project that turned memory recall off gives a run no memory", async () => {
  profileCalls.length = 0;
  workspaceConfig = { allowedTools: ["webSearch"] };
  const facts = await productionPrivatePorts().memory!({ userId: "u1", conversationId: "project-chat", query: "citations" });
  workspaceConfig = null;
  assert.deepEqual(facts, []);
  assert.equal(profileCalls.length, 0);
});

test("a conversation that is not this person's is read as no project", async () => {
  profileCalls.length = 0;
  await productionPrivatePorts().memory!({ userId: "u2", conversationId: "project-chat", query: "citations" });
  assert.equal(profileCalls.length, 1);
  assert.equal(profileCalls[0].opts.projectId ?? null, null);
});
