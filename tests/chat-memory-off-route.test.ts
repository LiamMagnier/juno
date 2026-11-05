import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { EXTRACTOR_VERSION } from "@/lib/memory-extraction";

/*
 * /api/conversations/[id]/memory — "Memory off for this chat"
 * (src/lib/chat/memory-off.ts) — through the real route handler and its
 * writer (src/lib/chat/memory-off-store.ts), over a fixture database that
 * answers only what an owner-scoped query would: a row whose userId the
 * query did not name does not exist. Every query is recorded, so "owner-
 * scoped" is checked at the query, not inferred from a 404.
 *
 * Also here, because it is the same switch reaching the same place: the
 * voice relay token a call in such a chat is given.
 */

interface Row {
  id: string;
  userId: string;
  kind: "chat" | "code";
  memoryOff: boolean;
  lastMessageAt: Date;
  agentId: string | null;
}

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CHAT = "cmemoryoffchat0000000001";
const CODE = "cmemoryoffcode0000000001";
const lastMessageAt = new Date("2026-10-31T08:00:00Z");

let rows: Row[] = [];
let signedIn: { id: string } | null = null;
const queries: { op: string; where: Record<string, unknown> }[] = [];
const coverWrites: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
let lastToken: string | null = null;

function find(where: Record<string, unknown>): Row | undefined {
  // The fixture is the ownership guard: no userId in the query, no row.
  if (typeof where.userId !== "string") return undefined;
  return rows.find(
    (row) =>
      row.id === where.id &&
      row.userId === where.userId &&
      (where.kind === undefined || row.kind === where.kind) &&
      (where.memoryOff === undefined || row.memoryOff === where.memoryOff),
  );
}

const fakePrisma = {
  conversation: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      queries.push({ op: "conversation.findFirst", where });
      const row = find(where);
      return row ? { ...row } : null;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      queries.push({ op: "conversation.updateMany", where });
      const row = find(where);
      if (!row) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  conversationMemory: {
    upsert: async (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      queries.push({ op: "conversationMemory.upsert", where: args.where });
      coverWrites.push(args);
      return {};
    },
  },
  settings: {
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      queries.push({ op: "settings.findUnique", where });
      return { memoryEnabled: true };
    },
  },
  agent: { findFirst: async () => null },
};

