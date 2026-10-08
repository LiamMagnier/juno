import "server-only";
import { prisma } from "@/lib/prisma";
import { cancelGeneration } from "@/lib/generation-cancel";
import {
  FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS,
  firstSubmissionLeaseHeartbeatOwnsReceipt,
  firstSubmissionLeaseExpiresAt,
} from "@/lib/chat-first-submission";
import { isChatCancelRequested } from "@/lib/chat-first-submission-receipt";
import { START_FAILED_FAILURE_CODE } from "@/lib/chat/terminal-state";
import type { ChatFinishReason } from "@/types/chat";

/*
 * Pipeline — the durable first-submission receipt's lease, for one turn.
 *
 * A receipt-backed turn (the first message of a saved conversation sent with
 * idempotency keys) owns its receipt only while its lease is live. Every write
 * here is a fenced `updateMany` on (user, generation, state, lease) so a
 * process that lost the lease — suspended, or expired by a status lookup —
 * cannot complete or fail a receipt another owner now holds. None of these
 * writes is retried: a lost fence is a fact to report, not a race to win.
 *
 * Moved out of the route intact. A turn without a receipt gets the same
 * object, whose every method is a no-op that reports success, exactly as the
 * inline closures behaved.
 */

/** The receipt's finish reason for a turn that handed off to a research run (SPEC §9.6.1). */
export const RESEARCH_HANDOFF_FINISH = "research_handoff";

/** How often a receipt-backed generation reads its durable cancel flag. */
export const CHAT_CANCEL_POLL_MS = 2_000;

export interface DurableReceipt {
  /** Set once this process stops owning the receipt. */
  leaseLost: boolean;
  /** accepted → running, before the provider is called. Throws when it cannot. */
  markRunning(): Promise<void>;
  /** Extends the lease before a persistence step; false when it was lost. */
  renew(): Promise<boolean>;
  /**
   * Completed with no assistant row because the turn became a research run
   * (SPEC §9.6.1): `assistantMessageId: null`, `finishReason:
   * "research_handoff"` — a string column, not a `ChatFinishReason`, read by
   * first-submission recovery as "the turn became a run", never as a failure.
   */
  markCompleted(assistantMessageId: string | null, finishReason: ChatFinishReason | typeof RESEARCH_HANDOFF_FINISH): Promise<boolean>;
  markFailed(finishReason: ChatFinishReason, failureCode: string): Promise<void>;
  /** The 15s heartbeat's lease renewal; aborts the generation if the lease is gone. */
  heartbeat(abort: () => void): void;
  /** Starts the durable cancel poll (receipt-backed turns only). */
  startCancelPoll(): void;
  /** Clears the cancel poll. */
  stop(): void;
}

