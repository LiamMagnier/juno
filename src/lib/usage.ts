import { Prisma, type Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PLANS } from "@/lib/plans";
import { currentPeriod } from "@/lib/utils";
import { isOwnerEmail } from "@/lib/owner";

/**
 * Swallow the unique-constraint race on the period row's first insert. Two
 * concurrent turns for an account with no usage row yet (new month, new
 * account, web + app in parallel) both run the same "ensure the row exists"
 * upsert; the loser surfaces P2002, which is not an error here — the winner
 * created exactly the row the upsert was for. Prisma cannot promise an atomic
 * upsert for this compound-unique shape, so the race is handled instead of
 * 500-ing the chat that lost it. Exported because the whole point is a race
 * only a concurrent caller can trigger: tests/usage-period-row.test.ts
 * characterizes it with a fake executor, since no test database exists under
 * `npm test`.
 *
 * The executor parameter is a minimal structural shape (rather than
 * `Prisma.TransactionClient`) so the fake executors in that test satisfy it
 * too — the real client and transaction handles are assignable to it.
 */
type UsageUpsertExecutor = {
  usage: {
    upsert: (args: {
      where: { userId_period: { userId: string; period: string } };
      create: { userId: string; period: string; messageCount: number };
      update: Record<string, never>;
    }) => Promise<unknown>;
  };
};

export async function ensureUsageRow(
  executor: UsageUpsertExecutor,
  userId: string,
  period: string
): Promise<void> {
  try {
    await executor.usage.upsert({
      where: { userId_period: { userId, period } },
      create: { userId, period, messageCount: 0 },
      update: {},
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
  }
}

export interface QuotaStatus {
  plan: Plan;
  used: number;
  limit: number | null; // null = unlimited
  remaining: number | null;
}

export async function getUserPlan(userId: string): Promise<Plan> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, subscription: { select: { plan: true, status: true } } },
  });
  if (!user) return "FREE";
  // Owner accounts (OWNER_EMAILS) get unlimited access regardless of billing.
  if (isOwnerEmail(user.email)) return "OWNER";
  const sub = user.subscription;
  if (!sub) return "FREE";
  // Only entitle paid features while the subscription is actually paying.
  return sub.status === "ACTIVE" || sub.status === "TRIALING" ? sub.plan : "FREE";
}

export async function getQuota(userId: string, plan?: Plan): Promise<QuotaStatus> {
  const p = plan ?? (await getUserPlan(userId));
  const usage = await prisma.usage.findUnique({
    where: { userId_period: { userId, period: currentPeriod() } },
  });
  const used = usage?.messageCount ?? 0;
  const limit = PLANS[p].monthlyMessages;
  return { plan: p, used, limit, remaining: limit == null ? null : Math.max(0, limit - used) };
}

/** Atomically checks the monthly cap and, if allowed, consumes one message. */
export async function consumeMessage(
  userId: string,
  plan: Plan
): Promise<{ allowed: boolean; quota: QuotaStatus }> {
  const period = currentPeriod();
  const limit = PLANS[plan].monthlyMessages;

  // Ensure the period row exists without incrementing.
  await ensureUsageRow(prisma, userId, period);

  if (limit == null) {
    // Unlimited plan: increment for accounting, never block.
    const updated = await prisma.usage.update({
      where: { userId_period: { userId, period } },
      data: { messageCount: { increment: 1 } },
    });
    return { allowed: true, quota: { plan, used: updated.messageCount, limit: null, remaining: null } };
  }

  // Single atomic conditional increment: the `messageCount < limit` guard and
  // the increment are one SQL UPDATE, so two concurrent turns can't both slip
  // past the cap (closes the check-then-increment TOCTOU race).
  const res = await prisma.usage.updateMany({
    where: { userId, period, messageCount: { lt: limit } },
    data: { messageCount: { increment: 1 } },
  });
  const row = await prisma.usage.findUnique({ where: { userId_period: { userId, period } } });
  const used = row?.messageCount ?? limit;

  if (res.count === 0) {
    return { allowed: false, quota: { plan, used, limit, remaining: 0 } };
  }
  return { allowed: true, quota: { plan, used, limit, remaining: Math.max(0, limit - used) } };
}

