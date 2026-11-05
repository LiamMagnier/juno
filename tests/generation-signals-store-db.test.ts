import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * The Postgres side of the cross-process Stop (src/lib/chat/generation-signals-store.ts)
 * against a real database: idempotent cancel rows, owner scoping, expiry on
 * the database clock in UTC, batched lease renewal, and the receipt flag read
 * in the same round trip.
 *
 * Skipped unless GENERATION_SIGNALS_TEST_DATABASE_URL names a throwaway,
 * migrated local database (it never falls back to DATABASE_URL):
 *   GENERATION_SIGNALS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/juno_signals_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test tests/generation-signals-store-db.test.ts
 *
 * Worth running with the server's TimeZone set to something other than UTC:
 * the store must agree with Prisma's own UTC `DateTime` writes regardless.
 */

const DB_URL = process.env.GENERATION_SIGNALS_TEST_DATABASE_URL;

if (!DB_URL) {
  test("generation signal store suite is skipped without GENERATION_SIGNALS_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(DB_URL, /^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/[a-z0-9_]+$/, "only an explicit local disposable database");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const load = () => import("@/lib/chat/generation-signals-store").then((m) => m.prismaGenerationSignalStore);
  const keys = () => import("@/lib/chat/generation-signals");

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const ref = (userId = `cl${randomUUID().replace(/-/g, "").slice(0, 20)}`) => ({ userId, generationId: `gen-${randomUUID()}` });

  test("a Stop is one row however often it is pressed, expiring on the database clock in UTC", async () => {
    const store = await load();
    const { cancelSignalKey } = await keys();
    const r = ref();
    const before = Date.now();
    await Promise.all([store.requestCancel(r, 60_000), store.requestCancel(r, 60_000), store.requestCancel(r, 60_000)]);
    const rows = await prisma.rateLimit.findMany({ where: { key: cancelSignalKey(r) } });
    assert.equal(rows.length, 1, "concurrent Stops race to one row");
    assert.equal(rows[0].count, 3);
    // Read back through Prisma, which treats the column as UTC: the expiry is
    // a minute from now, not a minute from now shifted by the server's zone.
    const ms = rows[0].expiresAt.getTime() - before;
    assert.ok(ms > 55_000 && ms < 70_000, `expiresAt is ~60s ahead in UTC (was ${ms}ms)`);
  });

  test("pendingCancels: owner-scoped, batched, and blind to expired rows", async () => {
    const store = await load();
    const mine = ref();
    const theirs = { userId: `${mine.userId}x`, generationId: mine.generationId };
    const quiet = ref();
    const expired = ref();
    await store.requestCancel(mine, 60_000);
    await store.requestCancel(expired, 1);
    await sleep(30);
    const pending = await store.pendingCancels([mine, theirs, quiet, expired]);
    assert.deepEqual(pending, [mine]);
    assert.deepEqual(await store.pendingCancels([]), []);

    // A fresh Stop on an expired row refreshes it in place.
    await store.requestCancel(expired, 60_000);
    assert.deepEqual(await store.pendingCancels([expired]), [expired]);
  });

  test("the receipt flag is a Stop too, read in the same round trip, for its owner only", async () => {
    const store = await load();
    const user = await prisma.user.create({ data: { email: `signals-${randomUUID()}@example.invalid`, name: "Signals" } });
    const generationId = `gen-${randomUUID()}`;
    await prisma.chatFirstSubmissionReceipt.create({
      data: {
        userId: user.id,
        clientRequestId: `req-${randomUUID()}`,
        clientMessageId: `msg-${randomUUID()}`,
        requestHash: "hash",
        generationId,
        state: "running",
        conversationId: "conversation",
        userMessageId: "message",
        cancelRequestedAt: new Date(),
      },
    });
    assert.deepEqual(await store.pendingCancels([{ userId: user.id, generationId }]), [{ userId: user.id, generationId }]);
    assert.deepEqual(await store.pendingCancels([{ userId: "someone-else", generationId }]), []);
  });

  test("leases: one write renews many (duplicates tolerated), release drops them, expiry ends them", async () => {
    const store = await load();
    const a = ref();
    const b = ref(a.userId);
    await store.renewLive([a, b, a], 60_000);
    assert.equal(await store.isLive(a), true);
    assert.equal(await store.isLive(b), true);
    assert.equal(await store.isLive({ userId: "intruder", generationId: a.generationId }), false, "owner-scoped");

    await store.releaseLive([a]);
    assert.equal(await store.isLive(a), false);
    assert.equal(await store.isLive(b), true);

    await store.renewLive([b], 1);
    await sleep(30);
    assert.equal(await store.isLive(b), false, "a lease nobody renews runs out");
  });

  test("rows are swept by the existing RateLimit prune (expiresAt is comparable to a JS Date)", async () => {
    const store = await load();
    const { liveLeaseKey } = await keys();
    const r = ref();
    await store.renewLive([r], 1);
    await sleep(30);
    // The prune deletes `expiresAt < cutoff` with a JS Date; an expired lease
    // must fall on the right side of "now".
    const stale = await prisma.rateLimit.count({ where: { key: liveLeaseKey(r), expiresAt: { lt: new Date() } } });
    assert.equal(stale, 1);
  });

  test("disconnect", async () => {
    const { prismaUnguarded } = await import("@/lib/prisma");
    await prismaUnguarded.$disconnect();
    await prisma.$disconnect();
  });
}
