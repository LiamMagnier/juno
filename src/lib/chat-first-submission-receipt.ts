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

/**
 * Record a cancel on the receipt. The in-memory registry is the fast path
 * (same process, sub-millisecond); this is what lets a cancel from another
 * process or tab reach a stream loop that polls it (~2s). Only while the
 * generation can still be running — a terminal receipt has nothing to cancel.
 */
export async function requestChatCancel(userId: string, generationId: string): Promise<boolean> {
  const updated = await prisma.chatFirstSubmissionReceipt.updateMany({
    where: { userId, generationId, state: { in: ["accepted", "running"] }, cancelRequestedAt: null },
    data: { cancelRequestedAt: new Date() },
  });
  return updated.count === 1;
}

/** The minimal read the stream loop makes on its cancel poll. */
export async function isChatCancelRequested(userId: string, generationId: string): Promise<boolean> {
  const row = await prisma.chatFirstSubmissionReceipt.findFirst({
    where: { userId, generationId, cancelRequestedAt: { not: null } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * What the resume route needs of a receipt on each liveness poll: is the
 * generation still allowed to append to its log? Terminal states are final;
 * a running receipt whose lease has lapsed belongs to a process that is gone.
 */
export async function chatReceiptLiveness(
  userId: string,
  generationId: string,
  now = new Date()
): Promise<"running" | "terminal" | "none"> {
  const row = await prisma.chatFirstSubmissionReceipt.findFirst({
    where: { userId, generationId },
    select: { state: true, leaseExpiresAt: true },
  });
  if (!row) return "none";
  if (row.state !== "accepted" && row.state !== "running") return "terminal";
  return row.leaseExpiresAt && row.leaseExpiresAt > now ? "running" : "terminal";
}