export interface CodeUsageReservationResult {
  allowed: boolean;
  reservationId: string | null;
  quota: QuotaStatus;
}

/**
 * Reserve one Code turn and create the opaque, single-use accounting handle in
 * the same transaction as the quota increment. The generic chat flow keeps its
 * existing counter contract; Code uses this stricter variant because its
 * desktop/runner clients report completion in a later request.
 */
export async function reserveCodeMessage(
  userId: string,
  plan: Plan,
): Promise<CodeUsageReservationResult> {
  const period = currentPeriod();
  const limit = PLANS[plan].monthlyMessages;
  return prisma.$transaction(async (tx) => {
    await ensureUsageRow(tx, userId, period);

    let used: number;
    if (limit == null) {
      const updated = await tx.usage.update({
        where: { userId_period: { userId, period } },
        data: { messageCount: { increment: 1 } },
      });
      used = updated.messageCount;
    } else {
      const updated = await tx.usage.updateMany({
        where: { userId, period, messageCount: { lt: limit } },
        data: { messageCount: { increment: 1 } },
      });
      const row = await tx.usage.findUnique({ where: { userId_period: { userId, period } } });
      used = row?.messageCount ?? limit;
      if (updated.count === 0) {
        return {
          allowed: false,
          reservationId: null,
          quota: { plan, used, limit, remaining: 0 },
        };
      }
    }

    const reservation = await tx.codeUsageReservation.create({
      data: { userId, period },
    });
    return {
      allowed: true,
      reservationId: reservation.id,
      quota: { plan, used, limit, remaining: limit == null ? null : Math.max(0, limit - used) },
    };
  });
}

export type CodeUsageReservationAction = "recorded" | "refunded";
export type CodeUsageReservationResolution =
  | "resolved"
  | "already_resolved"
  | "not_found"
  | "conflict";

/** Consume a Code reservation exactly once, with idempotent retry semantics. */
export async function resolveCodeUsageReservation(
  userId: string,
  reservationId: string,
  action: CodeUsageReservationAction,
): Promise<CodeUsageReservationResolution> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.codeUsageReservation.findFirst({ where: { id: reservationId, userId } });
    if (!existing || existing.userId !== userId) return "not_found";
    if (existing.state === action) return "already_resolved";
    if (existing.state !== "reserved") return "conflict";

    const updated = await tx.codeUsageReservation.updateMany({
      where: { id: reservationId, userId, state: "reserved" },
      data: { state: action, resolvedAt: new Date() },
    });
    if (updated.count === 0) return "conflict";

    if (action === "refunded") {
      await tx.usage.updateMany({
        where: { userId, period: existing.period, messageCount: { gt: 0 } },
        data: { messageCount: { decrement: 1 } },
      });
    }
    return "resolved";
  });
}

/** Add token counts to the current period's aggregate (best-effort accounting). */
export async function recordTokens(
  userId: string,
  promptTokens: number,
  completionTokens: number
): Promise<void> {
  const period = currentPeriod();
  const prompt = Math.max(0, Math.round(promptTokens || 0));
  const completion = Math.max(0, Math.round(completionTokens || 0));
  if (prompt === 0 && completion === 0) return;
  await prisma.usage.upsert({
    where: { userId_period: { userId, period } },
    create: {
      userId,
      period,
      messageCount: 0,
      promptTokens: BigInt(prompt),
      completionTokens: BigInt(completion),
    },
    update: {
      promptTokens: { increment: BigInt(prompt) },
      completionTokens: { increment: BigInt(completion) },
    },
  });
}

/** Refund one consumed message (used when generation fails), floored at 0. */
export async function refundMessage(userId: string, plan: Plan): Promise<QuotaStatus> {
  const period = currentPeriod();
  // Single atomic conditional decrement, mirroring consumeMessage above: the
  // `messageCount > 0` floor and the decrement are one SQL UPDATE. Read-then-
  // decrement let two concurrent failures both observe 1 and both decrement,
  // refunding a message the user never spent.
  await prisma.usage.updateMany({
    where: { userId, period, messageCount: { gt: 0 } },
    data: { messageCount: { decrement: 1 } },
  });
  return getQuota(userId, plan);
}