export function createDurableReceipt(input: {
  userId: string;
  /** Null for a turn without a receipt. */
  durableGenerationId: string | null;
  generationId: string;
}): DurableReceipt {
  const { userId, durableGenerationId, generationId } = input;
  let lastReceiptLeaseHeartbeat = Date.now();
  /*
   * A cancel raised somewhere this process cannot hear.
   *
   * POST /api/chat/cancel aborts through the in-memory registry first, which
   * is instant and covers the common case (same tab, same process). The
   * registry is per-process though, so a Stop pressed in another tab served by
   * another process — or after this tab's registry entry was recycled — used
   * to land nowhere and the user watched an answer they had stopped keep
   * writing itself. The durable half of that cancel is `cancelRequestedAt` on
   * the receipt, and this is the loop that reads it: one indexed id-only
   * lookup every ~2s, and only for turns that HAVE a receipt (the first
   * submission of a saved conversation) — there is no row for the rest, so
   * polling for them would be a query that can never return anything.
   *
   * It routes the result back through `cancelGeneration` rather than aborting
   * the controller directly: that marks the generation `stopped` in the
   * registry, which is what makes the terminal state "user stopped" (partial
   * kept, charge kept) instead of an error (refunded).
   */
  let cancelPoll: ReturnType<typeof setInterval> | null = null;

  const receipt: DurableReceipt = {
    leaseLost: false,

    async markRunning() {
      if (!durableGenerationId) return;
      const now = new Date();
      const markedRunning = await prisma.chatFirstSubmissionReceipt.updateMany({
        where: {
          userId,
          generationId: durableGenerationId,
          state: "accepted",
          leaseExpiresAt: { gt: now },
        },
        data: {
          state: "running",
          failureCode: null,
          finishReason: null,
          leaseExpiresAt: firstSubmissionLeaseExpiresAt(),
        },
      });
      if (markedRunning.count !== 1) {
        throw new Error("Durable first-submission receipt could not enter the running state.");
      }
    },

    async renew() {
      if (!durableGenerationId) return true;
      const now = new Date();
      try {
        const renewed = await prisma.chatFirstSubmissionReceipt.updateMany({
          where: {
            userId,
            generationId: durableGenerationId,
            state: "running",
            leaseExpiresAt: { gt: now },
          },
          data: { leaseExpiresAt: firstSubmissionLeaseExpiresAt(now.getTime()) },
        });
        const ownsReceipt = firstSubmissionLeaseHeartbeatOwnsReceipt(renewed.count);
        if (!ownsReceipt) receipt.leaseLost = true;
        return ownsReceipt;
      } catch (error) {
        receipt.leaseLost = true;
        console.error("[chat] durable receipt lease renewal failed", {
          generationId,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    async markCompleted(assistantMessageId, finishReason) {
      if (!durableGenerationId) return true;
      const now = new Date();
      try {
        const updated = await prisma.chatFirstSubmissionReceipt.updateMany({
          where: {
            userId,
            generationId: durableGenerationId,
            state: "running",
            leaseExpiresAt: { gt: now },
          },
          data: {
            state: "completed",
            assistantMessageId,
            finishReason,
            failureCode: null,
            completedAt: new Date(),
            leaseExpiresAt: null,
          },
        });
        return firstSubmissionLeaseHeartbeatOwnsReceipt(updated.count);
      } catch (error) {
        console.error("[chat] durable receipt completion failed", {
          generationId,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },

    async markFailed(finishReason, failureCode) {
      if (!durableGenerationId) return;
      try {
        const updated = await prisma.chatFirstSubmissionReceipt.updateMany({
          where: {
            userId,
            generationId: durableGenerationId,
            state: { in: ["accepted", "running"] },
          },
          data: {
            state: "failed",
            finishReason,
            failureCode,
            completedAt: new Date(),
            leaseExpiresAt: null,
          },
        });
        if (updated.count !== 1) console.error("[chat] durable receipt failure row missing", { generationId });
      } catch (error) {
        console.error("[chat] durable receipt failure update failed", {
          generationId,
          failureCode,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },

    heartbeat(abort) {
      const now = Date.now();
      if (!durableGenerationId || now - lastReceiptLeaseHeartbeat < FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS) return;
      lastReceiptLeaseHeartbeat = now;
      void prisma.chatFirstSubmissionReceipt
        .updateMany({
          where: {
            userId,
            generationId: durableGenerationId,
            state: "running",
            leaseExpiresAt: { gt: new Date(now) },
          },
          data: { leaseExpiresAt: firstSubmissionLeaseExpiresAt(now) },
        })
        .then((updated) => {
          // A status lookup may have expired the lease while this process was
          // suspended. Do not keep spending against a terminal receipt.
          if (!firstSubmissionLeaseHeartbeatOwnsReceipt(updated.count)) {
            receipt.leaseLost = true;
            abort();
          }
        })
        .catch((error) => {
          console.error("[chat] durable receipt lease heartbeat failed", {
            generationId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },

    startCancelPoll() {
      if (!durableGenerationId) return;
      const receiptGenerationId = durableGenerationId;
      cancelPoll = setInterval(() => {
        void isChatCancelRequested(userId, receiptGenerationId)
          .then((requested) => {
            if (!requested) return;
            if (cancelPoll) clearInterval(cancelPoll);
            cancelPoll = null;
            // Registered in this process by definition — we are inside its
            // generate(). Ownership is re-checked there anyway.
            cancelGeneration(receiptGenerationId, userId);
          })
          .catch((error) => {
            // A failed poll is not a cancel. Log once per failure and keep
            // the interval: the registry fast path is unaffected.
            console.error("[chat] cancel poll failed", {
              generationId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }, CHAT_CANCEL_POLL_MS);
    },

    stop() {
      if (cancelPoll) clearInterval(cancelPoll);
      cancelPoll = null;
    },
  };
  return receipt;
}

/**
 * A receipt-backed turn that failed before its stream started: the receipt
 * is failed with START_FAILED and the message refunded by the caller. Best
 * effort; the receipt sweep is the backstop.
 */
export async function failDurableReceiptAtStart(userId: string, durableGenerationId: string): Promise<string> {
  const failureCode = START_FAILED_FAILURE_CODE;
  await prisma.chatFirstSubmissionReceipt
    .updateMany({
      where: {
        userId,
        generationId: durableGenerationId,
        state: { in: ["accepted", "running"] },
      },
      data: {
        state: "failed",
        finishReason: "error",
        failureCode,
        completedAt: new Date(),
        leaseExpiresAt: null,
      },
    })
    .catch(() => {});
  return failureCode;
}
