import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * Session recall against real PostgreSQL: blind-token indexing, full-history
 * search, account and project isolation, edits, deletes and key rotation.
 * Opt in with a disposable, migrated loopback database:
 *
 *   MEMORY_TEST_DATABASE_URL=postgresql://juno@127.0.0.1:54329/juno_memory_test \
 *   npx tsx --test tests/recall-index-db.test.ts
 */
const DB_URL = process.env.MEMORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("session recall database suite requires MEMORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  const url = new URL(DB_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Session recall tests require a loopback PostgreSQL host.");
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  const keyA = randomBytes(32).toString("base64");
  const keyB = randomBytes(32).toString("base64");
  process.env.DATA_ENCRYPTION_KEYRING = `k1:${keyA}`;
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = "k1";
  delete process.env.DATA_ENCRYPTION_KEY;
  process.env.AUTH_SECRET ??= "recall-index-local-test";
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  const load = async () => {
    const crypto = await import("@/lib/message-crypto");
    const keys = await import("@/lib/recall/keys");
    const service = await import("@/lib/recall/service");
    const deps = {
      run: <T,>(statement: Parameters<typeof prisma.$queryRaw>[0]) => prisma.$queryRaw(statement) as Promise<T[]>,
      decrypt: crypto.decryptMessageTextSafe,
      hasher: keys.recallHasher,
      activeKeyId: keys.recallActiveKeyId,
      unreadable: "[message could not be decrypted]",
    } as import("@/lib/recall/service").RecallDeps;
    return { crypto, keys, service, deps };
  };

  test("full-history recall finds the decision behind sixty newer chats, scoped to its account and project", async (t) => {
    const { crypto, service, deps } = await load();
    const suffix = randomUUID();
    const owner = await prisma.user.create({ data: { email: `recall-${suffix}@example.invalid` } });
    const other = await prisma.user.create({ data: { email: `recall-other-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    });
    const project = await prisma.project.create({ data: { userId: owner.id, name: "Orbit" } });
    const old = new Date(Date.now() - 200 * 86_400_000);
    const decision = await prisma.conversation.create({
      data: { userId: owner.id, projectId: project.id, title: "Permissions review", lastMessageAt: old, createdAt: old },
    });
    const answer = await prisma.message.create({
      data: {
        conversationId: decision.id,
        role: "ASSISTANT",
        content: crypto.encryptMessageText("We decided Orbit agents must ask before sending email, and never inherit private memory."),
        createdAt: old,
      },
    });
    // Sixty newer chats push it far outside the old 50-chat scan window.
    for (let i = 0; i < 60; i++) {
      const at = new Date(Date.now() - (100 - i) * 86_400_000);
      const c = await prisma.conversation.create({ data: { userId: owner.id, title: `Routine ${i}`, lastMessageAt: at } });
      await prisma.message.createMany({
        data: [0, 1].map((m) => ({
          conversationId: c.id,
          role: m === 0 ? ("USER" as const) : ("ASSISTANT" as const),
          content: crypto.encryptMessageText(`Grocery list ${i}: apples, bread and coffee for the week.`),
          createdAt: new Date(at.getTime() + m * 60_000),
        })),
      });
    }
    // The other account says the same words.
    const theirs = await prisma.conversation.create({ data: { userId: other.id, title: "Theirs", lastMessageAt: old } });
    await prisma.message.create({
      data: {
        conversationId: theirs.id,
        role: "USER",
        content: crypto.encryptMessageText("Orbit agents permissions: we decided they may send email freely."),
        createdAt: old,
      },
    });

    // Index both accounts fully, in bounded passes.
    for (const userId of [owner.id, other.id]) {
      for (let pass = 0; pass < 10; pass++) {
        const { indexed } = await service.indexPendingMessages(deps, userId, { limit: 50 });
        if (indexed === 0) break;
      }
      assert.equal(await service.pendingRecallCount(deps, userId), 0);
    }

    // No word is stored: no token equals any plaintext word, and the same word
    // is a different token in the two accounts.
    const mine = await prisma.messageRecallIndex.findUnique({ where: { messageId: answer.id } });
    assert.ok(mine && mine.tokens.length > 5);
    for (const token of mine!.tokens) {
      assert.match(token, /^[A-Za-z0-9_-]{16}$/);
      assert.ok(!/orbit|email|memory|decided/i.test(token));
    }
    const theirsRow = await prisma.messageRecallIndex.findFirst({ where: { userId: other.id } });
    assert.ok(theirsRow);
    assert.equal(mine!.tokens.filter((tok) => theirsRow!.tokens.includes(tok)).length, 0);

    const found = await service.searchRecall(deps, {
      userId: owner.id,
      query: "What did we decide about Orbit permissions?",
      projectId: null,
      since: null,
      limit: 5,
    });
    assert.equal(found.hits[0]?.messageId, answer.id, "the actual past message, not a summary");
    assert.equal(found.hits[0]?.conversationId, decision.id);
    assert.ok(found.hits.every((hit) => hit.conversationId !== theirs.id), "never another account's message");
    assert.equal(found.pending, 0);

    // Project scope: inside another project it is not found; inside its own it is.
    const otherProject = await prisma.project.create({ data: { userId: owner.id, name: "Other" } });
    const scopedOut = await service.searchRecall(deps, {
      userId: owner.id, query: "Orbit permissions email", projectId: otherProject.id, since: null, limit: 5,
    });
    assert.equal(scopedOut.hits.length, 0);
    const scopedIn = await service.searchRecall(deps, {
      userId: owner.id, query: "Orbit permissions email", projectId: project.id, since: null, limit: 5,
    });
    assert.equal(scopedIn.hits[0]?.messageId, answer.id);

    // The other account searching its own words finds only its own message.
    const theirSearch = await service.searchRecall(deps, {
      userId: other.id, query: "Orbit permissions email", projectId: null, since: null, limit: 5,
    });
    assert.deepEqual(theirSearch.hits.map((h) => h.conversationId), [theirs.id]);

    // An edit drops the row (the route deletes it); a re-index reads the new words.
    await prisma.message.update({ where: { id: answer.id }, data: { content: crypto.encryptMessageText("We postponed the calendar migration.") } });
    await prisma.messageRecallIndex.deleteMany({ where: { messageId: answer.id, userId: owner.id } });
    await service.indexPendingMessages(deps, owner.id, { limit: 50 });
    const afterEdit = await service.searchRecall(deps, {
      userId: owner.id, query: "Orbit permissions email", projectId: null, since: null, limit: 5,
    });
    assert.ok(afterEdit.hits.every((hit) => hit.messageId !== answer.id), "old words no longer find the edited message");
    const newWords = await service.searchRecall(deps, {
      userId: owner.id, query: "calendar migration postponed", projectId: null, since: null, limit: 5,
    });
    assert.equal(newWords.hits[0]?.messageId, answer.id);

    // Deleting a conversation deletes its index rows.
    await prisma.conversation.delete({ where: { id: decision.id } });
    assert.equal(await prisma.messageRecallIndex.count({ where: { messageId: answer.id } }), 0);
  });

  test("key rotation: old rows stay searchable and are rebuilt under the new key", async (t) => {
    const { crypto, keys, service, deps } = await load();
    const suffix = randomUUID();
    const owner = await prisma.user.create({ data: { email: `recall-rotate-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: owner.id } });
      process.env.DATA_ENCRYPTION_KEYRING = `k1:${keyA}`;
      process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = "k1";
      crypto.resetKeyringCacheForTests();
    });
    const at = new Date(Date.now() - 10 * 86_400_000);
    const c = await prisma.conversation.create({ data: { userId: owner.id, title: "Visa", lastMessageAt: at } });
    const m = await prisma.message.create({
      data: { conversationId: c.id, role: "USER", content: crypto.encryptMessageText("My visa appointment is at the Lyon consulate."), createdAt: at },
    });
    await service.indexPendingMessages(deps, owner.id, { limit: 50 });
    assert.equal((await prisma.messageRecallIndex.findUnique({ where: { messageId: m.id } }))?.keyId, "k1");

    process.env.DATA_ENCRYPTION_KEYRING = `k1:${keyA},k2:${keyB}`;
    process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = "k2";
    crypto.resetKeyringCacheForTests();
    assert.equal(keys.recallActiveKeyId(), "k2");
    assert.equal(await service.pendingRecallCount(deps, owner.id), 1, "a row under a retired key is pending");
    const before = await service.searchRecall(deps, { userId: owner.id, query: "Lyon visa", projectId: null, since: null, limit: 5 });
    assert.equal(before.hits[0]?.messageId, m.id, "still found under the old key while pending");
    await service.indexPendingMessages(deps, owner.id, { limit: 50 });
    assert.equal((await prisma.messageRecallIndex.findUnique({ where: { messageId: m.id } }))?.keyId, "k2");
    const after = await service.searchRecall(deps, { userId: owner.id, query: "Lyon visa", projectId: null, since: null, limit: 5 });
    assert.equal(after.hits[0]?.messageId, m.id);
  });

  test("unified search reaches full history through the index and says what is still pending", async (t) => {
    const { crypto, service, deps } = await load();
    const { runUnifiedSearch } = await import("@/lib/search/engine");
    const suffix = randomUUID();
    const owner = await prisma.user.create({ data: { email: `recall-unified-${suffix}@example.invalid` } });
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: owner.id } });
    });
    const old = new Date(Date.now() - 300 * 86_400_000);
    const c = await prisma.conversation.create({ data: { userId: owner.id, title: "Ledger choice", lastMessageAt: old } });
    const m = await prisma.message.create({
      data: { conversationId: c.id, role: "ASSISTANT", content: crypto.encryptMessageText("We chose Postgres with pgbouncer over DynamoDB for the ledger."), createdAt: old },
    });
    for (let i = 0; i < 55; i++) {
      const at = new Date(Date.now() - (50 - i) * 86_400_000);
      const n = await prisma.conversation.create({ data: { userId: owner.id, title: `Note ${i}`, lastMessageAt: at } });
      await prisma.message.create({ data: { conversationId: n.id, role: "USER", content: crypto.encryptMessageText(`Daily note ${i}`), createdAt: at } });
    }
    const unified = (recall: boolean) =>
      runUnifiedSearch(
        { userId: owner.id, query: "postgres dynamodb ledger", types: ["message"] },
        {
          executor: { run: (statement) => prisma.$queryRaw(statement) as Promise<never[]> },
          decryptMessage: crypto.decryptMessageTextSafe,
          ...(recall ? { recall: (request) => service.searchRecall(deps, { ...request, catchUp: 300 }) } : {}),
        }
      );
    const legacy = await unified(false);
    assert.equal(legacy.total, 0, "the bounded scan cannot see a chat older than its 50-chat window");
    assert.equal(legacy.coverage[0].state, "partial");
    const indexed = await unified(true);
    assert.equal(indexed.groups[0]?.hits[0]?.href, `/chat/${c.id}?m=${m.id}`);
    assert.equal(indexed.coverage[0].state, "complete");
  });
}
