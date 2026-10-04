import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import {
  REFERRAL_CREDIT_EUR,
  availableCreditMicroUsd,
  creditEurToMicroUsd,
  creditExpiry,
  creditShortfall,
  generateReferralCode,
  normalizeReferralCode,
  planCreditDraws,
  referralVerdict,
  type CreditLot,
} from "@/lib/credits";

/**
 * The I/O behind usage credits, referrals and the renewal-notice log.
 *
 * Every statement here is raw SQL on purpose. The tables are new (migration
 * 20261004180000_usage_credits_referrals) and this module must compile and run
 * against a Prisma client generated before them; raw SQL needs no generated
 * delegate. It also keeps the draw — the one place money moves between rows —
 * in explicit row locks where it can be read.
 *
 * The decisions (how much, which lot, whether a referral pays) are in
 * src/lib/credits.ts and tested there. This file only reads and writes.
 *
 * Unguarded client: the callers are the Stripe webhook (keyed by customer id),
 * the renewal sweep, and request paths that pass the signed-in user's own id —
 * every statement below is scoped by that userId explicitly.
 */

const db = prismaUnguarded;

export type CreditSource = "topup" | "referral" | "admin";

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export interface PeriodCredit {
  /** Credit this period has already drawn (spend above the plan budget). */
  drawnMicroUsd: number;
  /** Unexpired credit still left across all lots. */
  availableMicroUsd: number;
}

/** What credit adds to this period's ceiling. One round trip. */
export async function readPeriodCredit(userId: string, periodKey: string, now = new Date()): Promise<PeriodCredit> {
  const rows = await db.$queryRaw<Array<{ drawn: bigint | null; available: bigint | null }>>(Prisma.sql`
    SELECT
      (SELECT "creditDrawnMicroUsd" FROM "SpendPeriod"
        WHERE "userId" = ${userId} AND "period" = ${periodKey}) AS drawn,
      (SELECT COALESCE(SUM("remainingMicroUsd"), 0)::bigint FROM "UsageCredit"
        WHERE "userId" = ${userId} AND "expiresAt" > ${now} AND "remainingMicroUsd" > 0) AS available
  `);
  const row = rows[0];
  return {
    drawnMicroUsd: Number(row?.drawn ?? 0n),
    availableMicroUsd: Number(row?.available ?? 0n),
  };
}

/**
 * Add a credit lot. Idempotent on `idempotencyKey` (the Checkout Session id for
 * a top-up, `referral:<id>:<side>` for a referral): a redelivered webhook
 * inserts nothing and returns false.
 */
export async function grantCredit(input: {
  userId: string;
  source: CreditSource;
  amountMicroUsd: number;
  idempotencyKey: string;
  note?: string | null;
  now?: Date;
}): Promise<boolean> {
  const amount = BigInt(Math.max(0, Math.round(input.amountMicroUsd)));
  if (amount === 0n) return false;
  const now = input.now ?? new Date();
  const inserted = await db.$executeRaw(Prisma.sql`
    INSERT INTO "UsageCredit"
      ("id", "userId", "source", "amountMicroUsd", "remainingMicroUsd", "expiresAt", "stripeId", "note", "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${input.userId}, ${input.source}, ${amount}, ${amount}, ${creditExpiry(now)},
       ${input.idempotencyKey}, ${input.note ?? null}, ${now}, ${now})
    ON CONFLICT ("stripeId") DO NOTHING
  `);
  return inserted > 0;
}

/**
 * Charge this period's spend above the plan budget to credit lots.
 *
 * Called after every settled spend. The SpendPeriod row is locked for the
 * duration, so two settles racing cannot both see the same shortfall and draw
 * it twice; the lots are locked too, so a concurrent draw from another period
 * cannot overspend a lot. Never throws (the caller is fire-and-forget).
 */