const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": { prisma: fakePrisma, prismaUnguarded: fakePrisma },
  "@/lib/session": { getCurrentUser: async () => signedIn },
  // The relay token route's other neighbours: access allowed, a token that is
  // its own payload so the claims can be read back.
  "@/lib/voice-access-policy": { evaluateVoiceAccess: async () => ({ allowed: true, denial: null }) },
  "@/lib/project-collaboration": { checkProjectAccess: async () => ({ allowed: true }) },
  "@/lib/crypto": {
    signState: (payload: string) => {
      lastToken = payload;
      return payload;
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
let route: typeof import("@/app/api/conversations/[id]/memory/route");
let relayToken: typeof import("@/app/api/voice/relay-token/route");
try {
  route = require("../src/app/api/conversations/[id]/memory/route");
  relayToken = require("../src/app/api/voice/relay-token/route");
} finally {
  moduleLoader._load = originalLoad;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown) =>
  new Request("http://x/api/conversations/c/memory", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function reset() {
  rows = [
    { id: CHAT, userId: OWNER, kind: "chat", memoryOff: false, lastMessageAt, agentId: null },
    { id: CODE, userId: OWNER, kind: "code", memoryOff: false, lastMessageAt, agentId: null },
  ];
  queries.length = 0;
  coverWrites.length = 0;
  lastToken = null;
}

// The switch can be set only while CHAT_MEMORY_OFF_ENABLED is "1"; the tests
// below run with it on, the first one shows it off.
process.env.CHAT_MEMORY_OFF_ENABLED = "1";

test("with CHAT_MEMORY_OFF_ENABLED off (the default), PATCH writes nothing, and a chat already kept out stays out", async () => {
  reset();
  signedIn = { id: OWNER };
  delete process.env.CHAT_MEMORY_OFF_ENABLED;
  try {
    const refused = await route.PATCH(patch({ memoryOff: true }), params(CHAT));
    assert.equal(refused.status, 404);
    assert.equal(((await refused.json()) as { code: string }).code, "not_enabled");
    assert.equal(rows[0].memoryOff, false, "nothing is written");
    // A chat saved with memory off (while the flag was on) keeps memory out:
    // turning the flag off never lets memory back in.
    rows[0].memoryOff = true;
    assert.equal((await route.PATCH(patch({ memoryOff: false }), params(CHAT))).status, 404);
    assert.equal(rows[0].memoryOff, true);
    assert.deepEqual(await (await route.GET(new Request("http://x"), params(CHAT))).json(), { memoryOff: true, accountMemory: true });
    process.env.VOICE_RELAY_URL = "ws://127.0.0.1:9";
    await relayToken.GET(new Request(`http://x/api/voice/relay-token?memory=1&conversationId=${CHAT}`));
    assert.equal(JSON.parse(lastToken!).mem, undefined);
    assert.equal(coverWrites.length, 0);
  } finally {
    process.env.CHAT_MEMORY_OFF_ENABLED = "1";
  }
});

test("the toggle API is owner-scoped: signed out, someone else's chat or a Code session is refused, and nothing is written", async () => {
  reset();
  signedIn = null;
  assert.equal((await route.GET(new Request("http://x"), params(CHAT))).status, 401);
  assert.equal((await route.PATCH(patch({ memoryOff: true }), params(CHAT))).status, 401);

  signedIn = { id: STRANGER };
  assert.equal((await route.GET(new Request("http://x"), params(CHAT))).status, 404);
  assert.equal((await route.PATCH(patch({ memoryOff: true }), params(CHAT))).status, 404);
  assert.equal(rows[0].memoryOff, false, "the owner's chat is untouched");

  signedIn = { id: OWNER };
  assert.equal((await route.PATCH(patch({ memoryOff: true }), params(CODE))).status, 404, "a Code session has no such switch");
  assert.equal(rows[1].memoryOff, false);
  assert.equal(coverWrites.length, 0);

  // Only the one field, and only a boolean.
  for (const body of [{ memoryOff: "yes" }, { memoryOff: null }, {}, { memoryOff: true, userId: STRANGER }]) {
    assert.equal((await route.PATCH(patch(body), params(CHAT))).status, 400, JSON.stringify(body));
  }

  // Every conversation query named its owner.
  for (const query of queries) assert.equal(typeof query.where.userId, "string", `${query.op} without userId`);
});

test("the owner switches it off and back on; back on covers what was said meanwhile as read", async () => {
  reset();
  signedIn = { id: OWNER };
  assert.deepEqual(await (await route.GET(new Request("http://x"), params(CHAT))).json(), { memoryOff: false, accountMemory: true });

  const off = await route.PATCH(patch({ memoryOff: true }), params(CHAT));
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { memoryOff: true, accountMemory: true });
  assert.equal(rows[0].memoryOff, true);
  assert.equal(coverWrites.length, 0, "switching off writes nothing to memory");
  assert.deepEqual(await (await route.GET(new Request("http://x"), params(CHAT))).json(), { memoryOff: true, accountMemory: true });

  const on = await route.PATCH(patch({ memoryOff: false }), params(CHAT));
  assert.deepEqual(await on.json(), { memoryOff: false, accountMemory: true });
  assert.equal(rows[0].memoryOff, false);
  assert.equal(coverWrites.length, 1);
  const [cover] = coverWrites;
  assert.deepEqual(cover.where, { conversationId: CHAT, userId: OWNER }, "the cover is owner-scoped too");
  assert.equal(cover.create.processedAt, lastMessageAt, "read up to the last message");
  assert.equal(cover.update.processedAt, lastMessageAt);
  assert.equal(cover.update.extractorVersion, EXTRACTOR_VERSION, "and never rewound by a re-read");

  // The same value again is a read and nothing more.
  await route.PATCH(patch({ memoryOff: false }), params(CHAT));
  assert.equal(coverWrites.length, 1);
  for (const query of queries) assert.equal(typeof query.where.userId, "string", `${query.op} without userId`);
});

test("a voice call in a chat with memory off carries no memory claim, even when one is asked for", async () => {
  reset();
  signedIn = { id: OWNER };
  process.env.VOICE_RELAY_URL = "ws://127.0.0.1:9";
  const call = (id: string) => relayToken.GET(new Request(`http://x/api/voice/relay-token?memory=1&conversationId=${id}`));

  assert.equal((await call(CHAT)).status, 200);
  assert.equal(JSON.parse(lastToken!).mem, 1, "an ordinary chat's call knows what Juno remembers");

  rows[0].memoryOff = true;
  assert.equal((await call(CHAT)).status, 200);
  assert.equal(JSON.parse(lastToken!).mem, undefined, "a kept-out chat's call does not");

  // Someone else's chat id says nothing about the caller's memory.
  signedIn = { id: STRANGER };
  await call(CHAT);
  assert.equal(JSON.parse(lastToken!).mem, 1);
});

test("a call is lent the chat's tools only while VOICE_TOOLS_ENABLED is on", async () => {
  reset();
  signedIn = { id: OWNER };
  process.env.VOICE_RELAY_URL = "ws://127.0.0.1:9";
  const call = () => relayToken.GET(new Request(`http://x/api/voice/relay-token?tools=1&connectors=gcal&conversationId=${CHAT}`));
  delete process.env.VOICE_TOOLS_ENABLED;
  assert.equal((await call()).status, 200);
  const off = JSON.parse(lastToken!) as Record<string, unknown>;
  assert.equal(off.tl, undefined, "off (the default): no tools claim");
  assert.equal(off.cx, undefined);
  process.env.VOICE_TOOLS_ENABLED = "1";
  try {
    assert.equal((await call()).status, 200);
    const on = JSON.parse(lastToken!) as Record<string, unknown>;
    assert.equal(on.tl, 1);
    assert.equal(on.cid, CHAT);
    assert.deepEqual(on.cx, ["gcal"]);
  } finally {
    delete process.env.VOICE_TOOLS_ENABLED;
  }
});
