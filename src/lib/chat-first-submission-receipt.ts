import "server-only";
import { prisma } from "@/lib/prisma";
import { prismaUnguarded } from "@/lib/db";
import { firstSubmissionReceiptExpiryBoundary } from "@/lib/chat-first-submission-time";
import {
  sweepAbandonedReceipts,
  type AbandonedReceipt,
  type ReceiptSweepPort,
  type ReceiptSweepResult,
} from "@/lib/chat/receipt-sweep";
import { PROCESS_LOST_FAILURE_CODE } from "@/lib/chat/terminal-state";
import { releaseSpend } from "@/lib/spend";
import { getUserPlan, refundMessage } from "@/lib/usage";

type ReceiptSelector =
  | { clientRequestId: string; clientMessageId?: never; generationId?: never }
  | { clientRequestId?: never; clientMessageId: string; generationId?: never }
  | { clientRequestId?: never; clientMessageId?: never; generationId: string };

/**
 * Account-scoped receipt lookup with atomic stale-lease expiry. A NULL lease is
 * tolerated for rollout compatibility and expires from updatedAt on the same
 * five-minute boundary.
 */
export async function findFirstSubmissionReceipt(userId: string, selector: ReceiptSelector) {
  const now = new Date();
  const expiry = firstSubmissionReceiptExpiryBoundary(now);
  return prisma.$transaction(async (tx) => {
    await tx.chatFirstSubmissionReceipt.updateMany({
      where: {
        userId,
        ...selector,
        state: { in: [...expiry.states] },
        OR: [
          { leaseExpiresAt: { lte: expiry.leaseExpiresAtLte } },
          { leaseExpiresAt: null, updatedAt: { lte: expiry.nullLeaseUpdatedAtLte } },
        ],
      },
      data: {
        state: "failed",
        finishReason: "error",
        failureCode: "GENERATION_LEASE_EXPIRED",
        completedAt: now,
        leaseExpiresAt: null,
      },
    });
    return tx.chatFirstSubmissionReceipt.findFirst({ where: { userId, ...selector } });
  });
}

/**
 * The Prisma side of `sweepAbandonedReceipts` — see that module for the rule.
 *
 * `prismaUnguarded` because the sweep is cross-account by nature: it is the
 * process, not a user, asking which generations it inherited from its dead
 * predecessor. Each refund and release is then made through the user-scoped
 * helpers with the userId the row carries.
 */
export async function sweepAbandonedFirstSubmissionReceipts(
  options: { now?: Date; limit?: number } = {}
): Promise<ReceiptSweepResult> {
  const now = options.now ?? new Date();
  const expiry = firstSubmissionReceiptExpiryBoundary(now);
  // Lease expired, or (rollout compatibility) no lease at all and untouched
  // for a full lease window — the same boundary the lazy expiry uses.
  const expired = {
    OR: [
      { leaseExpiresAt: { lte: expiry.leaseExpiresAtLte } },
      { leaseExpiresAt: null, updatedAt: { lte: expiry.nullLeaseUpdatedAtLte } },
    ],
  };
  const port: ReceiptSweepPort = {
    listAbandoned: (limit) =>
      prismaUnguarded.chatFirstSubmissionReceipt.findMany({
        where: { state: "running", ...expired },
        select: { id: true, userId: true, generationId: true },
        orderBy: { updatedAt: "asc" },
        take: limit,
      }),
    markFailed: async (receipt: AbandonedReceipt) => {
      const flipped = await prismaUnguarded.chatFirstSubmissionReceipt.updateMany({
        where: { id: receipt.id, userId: receipt.userId, state: "running", ...expired },
        data: {
          state: "failed",
          finishReason: "error",
          failureCode: PROCESS_LOST_FAILURE_CODE,
          completedAt: now,
          leaseExpiresAt: null,
        },
      });
      return flipped.count === 1;
    },
    refundMessage: async (userId) => {
      await refundMessage(userId, await getUserPlan(userId));
    },
    releaseReservation: (userId, generationId) => releaseSpend(userId, generationId),
  };
  return sweepAbandonedReceipts(port, {
    limit: options.limit,
    onError: (receipt, error) => {
      console.error("[chat] receipt sweep could not refund", {
        generationId: receipt.generationId,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
