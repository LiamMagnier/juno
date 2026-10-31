import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSystemPromptSections } from "@/lib/chat/system-prompt";
import { buildTurnContextTail } from "@/lib/chat/turn-context-tail";
import { postGenerationPlan } from "@/lib/chat/post-processing";
import { turnMayUseMemory } from "@/lib/memory-scope";
import { chatUsesMemory, MEMORY_OFF_COPY } from "@/lib/chat/memory-off";
import { chatBodySchema } from "@/lib/chat/request";
import { hashFirstSubmission } from "@/lib/chat-first-submission";
import { workMemoryEnabled } from "@/lib/work/memory-context";
import { mutationOperationSchema } from "@/lib/sync-mutations";

/*
 * "Memory off for this chat" (src/lib/chat/memory-off.ts) at the turn: the
 * real resolveMemory stage over fixtures, then the prompt and the tail the
 * route builds from what it returns, then the gates the tags and the
 * after-turn extraction sit behind.
 */

let agentRow: { id: string; memoryAccess: string } | null = null;
let agentReads = 0;
const profileReads: unknown[] = [];
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": {
    prisma: {
      agent: {
        findFirst: async () => {
          agentReads += 1;
          return agentRow;
        },
      },
    },
  },
  "@/lib/memory": {
    getMemoryProfile: async (_userId: string, opts: unknown) => {
      profileReads.push(opts);
      return {
        summary: "A designer in Lyon.",
        summaryScope: "account",
        recent: ["The user likes tea."],
        used: [{ id: "m1" }],
        usedTokens: 9,
        droppedForBudget: 0,
      };
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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

async function turn(chatMemoryOff: boolean, agent: string | null = null) {
  agentRow = agent ? { id: "agent-1", memoryAccess: agent } : null;
  agentReads = 0;
  profileReads.length = 0;
  return resolveMemory({
    userId: "u1",
    settings: { memoryEnabled: true } as Parameters<typeof resolveMemory>[0]["settings"],
    workspaceConfig: {},
    projectId: null,
    latestUserMessage: "what should I cook tonight?",
    agentId: agent ? "agent-1" : null,
    chatMemoryOff,
  });
}

/** What the route puts in front of the model from a resolved memory (prompt.ts, route.ts). */
function promptFor(memory: Awaited<ReturnType<typeof turn>>) {
  const sections = buildSystemPromptSections({
    memories: [],
    memorySummary: memory.memoryProfile.summary ?? undefined,
    memoryScope: memory.memoryProfile.summaryScope,
    memoryEnabled: memory.memoryEnabled,
    canvas: false,
  });
  const tail = buildTurnContextTail({
    memoryNotes: memory.memoryEnabled ? memory.memoryProfile.recent : [],
    memoryScope: memory.memoryProfile.summaryScope,
    hasMemorySummary: !!memory.memoryProfile.summary,
    retrieved: "",
    references: "",
  });
  return `${sections.stable}\n${sections.variable}\n${tail}`;
}

test("a chat with memory off puts no memory section in the prompt and reads no memory", async () => {
  const off = await turn(true);
  assert.equal(off.memoryEnabled, false);
  assert.equal(profileReads.length, 0, "not one memory row is read");
  assert.equal(off.memoryProfile.summary, null);
  assert.deepEqual(off.memoryProfile.recent, []);
  assert.deepEqual(off.memoryProfile.used, [], "the memory receipt names nothing");

  const prompt = promptFor(off);
  assert.doesNotMatch(prompt, /# Memory\n/);
  assert.doesNotMatch(prompt, /What you already know about this user/);
  assert.doesNotMatch(prompt, /What you remember about this user/);
  assert.doesNotMatch(prompt, /A designer in Lyon|likes tea/);
  assert.doesNotMatch(prompt, /<juno:memory>|<juno:forget>/, "the model is not asked for memory tags");

  // The control: the same chat with memory on reads and shows all of it.
  const on = await turn(false);
  assert.equal(on.memoryEnabled, true);
  assert.equal(profileReads.length, 1);
  const onPrompt = promptFor(on);
  assert.match(onPrompt, /<juno:memory>/);
  assert.match(onPrompt, /A designer in Lyon/);
  assert.match(onPrompt, /likes tea/);
});

test("memory off for the chat wins over an agent's grant, and asks nothing of it", async () => {
  const off = await turn(true, "full");
  assert.equal(off.memoryEnabled, false);
  assert.equal(agentReads, 0, "the agent's grant is not even looked up");
  assert.equal(profileReads.length, 0);
  // The agent's own "none" still holds where the chat leaves memory on.
  assert.equal((await turn(false, "none")).memoryEnabled, false);
  assert.equal((await turn(false, "full")).memoryEnabled, true);
});

test("its memory and forget tags are ignored: every write sits behind the turn's one flag", async () => {
  const off = await turn(true);
  // After the turn: no extraction of this chat.
  assert.equal(postGenerationPlan({ moderate: false, memoryEnabled: off.memoryEnabled, producedAnswer: true }).extractsMemory, false);
  // During it: the reply's <juno:memory> and <juno:forget> tags are saved and
  // acted on only inside `if (memoryEnabled && …)`, the flag resolveMemory
  // just answered false. Held to the source, so a second write path cannot
  // appear beside the gate unnoticed.
  const runTurn = read("../src/lib/chat/turn/run-turn.ts");
  const gate = runTurn.indexOf("if (memoryEnabled && !untrustedContentInTurn && !untrustedToolResult) {");
  assert.ok(gate > 0, "the save/forget gate is where it was");
  const gateEnd = runTurn.indexOf("// Touch the conversation after the assistant message has been persisted.", gate);
  for (const call of ["saveAutoMemories(", "forgetStatements("]) {
    const uses = [...runTurn.matchAll(new RegExp(call.replace("(", "\\("), "g"))].map((m) => m.index!);
    const callSites = uses.filter((at) => !runTurn.slice(Math.max(0, at - 40), at).includes("import"));
    assert.ok(callSites.length > 0, call);
    for (const at of callSites) assert.ok(at > gate && at < gateEnd, `${call} is only reached through the memory gate`);
  }
  // And the route hands that same flag to the turn and to the after-hook.
  const route = read("../src/app/api/chat/route.ts");
  assert.match(route, /chatMemoryOff: conversation\.memoryOff,/);
  assert.match(route, /memoryEnabled: memory\.memoryEnabled,/);
});

test("the rule: the chat's switch only narrows", () => {
  assert.equal(turnMayUseMemory({ enabled: true, agentAccess: null, chatMemoryOff: true }), false);
  assert.equal(turnMayUseMemory({ enabled: true, agentAccess: null, chatMemoryOff: false }), true);
  assert.equal(turnMayUseMemory({ enabled: false, agentAccess: null, chatMemoryOff: false }), false, "cannot turn paused memory on");
  assert.equal(turnMayUseMemory({ enabled: true, agentAccess: "full" }), true, "absent is a chat that never set it");
  assert.equal(chatUsesMemory({ accountMemory: true, chatMemoryOff: true }), false);
  assert.equal(chatUsesMemory({ accountMemory: false, chatMemoryOff: false }), false);
  assert.equal(chatUsesMemory({ accountMemory: true, chatMemoryOff: false }), true);
  // A task started from the chat keeps it (scripts/work-runner.ts).
  assert.equal(workMemoryEnabled({ memoryEnabled: true }, { memoryOff: true }), false);
  assert.equal(workMemoryEnabled({ memoryEnabled: true }, { memoryOff: false }), true);
  assert.equal(workMemoryEnabled(null, null), true);
});

test("the wire: a send can switch a new chat's memory off, and a retry must agree", () => {
  const parsed = chatBodySchema.safeParse({ message: "hi", memoryOff: true });
  assert.ok(parsed.success);
  assert.equal(parsed.data.memoryOff, true);
  assert.ok(chatBodySchema.safeParse({ message: "hi", memoryOff: false }).success, "false is accepted and means nothing");
  assert.ok(!chatBodySchema.safeParse({ message: "hi", memoryOff: "yes" }).success);

  // Every submission that leaves it off keeps the hash it had before the field
  // existed; one that turns it on is a different request.
  const base = { message: "hi", model: "anthropic:claude-opus-4-8" };
  assert.equal(hashFirstSubmission({ ...base, memoryOff: false }), hashFirstSubmission(base));
  assert.notEqual(hashFirstSubmission({ ...base, memoryOff: true }), hashFirstSubmission(base));

  // acceptTurn saves it on the conversation before the turn reads memory.
  const accept = read("../src/lib/chat/turn/accept.ts");
  assert.equal(accept.match(/\.\.\.\(input\.memoryOff \? \{ memoryOff: true \} : \{\}\),/g)?.length, 2, "both creation paths");
  assert.match(accept, /if \(input\.memoryOff && !conversation\.memoryOff\) \{/);

  // The apps: created with it, and toggled through sync.
  assert.ok(mutationOperationSchema.safeParse({ type: "conversation.create", memoryOff: true }).success);
  assert.ok(mutationOperationSchema.safeParse({ type: "conversation.update", entityId: "c1", patch: { memoryOff: false } }).success);
  assert.ok(!mutationOperationSchema.safeParse({ type: "conversation.update", entityId: "c1", patch: { memoryOff: "off" } }).success);
});

test("the switch's words reach the translation catalog whole", async () => {
  const { collectFromSource } = (await import("../scripts/generate-i18n-catalog.mjs")) as {
    collectFromSource: (content: string, path: string) => Set<string>;
  };
  const strings = collectFromSource(read("../src/lib/chat/memory-off.ts"), "memory-off.ts");
  for (const sentence of Object.values(MEMORY_OFF_COPY)) assert.equal(strings.has(sentence), true, sentence);
  const view = collectFromSource(read("../src/components/chat/chat-view.tsx"), "chat-view.tsx");
  assert.equal(view.has("Memory is off for this chat. Nothing in it is used from memory or saved to it."), true);
});
