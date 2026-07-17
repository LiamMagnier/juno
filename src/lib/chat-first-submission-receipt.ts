import "server-only";
import { prisma } from "@/lib/prisma";
import { firstSubmissionReceiptExpiryBoundary } from "@/lib/chat-first-submission";

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