export async function drawCreditsForPeriod(input: {
  userId: string;
  periodKey: string;
  planBudgetMicroUsd: number;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  try {
    return await db.$transaction(async (tx) => {
      const periods = await tx.$queryRaw<Array<{ id: string; committed: bigint; drawn: bigint }>>(Prisma.sql`
        SELECT "id", "committedMicroUsd" AS committed, "creditDrawnMicroUsd" AS drawn
          FROM "SpendPeriod"
         WHERE "userId" = ${input.userId} AND "period" = ${input.periodKey}
         FOR UPDATE
      `);
      const period = periods[0];
      if (!period) return 0;
      const need = creditShortfall({
        committedMicroUsd: Number(period.committed),
        planBudgetMicroUsd: input.planBudgetMicroUsd,
        drawnMicroUsd: Number(period.drawn),
      });
      if (need <= 0) return 0;

      const lots = await tx.$queryRaw<Array<{ id: string; remaining: bigint; expiresAt: Date }>>(Prisma.sql`
        SELECT "id", "remainingMicroUsd" AS remaining, "expiresAt"
          FROM "UsageCredit"
         WHERE "userId" = ${input.userId} AND "expiresAt" > ${now} AND "remainingMicroUsd" > 0
         ORDER BY "expiresAt" ASC, "id" ASC
         FOR UPDATE
      `);
      const plan = planCreditDraws(
        lots.map((l): CreditLot => ({
          id: l.id,
          remainingMicroUsd: Number(l.remaining),
          expiresAtMs: l.expiresAt.getTime(),
        })),
        need,
        now.getTime()
      );
      if (plan.drawnMicroUsd <= 0) return 0;
      for (const draw of plan.draws) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "UsageCredit"
             SET "remainingMicroUsd" = GREATEST("remainingMicroUsd" - ${BigInt(draw.amountMicroUsd)}, 0),
                 "updatedAt" = ${now}
           WHERE "id" = ${draw.id} AND "userId" = ${input.userId}
        `);
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE "SpendPeriod"
           SET "creditDrawnMicroUsd" = "creditDrawnMicroUsd" + ${BigInt(plan.drawnMicroUsd)},
               "updatedAt" = ${now}
         WHERE "id" = ${period.id} AND "userId" = ${input.userId}
      `);
      return plan.drawnMicroUsd;
    });
  } catch (err) {
    console.error("[credits] draw failed", {
      userId: input.userId,
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export interface CreditSummary {
  availableMicroUsd: number;
  /** The soonest expiry among lots that still hold credit, epoch ms. */
  nextExpiryMs: number | null;
  lots: Array<{
    source: CreditSource;
    amountMicroUsd: number;
    remainingMicroUsd: number;
    expiresAtMs: number;
    createdAtMs: number;
  }>;
}

/** The account's credit lots, newest first, for the billing card. */
export async function creditSummary(userId: string, now = new Date()): Promise<CreditSummary> {
  const rows = await db.$queryRaw<
    Array<{ id: string; source: string; amount: bigint; remaining: bigint; expiresAt: Date; createdAt: Date }>
  >(Prisma.sql`
    SELECT "id", "source", "amountMicroUsd" AS amount, "remainingMicroUsd" AS remaining, "expiresAt", "createdAt"
      FROM "UsageCredit"
     WHERE "userId" = ${userId}
     ORDER BY "createdAt" DESC
     LIMIT 50
  `);
  const lots = rows.map((r) => ({
    id: r.id,
    remainingMicroUsd: Number(r.remaining),
    expiresAtMs: r.expiresAt.getTime(),
  }));
  const live = lots.filter((l) => l.expiresAtMs > now.getTime() && l.remainingMicroUsd > 0);
  return {
    availableMicroUsd: availableCreditMicroUsd(lots, now.getTime()),
    nextExpiryMs: live.length ? Math.min(...live.map((l) => l.expiresAtMs)) : null,
    lots: rows.map((r) => ({
      source: (r.source as CreditSource) ?? "admin",
      amountMicroUsd: Number(r.amount),
      remainingMicroUsd: Number(r.remaining),
      expiresAtMs: r.expiresAt.getTime(),
      createdAtMs: r.createdAt.getTime(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

/** The account's code, minted on first ask. Retries a (vanishingly rare) collision. */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await db.$queryRaw<Array<{ code: string }>>(Prisma.sql`
    SELECT "code" FROM "ReferralCode" WHERE "userId" = ${userId} LIMIT 1
  `);
  if (existing[0]) return existing[0].code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode((n) => randomBytes(n));
    const inserted = await db.$executeRaw(Prisma.sql`
      INSERT INTO "ReferralCode" ("id", "userId", "code", "createdAt")
      VALUES (${randomUUID()}, ${userId}, ${code}, now())
      ON CONFLICT DO NOTHING
    `);
    if (inserted > 0) return code;
    // Either this user won a race (read it back) or the code collided (retry).
    const again = await db.$queryRaw<Array<{ code: string }>>(Prisma.sql`
      SELECT "code" FROM "ReferralCode" WHERE "userId" = ${userId} LIMIT 1
    `);
    if (again[0]) return again[0].code;
  }
  throw new Error("Could not mint a referral code.");
}

/**
 * Link a new account to the code it signed up with. Best-effort and silent: a
 * bad code, an own code or a second attempt simply records nothing. The
 * self-referral test is repeated at reward time against the paying customer.
 */
export async function attachReferral(referredUserId: string, rawCode: unknown): Promise<boolean> {
  const code = normalizeReferralCode(rawCode);
  if (!code) return false;
  try {
    const owners = await db.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
      SELECT "userId" FROM "ReferralCode" WHERE "code" = ${code} LIMIT 1
    `);
    const referrerId = owners[0]?.userId;
    if (!referrerId || referrerId === referredUserId) return false;
    const inserted = await db.$executeRaw(Prisma.sql`
      INSERT INTO "Referral" ("id", "referrerId", "referredUserId", "code", "status", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${referrerId}, ${referredUserId}, ${code}, 'pending', now(), now())
      ON CONFLICT ("referredUserId") DO NOTHING
    `);
    return inserted > 0;
  } catch (err) {
    console.error("[referrals] attach failed", { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export interface ReferralStats {
  rewarded: number;
  pending: number;
}

export async function referralStats(userId: string): Promise<ReferralStats> {
  const rows = await db.$queryRaw<Array<{ status: string; n: number }>>(Prisma.sql`
    SELECT "status", COUNT(*)::int AS n FROM "Referral" WHERE "referrerId" = ${userId} GROUP BY "status"
  `);
  const of = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { rewarded: of("rewarded"), pending: of("pending") };
}

/**
 * Reward a referral on the referred account's first paid subscription invoice.
 *
 * Idempotent three ways: the Referral row moves out of "pending" under a
 * conditional UPDATE (so one invoice wins), and each credit is keyed
 * `referral:<id>:referrer|referred` (so a retried grant is a no-op). Returns
 * what happened, for the webhook log.
 */
export async function rewardReferralForPayment(input: {
  referredUserId: string;
  stripeInvoiceId: string;
  amountPaidCents: number;
  eurPerUsd: number;
  now?: Date;
}): Promise<"none" | "rewarded" | "rejected"> {
  const now = input.now ?? new Date();
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      referrerId: string;
      status: string;
      referrerEmail: string;
      referredEmail: string;
      referrerCustomer: string | null;
      referredCustomer: string | null;
    }>
  >(Prisma.sql`
    SELECT r."id", r."referrerId", r."status",
           ru."email" AS "referrerEmail", du."email" AS "referredEmail",
           rs."stripeCustomerId" AS "referrerCustomer", ds."stripeCustomerId" AS "referredCustomer"
      FROM "Referral" r
      JOIN "User" ru ON ru."id" = r."referrerId"
      JOIN "User" du ON du."id" = r."referredUserId"
      LEFT JOIN "Subscription" rs ON rs."userId" = r."referrerId"
      LEFT JOIN "Subscription" ds ON ds."userId" = r."referredUserId"
     WHERE r."referredUserId" = ${input.referredUserId}
     LIMIT 1
  `);
  const ref = rows[0];
  if (!ref || ref.status !== "pending") return "none";

  const counted = await db.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS n FROM "Referral" WHERE "referrerId" = ${ref.referrerId} AND "status" = 'rewarded'
  `);
  const verdict = referralVerdict({
    alreadyRewarded: false,
    referrerEmail: ref.referrerEmail,
    referredEmail: ref.referredEmail,
    referrerCustomerId: ref.referrerCustomer,
    referredCustomerId: ref.referredCustomer,
    referrerRewardedCount: counted[0]?.n ?? 0,
    amountPaidCents: input.amountPaidCents,
  });

  if (!verdict.reward) {
    // A zero-amount invoice (a 100% promo) leaves the referral pending so the
    // first real payment can still reward it; every other refusal is final.
    if (verdict.reason === "not_paid") return "none";
    await db.$executeRaw(Prisma.sql`
      UPDATE "Referral" SET "status" = 'rejected', "reason" = ${verdict.reason}, "stripeInvoiceId" = ${input.stripeInvoiceId}, "updatedAt" = ${now}
       WHERE "id" = ${ref.id} AND "status" = 'pending'
    `);
    return "rejected";
  }

  const won = await db.$executeRaw(Prisma.sql`
    UPDATE "Referral" SET "status" = 'rewarded', "rewardedAt" = ${now}, "stripeInvoiceId" = ${input.stripeInvoiceId}, "updatedAt" = ${now}
     WHERE "id" = ${ref.id} AND "status" = 'pending'
  `);
  if (won === 0) return "none";
  const amount = creditEurToMicroUsd(REFERRAL_CREDIT_EUR, input.eurPerUsd);
  await grantCredit({
    userId: ref.referrerId,
    source: "referral",
    amountMicroUsd: amount,
    idempotencyKey: `referral:${ref.id}:referrer`,
    note: "Referral reward",
    now,
  });
  await grantCredit({
    userId: input.referredUserId,
    source: "referral",
    amountMicroUsd: amount,
    idempotencyKey: `referral:${ref.id}:referred`,
    note: "Welcome reward",
    now,
  });
  return "rewarded";
}

// ---------------------------------------------------------------------------
// Renewal reminders
// ---------------------------------------------------------------------------

/**
 * Claim the reminder for one subscription period. True means this caller owns
 * the send; false means it went out already (or another worker has it).
 */
export async function claimRenewalReminder(input: {
  userId: string;
  stripeSubscriptionId: string;
  periodEnd: Date;
}): Promise<boolean> {
  const inserted = await db.$executeRaw(Prisma.sql`
    INSERT INTO "RenewalReminder" ("id", "userId", "stripeSubscriptionId", "periodEnd", "sentAt")
    VALUES (${randomUUID()}, ${input.userId}, ${input.stripeSubscriptionId}, ${input.periodEnd}, now())
    ON CONFLICT ("stripeSubscriptionId", "periodEnd") DO NOTHING
  `);
  return inserted > 0;
}

/** Give a claim back after a failed send, so the next sweep retries it. */
export async function releaseRenewalReminder(stripeSubscriptionId: string, periodEnd: Date): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    DELETE FROM "RenewalReminder" WHERE "stripeSubscriptionId" = ${stripeSubscriptionId} AND "periodEnd" = ${periodEnd}
  `);
}
