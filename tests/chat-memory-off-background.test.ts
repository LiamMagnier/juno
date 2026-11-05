import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

/*
 * "Memory off for this chat" (src/lib/chat/memory-off.ts) in the background:
 * the real backfill, extractor, re-read queue and dreamer sweep over an
 * in-memory account with one ordinary chat and one kept out of memory. Only
 * the database and the model layer are fixtures; every query they make is
 * recorded, so "skips it" means "never asked for its messages".
 */

interface Chat {
  id: string;
  userId: string;
  title: string;
  model: string;
  projectId: string | null;
  lastMessageAt: Date;
  memoryOff: boolean;
  memory: { processedAt: Date; factCount: number; digest: string | null } | null;
}

const at = new Date("2026-10-30T10:00:00Z");
let chats: Chat[] = [];
const conversationFinds: unknown[] = [];
const messageReads: unknown[] = [];
const memoryWrites: unknown[] = [];
const rereadQueries: unknown[] = [];
let dreamSql: Prisma.Sql | null = null;
let modelCalls = 0;

function matches(chat: Chat, where: Record<string, unknown>): boolean {
  if (where.userId !== undefined && where.userId !== chat.userId) return false;
  if (where.id !== undefined && where.id !== chat.id) return false;
  if (where.memoryOff !== undefined && where.memoryOff !== chat.memoryOff) return false;
  return true;
}

const fakePrisma = {
  conversation: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      conversationFinds.push(where);
      return chats.filter((chat) => matches(chat, where)).map((chat) => ({ ...chat }));
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      conversationFinds.push(where);
      const chat = chats.find((c) => matches(c, where));
      return chat ? { ...chat } : null;
    },
  },
  message: {
    findMany: async (args: { where: { conversationId: string } }) => {
      messageReads.push(args.where.conversationId);
      // Nothing new said: the extractor covers the chat as read without a model call.
      return [];
    },
  },
  conversationMemory: {
    upsert: async (args: { where: { conversationId: string; userId: string }; create: { processedAt: Date } }) => {
      memoryWrites.push(args);
      const chat = chats.find((c) => c.id === args.where.conversationId && c.userId === args.where.userId);
      if (chat) chat.memory = { processedAt: args.create.processedAt, factCount: 0, digest: null };
      return {};
    },
    findMany: async (args: unknown) => {
      rereadQueries.push(args);
      return [];
    },
    updateMany: async () => ({ count: 0 }),
  },
  memoryEntry: { findFirst: async () => null, findMany: async () => [] },
};

const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": {
    prisma: fakePrisma,
    prismaUnguarded: {
      $queryRaw: async (sql: Prisma.Sql) => {
        dreamSql = sql;
        return [];
      },
    },
  },
  "@/lib/message-crypto": { decryptMessageText: (text: string) => text },
  "@/lib/field-crypto": {},
  "@/lib/llm": {
    streamChat: async function* () {
      modelCalls += 1;
    },
  },
  "@/lib/providers": { isProviderConfigured: () => true },
  "@/lib/model-metrics": { getModelMetrics: () => ({ speed: 100 }) },
  "@/lib/spend": { checkBudget: async () => ({ allowed: true }), recordSpend: async () => true, checkUsageWindows: async () => ({ allowed: true }) },
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
let memory: typeof import("@/lib/memory");
let findAccountsToDream: typeof import("@/lib/memory-dreamer").findAccountsToDream;
try {
  memory = require("../src/lib/memory");
  // The dreamer reads the real memory module through the same loader.
  stubs["@/lib/memory"] = memory;
  ({ findAccountsToDream } = require("../src/lib/memory-dreamer"));
} finally {
  moduleLoader._load = originalLoad;
}

function reset() {
  chats = [
    { id: "chat-on", userId: "u1", title: "Dinner plans", model: "anthropic:claude-opus-4-8", projectId: null, lastMessageAt: at, memoryOff: false, memory: null },
    { id: "chat-off", userId: "u1", title: "Private matter", model: "anthropic:claude-opus-4-8", projectId: null, lastMessageAt: at, memoryOff: true, memory: null },
  ];
  conversationFinds.length = 0;
  messageReads.length = 0;
  memoryWrites.length = 0;
  rereadQueries.length = 0;
  modelCalls = 0;
}

test("the backfill skips a chat with memory off: never read, never counted as left to read", async () => {
  reset();
  assert.deepEqual(await memory.pendingBackfill("u1"), ["chat-on"]);
  assert.deepEqual(conversationFinds[0], { userId: "u1", memoryOff: false }, "asked for at the query, not filtered after");

  const pass = await memory.backfillMemories({ userId: "u1", maxConversations: 10 });
  assert.equal(pass.processedConversations, 1);
  assert.equal(pass.remaining, 0, "“Learn from past chats” finishes instead of waiting on it forever");
  assert.deepEqual(messageReads, ["chat-on"], "the kept-out chat's messages are never asked for");
  assert.equal(memoryWrites.length, 1);
  assert.equal(chats.find((c) => c.id === "chat-off")!.memory, null, "and no high-water mark is moved for it");
  assert.equal(modelCalls, 0);
});

test("the extractor itself refuses the chat, whoever calls it (a turn's after-hook, a voice transcript)", async () => {
  reset();
  const result = await memory.extractConversationMemory({ userId: "u1", conversationId: "chat-off" });
  assert.deepEqual(result, { created: 0, chunksProcessed: 0, done: true });
  assert.deepEqual(messageReads, [], "not one message read");
  assert.deepEqual(memoryWrites, [], "no mark written either: turning memory back on covers it");
  assert.equal(modelCalls, 0);
});

test("re-reads never rewind it, and the dreamer does not visit an account for it", async () => {
  reset();
  await memory.queueRereads("u1", 2);
  const where = (rereadQueries[0] as { where: Record<string, unknown> }).where;
  assert.deepEqual(where.conversation, { memoryOff: false });

  await findAccountsToDream(5);
  assert.ok(dreamSql, "the sweep ran its query");
  assert.match(dreamSql!.sql, /c\."memoryOff" = false/);
});
