import { Prisma } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import {
  CANCEL_KEY_PREFIX,
  cancelSignalKey,
  liveLeaseKey,
  type GenerationRef,
  type GenerationSignalStore,
} from "@/lib/chat/generation-signals";

/**
 * The Postgres side of the cross-process Stop (`chat/generation-signals.ts`).
 *
 * Rows live in `RateLimit` rather than a table of their own, on the precedent
 * of `work/notify/deliver.ts`: that table is already the schema's keyed,
 * expiring claim — a string primary key, a counter, an `expiresAt` that the
 * scheduled prune (`scripts/prune-sync.ts`, weekly by the suggested cron in
 * deploy/VM_SETUP_GUIDE.md) sweeps once it is a day past — and
 * that is the whole shape of a cancel signal and of a live lease. The primary
 * key makes a Stop idempotent with no read-then-write window, and the
 * `generation:cancel:` / `generation:live:` prefixes cannot collide with a
 * rate-limit bucket (the chat limiter's are `chat:<userId>`) or a delivery
 * record. No migration, so no schema change rides on the fix.
 *
 * A Stop can also arrive as `ChatFirstSubmissionReceipt.cancelRequestedAt`
 * (what the cancel route has always written for receipt-backed turns, and all
 * an older process writes during a rolling deploy). The poll reads both in the
 * same round trip, so neither source is ever ignored.
 *
 * Time is the DATABASE's clock, in UTC — the same convention Prisma uses when
 * it writes a `DateTime` into `timestamp(3)` — so two instances whose clocks
 * drift still agree on when a lease ran out, whatever the session time zone.
 *
 * `prismaUnguarded` because the pump is the process asking about every
 * generation it holds, across accounts; ownership is carried in every key
 * (and re-checked by the pump against what it holds), never inferred.
 *
 * Not `server-only`, like chat-stream-log-store.ts: a script can drive it.
 */

const NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

function ttl(ms: number): Prisma.Sql {
  const bounded = Math.max(1, Math.round(ms));
  return Prisma.sql`(${`${bounded} milliseconds`})::interval`;
}

function uniqueKeys(refs: readonly GenerationRef[], key: (ref: GenerationRef) => string): string[] {
  return [...new Set(refs.map(key))];
}

export const prismaGenerationSignalStore: GenerationSignalStore = {
  async requestCancel(ref, ttlMs) {
    // A repeat Stop counts (diagnostics) and never shortens the window; a row
    // left behind by an earlier, expired signal is refreshed in place.
    await prismaUnguarded.$executeRaw(Prisma.sql`
      INSERT INTO "RateLimit" ("key", "count", "expiresAt")
      VALUES (${cancelSignalKey(ref)}, 1, ${NOW_UTC} + ${ttl(ttlMs)})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = "RateLimit"."count" + 1,
        "expiresAt" = GREATEST("RateLimit"."expiresAt", EXCLUDED."expiresAt")
    `);
  },

  async pendingCancels(refs) {
    if (refs.length === 0) return [];
    const keys = uniqueKeys(refs, cancelSignalKey);
    const generationIds = [...new Set(refs.map((ref) => ref.generationId))];
    const rows = await prismaUnguarded.$queryRaw<Array<{ key: string }>>(Prisma.sql`
      SELECT "key" FROM "RateLimit"
      WHERE "key" = ANY(${keys}::text[]) AND "expiresAt" > ${NOW_UTC}
      UNION
      SELECT ${CANCEL_KEY_PREFIX} || "userId" || ':' || "generationId" AS "key"
      FROM "ChatFirstSubmissionReceipt"
      WHERE "generationId" = ANY(${generationIds}::text[]) AND "cancelRequestedAt" IS NOT NULL
    `);
    const found = new Set(rows.map((row) => row.key));
    // Matched back by full key, so a receipt for the same generation id under
    // another owner can never cancel this one.
    return refs.filter((ref) => found.has(cancelSignalKey(ref)));
  },

  async renewLive(refs, ttlMs) {
    if (refs.length === 0) return;
    // De-duplicated: ON CONFLICT DO UPDATE refuses to touch one row twice in a statement.
    const keys = uniqueKeys(refs, liveLeaseKey);
    await prismaUnguarded.$executeRaw(Prisma.sql`
      INSERT INTO "RateLimit" ("key", "count", "expiresAt")
      SELECT k, 1, ${NOW_UTC} + ${ttl(ttlMs)} FROM unnest(${keys}::text[]) AS k
      ON CONFLICT ("key") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt"
    `);
  },

  async isLive(ref) {
    const rows = await prismaUnguarded.$queryRaw<Array<{ live: number }>>(Prisma.sql`
      SELECT 1 AS "live" FROM "RateLimit"
      WHERE "key" = ${liveLeaseKey(ref)} AND "expiresAt" > ${NOW_UTC}
      LIMIT 1
    `);
    return rows.length > 0;
  },

  async releaseLive(refs) {
    if (refs.length === 0) return;
    await prismaUnguarded.rateLimit.deleteMany({ where: { key: { in: uniqueKeys(refs, liveLeaseKey) } } });
  },
};
