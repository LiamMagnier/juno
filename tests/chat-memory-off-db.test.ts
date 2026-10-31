import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * "Memory off for this chat" (src/lib/chat/memory-off.ts) against real
 * PostgreSQL: the toggle route through the guarded client, the cover it writes
 * when memory comes back, and the background reader's own queries
 * (pendingBackfill, queueRereads, the dreamer's account sweep) as the
 * database answers them. The unit seams are tests/chat-memory-off*.test.ts.
 *
 *   MEMORY_OFF_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/chat-memory-off-db.test.ts
 */
const DB_URL = process.env.MEMORY_OFF_TEST_DATABASE_URL;

if (!DB_URL) {
  test("memory off database suite requires MEMORY_OFF_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "memory-off-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn } });

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const patch = (memoryOff: unknown) =>
    new Request("http://x/api/conversations/c/memory", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memoryOff }),
    });

  test("the switch is saved owner-scoped, every background query skips the chat, and back on covers it as read", async (t) => {
    const { GET, PATCH } = await import("@/app/api/conversations/[id]/memory/route");
    const { pendingBackfill, queueRereads } = await import("@/lib/memory");
    const { findAccountsToDream } = await import("@/lib/memory-dreamer");
    const { EXTRACTOR_VERSION } = await import("@/lib/memory-extraction");
    const suffix = randomUUID();
    const owner = await prisma.user.create({ data: { email: `memoff-a-${suffix}@example.invalid` } });
    const other = await prisma.user.create({ data: { email: `memoff-b-${suffix}@example.invalid` } });
    const solo = await prisma.user.create({ data: { email: `memoff-c-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id, solo.id] } } });
    });
    const said = new Date(Date.now() - 60_000);
    const kept = await prisma.conversation.create({ data: { userId: owner.id, title: "Kept out", lastMessageAt: said } });
    const plain = await prisma.conversation.create({ data: { userId: owner.id, title: "Ordinary", lastMessageAt: said } });
    // An account whose only unread chat is kept out of memory.
    await prisma.conversation.create({ data: { userId: solo.id, title: "Only one", lastMessageAt: said, memoryOff: true } });

    // Someone else cannot read or flip it.
    signedIn = { id: other.id };
    assert.equal((await GET(new Request("http://x"), params(kept.id))).status, 404);
    assert.equal((await PATCH(patch(true), params(kept.id))).status, 404);
    assert.equal((await prisma.conversation.findUnique({ where: { id: kept.id } }))?.memoryOff, false);

    signedIn = { id: owner.id };
    assert.equal((await PATCH(patch("off"), params(kept.id))).status, 400);
    const off = await PATCH(patch(true), params(kept.id));
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { memoryOff: true, accountMemory: true });
    assert.equal((await prisma.conversation.findUnique({ where: { id: kept.id } }))?.memoryOff, true);
    assert.equal(await prisma.conversationMemory.count({ where: { conversationId: kept.id } }), 0);

    // The background reader's own queries, as Postgres answers them.
    assert.deepEqual(await pendingBackfill(owner.id), [plain.id]);
    assert.equal(await queueRereads(owner.id, 5), 0);
    const dreamable = await findAccountsToDream(10_000);
    assert.ok(dreamable.includes(owner.id), "the account still has an ordinary chat to read");
    assert.ok(!dreamable.includes(solo.id), "an account with nothing but a kept-out chat is not visited");

    // Back on: what was said meanwhile is covered as read, by the current reader.
    const on = await PATCH(patch(false), params(kept.id));
    assert.deepEqual(await on.json(), { memoryOff: false, accountMemory: true });
    const cover = await prisma.conversationMemory.findUnique({ where: { conversationId: kept.id } });
    assert.ok(cover);
    assert.equal(cover.userId, owner.id);
    assert.equal(cover.processedAt.getTime(), said.getTime());
    assert.equal(cover.extractorVersion, EXTRACTOR_VERSION);
    assert.deepEqual(await pendingBackfill(owner.id), [plain.id], "and nothing of it is pending");

    // A Code session has no such switch.
    const code = await prisma.conversation.create({ data: { userId: owner.id, title: "Code", kind: "code" } });
    assert.equal((await PATCH(patch(true), params(code.id))).status, 404);
  });

  test.after(async () => {
    await prisma.$disconnect();
  });
}
