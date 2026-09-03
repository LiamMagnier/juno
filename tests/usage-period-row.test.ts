/**
 * The usage period row's "ensure it exists" upsert under concurrency.
 *
 * `consumeMessage` upserts a `(userId, period)` row before incrementing it.
 * Two concurrent turns from the same account with no row yet — a new month, a
 * new account, or the E2E suite's two parallel workers — both run the same
 * INSERT, and the loser used to surface P2002 as a 500 for a chat whose only
 * sin was starting at the same time as its neighbour. That failure is exactly
 * what the e2e sidebar/regenerate specs hit: one worker's POST /api/chat died
 * on it and no assistant reply ever rendered.
 *
 * Prisma cannot translate this compound-unique upsert into a native
 * INSERT … ON CONFLICT, so the race is handled at the call site. These tests
 * pin the two halves of that handling with a fake executor — the swallowing of
 * the constraint error (the winner created the row; that is all the upsert
 * wanted) and the rethrow of everything else (a real failure must still fail).
 * `@/lib/usage` constructs the real Prisma client on import, so a placeholder
 * DATABASE_URL is set first and the module is imported lazily inside the tests
 * (`tsx --test` compiles to CJS, so top-level await is not available).
 */
process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:5/placeholder";

import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

import type { ensureUsageRow } from "@/lib/usage";

let ensure: typeof ensureUsageRow;
test.before(async () => {
  ({ ensureUsageRow: ensure } = await import("@/lib/usage"));
});

function executorThatThrows(error: unknown) {
  return {
    usage: {
      upsert: async () => {
        throw error;
      },
    },
  };
}

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

test("a lost upsert race (P2002) resolves instead of failing the turn", async () => {
  await assert.doesNotReject(() => ensure(executorThatThrows(uniqueConstraintError()), "user", "2026-09"));
});

test("any other failure from the upsert still propagates", async () => {
  await assert.rejects(
    () => ensure(executorThatThrows(new Error("Connection refused")), "user", "2026-09"),
    /Connection refused/
  );
  // A unique violation on some other constraint is not this race and must not
  // be eaten by the handler.
  const otherConstraint = new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
    code: "P2003",
    clientVersion: "test",
  });
  await assert.rejects(() => ensure(executorThatThrows(otherConstraint), "user", "2026-09"));
});

test("a successful upsert passes straight through", async () => {
  let called = 0;
  const executor = {
    usage: {
      upsert: async (args: { where: { userId_period: { userId: string; period: string } } }) => {
        called += 1;
        assert.equal(args.where.userId_period.period, "2026-09");
        return {};
      },
    },
  };
  await ensure(executor, "user", "2026-09");
  assert.equal(called, 1);
});
