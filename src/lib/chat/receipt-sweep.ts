/**
 * Startup sweep for generations a dead process left behind.
 *
 * A `ChatFirstSubmissionReceipt` enters `running` after the message was
 * consumed and just before the spend hold is taken; the route renews its
 * five-minute lease once a minute while it streams. If the process dies —
 * SIGKILL after `kill_timeout`, an OOM, a crash — the row stays `running`
 * until its lease expires, at which point `findFirstSubmissionReceipt` flips
 * it to `failed`… and refunds nothing. The message stayed charged and the
 * hold stayed open for the reaper.
 *
 * This sweep runs once at boot, before the process serves anything, and does
 * the refund the dead process could not: every `running` receipt whose lease
 * has expired is marked failed with `PROCESS_LOST_FAILURE_CODE`, the message
 * is given back, and the reservation is released.
 *
 * Only `running`, deliberately. An `accepted` receipt may or may not have
 * consumed a message yet (acceptance and consumption are separate writes),
 * so refunding it could hand out a message that was never taken. Those keep
 * the lazy lease expiry they already had.
 *
 * Pure: the database is behind a port, so the one rule that matters — refund
 * exactly once, and only when THIS call was the one that flipped the row —
 * is testable. Two backends booting at once, or a boot racing the lazy
 * expiry, must not refund the same generation twice.
 */

export interface AbandonedReceipt {
  id: string;
  userId: string;
  generationId: string;
}

export interface ReceiptSweepPort {
  /** `running` receipts whose lease has expired, oldest first. */
  listAbandoned(limit: number): Promise<AbandonedReceipt[]>;
  /**
   * Conditional transition running → failed. Resolves true only when this
   * call performed it; false means someone else got there first.
   */
  markFailed(receipt: AbandonedReceipt): Promise<boolean>;
  refundMessage(userId: string): Promise<void>;
  /** Drop the open spend hold keyed by the generation id, if any. */
  releaseReservation(userId: string, generationId: string): Promise<boolean>;
}

export interface ReceiptSweepResult {
  scanned: number;
  failed: number;
  refunded: number;
  released: number;
  /** Receipts whose refund or release threw; the row is failed regardless. */
  errors: number;
}

export const RECEIPT_SWEEP_DEFAULT_LIMIT = 500;

export async function sweepAbandonedReceipts(
  port: ReceiptSweepPort,
  options: { limit?: number; onError?: (receipt: AbandonedReceipt, error: unknown) => void } = {}
): Promise<ReceiptSweepResult> {
  const result: ReceiptSweepResult = { scanned: 0, failed: 0, refunded: 0, released: 0, errors: 0 };
  const abandoned = await port.listAbandoned(options.limit ?? RECEIPT_SWEEP_DEFAULT_LIMIT);
  result.scanned = abandoned.length;

  for (const receipt of abandoned) {
    // The transition is the lock: whoever flips the row owns the refund.
    if (!(await port.markFailed(receipt))) continue;
    result.failed += 1;
    try {
      await port.refundMessage(receipt.userId);
      result.refunded += 1;
      if (await port.releaseReservation(receipt.userId, receipt.generationId)) result.released += 1;
    } catch (error) {
      // The row is already failed, which is the state that stops a retry
      // from charging twice; the money side is reported, not retried.
      result.errors += 1;
      options.onError?.(receipt, error);
    }
  }
  return result;
}
