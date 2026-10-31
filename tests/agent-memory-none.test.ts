import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPromptSections } from "@/lib/chat/system-prompt";
import { turnMayUseMemory } from "@/lib/memory-scope";
import { postGenerationPlan } from "@/lib/chat/post-processing";

// The real resolveMemory stage over fixtures: the agent row it reads, and the
// memory reads it would make.
let agentRow: { id: string; memoryAccess: string } | null = null;
const profileReads: unknown[] = [];
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma: { agent: { findFirst: async () => agentRow } } },
  "@/lib/memory": {
    getMemoryProfile: async (_userId: string, opts: unknown) => {
      profileReads.push(opts);
      return { summary: "A designer.", summaryScope: "account", recent: ["The user likes tea."], used: [], usedTokens: 4, droppedForBudget: 0 };
    },
  },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let resolveMemory: typeof import("@/lib/chat/turn/memory").resolveMemory;
try {
  ({ resolveMemory } = require("../src/lib/chat/turn/memory"));
} finally {
  moduleLoader._load = originalLoad;
}

async function turnFor(memoryAccess: string | null) {
  agentRow = memoryAccess ? { id: "agent-1", memoryAccess } : null;
  profileReads.length = 0;
  return resolveMemory({
    userId: "u1",
    settings: { memoryEnabled: true } as Parameters<typeof resolveMemory>[0]["settings"],
    workspaceConfig: {},
    projectId: null,
    latestUserMessage: "hello",
    conversationProvider: "anthropic",
    agentId: memoryAccess ? "agent-1" : null,
    // The chat's own switch left on (tests/chat-memory-off.test.ts turns it off).
    chatMemoryOff: false,
  });
}

test("an agent with memoryAccess none neither reads nor writes the person's memory, as a private chat", async () => {
  const none = await turnFor("none");
  assert.equal(none.memoryEnabled, false);
  assert.equal(profileReads.length, 0, "nothing is read");
  assert.equal(none.memoryProfile.summary, null);

  // Off means: no memory instructions, so no `<juno:memory>` / `<juno:forget>`
  // tags are asked for, and the turn's save, forget and extraction steps are
  // all gated on the same flag.
  const prompt = buildSystemPromptSections({ memoryEnabled: none.memoryEnabled, canvas: false }).stable;
  assert.doesNotMatch(prompt, /<juno:memory>/);
  assert.doesNotMatch(prompt, /<juno:forget>/);
  assert.equal(postGenerationPlan({ moderate: false, memoryEnabled: none.memoryEnabled, producedAnswer: true }).extractsMemory, false);

  // The other grants keep today's behaviour: memory on, read through the grant.
  for (const access of ["profile", "full"] as const) {
    const turn = await turnFor(access);
    assert.equal(turn.memoryEnabled, true, access);
    assert.deepEqual((profileReads[0] as { agent: unknown }).agent, { id: "agent-1", access });
    assert.match(buildSystemPromptSections({ memoryEnabled: turn.memoryEnabled, canvas: false }).stable, /<juno:memory>/);
  }
  // An ordinary chat, with no agent speaking, is untouched.
  const plain = await turnFor(null);
  assert.equal(plain.memoryEnabled, true);
  assert.equal((profileReads[0] as { agent: unknown }).agent, null);

  assert.equal(turnMayUseMemory({ enabled: true, agentAccess: "none" }), false);
  assert.equal(turnMayUseMemory({ enabled: false, agentAccess: "full" }), false);
  assert.equal(turnMayUseMemory({ enabled: true, agentAccess: null }), true);
});
