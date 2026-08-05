/**
 * Stage: idempotent submission recovery.
 *
 * A client that retries a send it already made must get the original outcome
 * back, not a second generation. Three lookups decide that, and their ORDER is
 * the contract:
 *
 *  1. A receipt for this request key — the retry is the same submission, so
 *     replay whatever happened to it.
 *  2. A receipt for this *message* key bound to a different request — the
 *     client reused an identifier for new content, which is a conflict rather
 *     than a recovery. Answering "already submitted" there would tell them
 *     their new message was sent when it was not.
 *  3. A pre-receipt Conversation carrying the request key. This is the narrow
 *     rollout window where Conversation/Message keys were written before
 *     durable receipts existed. If it already has a first message the outcome
 *     cannot be proven identical, so it is a conflict; if it does not, the
 *     conversation is an orphan to be finished by the acceptance transaction.
 *
 * The route ran all three inline against Prisma, before rate limiting, which
 * meant the ordering could only be checked by reading it. Behind a port it can
 * be checked by a test.
 */
import {
  classifyFirstSubmissionRecovery,
  classifyReceiptlessFirstSubmission,
  type FirstSubmissionReceiptSnapshot,
  type FirstSubmissionRecovery,
} from "@/lib/chat-first-submission";

export interface FirstSubmissionRecoveryPort {
  /** Account-scoped, and atomically expires a stale lease before reading. */
  receiptForRequest(clientRequestId: string): Promise<FirstSubmissionReceiptSnapshot | null>;
  receiptForMessage(clientMessageId: string): Promise<{ conversationId: string } | null>;
  legacyConversation(clientRequestId: string): Promise<{ id: string } | null>;
  /** Oldest message in the conversation, by createdAt then id. */
  firstMessage(conversationId: string): Promise<{ id: string } | null>;
}

export type FirstSubmissionVerdict =
  /**
   * No prior submission blocks this one. `legacyOrphanConversationId` names a
   * pre-receipt Conversation the acceptance transaction should adopt and
   * finish rather than duplicate.
   */
  | { kind: "proceed"; legacyOrphanConversationId: string | null }
  | { kind: "recovered"; recovery: FirstSubmissionRecovery }
  | { kind: "conflict"; conversationId: string; legacyReceiptMissing: boolean };

export async function recoverFirstSubmission(
  port: FirstSubmissionRecoveryPort,
  keys: { clientRequestId: string; clientMessageId: string; requestHash: string }
): Promise<FirstSubmissionVerdict> {
  const existing = await port.receiptForRequest(keys.clientRequestId);
  if (existing) {
    return {
      kind: "recovered",
      recovery: classifyFirstSubmissionRecovery(existing, keys.clientMessageId, keys.requestHash),
    };
  }

  const reusedMessageKey = await port.receiptForMessage(keys.clientMessageId);
  if (reusedMessageKey) {
    return {
      kind: "conflict",
      conversationId: reusedMessageKey.conversationId,
      legacyReceiptMissing: false,
    };
  }

  const legacy = await port.legacyConversation(keys.clientRequestId);
  if (!legacy) return { kind: "proceed", legacyOrphanConversationId: null };

  const firstMessage = await port.firstMessage(legacy.id);
  if (classifyReceiptlessFirstSubmission(firstMessage) === "ambiguous") {
    return { kind: "conflict", conversationId: legacy.id, legacyReceiptMissing: true };
  }
  return { kind: "proceed", legacyOrphanConversationId: legacy.id };
}
