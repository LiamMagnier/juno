import "server-only";
import { prisma } from "@/lib/prisma";
import {
  FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS,
  firstSubmissionLeaseHeartbeatOwnsReceipt,
  firstSubmissionLeaseExpiresAt,
} from "@/lib/chat-first-submission";
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
   * A cancel raised somewhere this process cannot hear is no longer polled
   * here. The receipt's `cancelRequestedAt` used to be read by a per-turn
   * interval, for receipt-backed turns only, while every other turn's Stop
   * from another process landed nowhere. One pump per process now reads the
   * durable cancel of EVERY generation it holds — this flag included, in the
   * same round trip — and routes it through the registry so the terminal
   * state is "user stopped". See chat/generation-signals.ts.
   */
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
