/**
 * The lease arithmetic for durable first-submission receipts, with no
 * `node:crypto` in it.
 *
 * Split out of `chat-first-submission.ts`, whose first line imports
 * `createHash` for `hashFirstSubmission`. The receipt module needs only the
 * lease boundary, and it is reached from `instrumentation.ts` (the startup
 * sweep) — a file Next compiles for the edge runtime as well, where the
 * `node:` scheme cannot be resolved. Every symbol here is re-exported from
 * `chat-first-submission.ts`, so existing callers are unchanged.
 */

// Running generations refresh this five-minute lease once per minute. A receipt
// lookup atomically expires a missed lease, so a crashed process cannot strand a
// native client in accepted/running forever.
export const FIRST_SUBMISSION_RECEIPT_LEASE_MS = 5 * 60_000;
export const FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS = 60_000;

export function firstSubmissionLeaseExpiresAt(now = Date.now()): Date {
  return new Date(now + FIRST_SUBMISSION_RECEIPT_LEASE_MS);
}

export function firstSubmissionLeaseHeartbeatOwnsReceipt(updatedCount: number): boolean {
  return updatedCount === 1;
}

export function firstSubmissionReceiptExpiryBoundary(now = new Date()) {
  return {
    states: ["claimed", "accepted", "running"] as const,
    leaseExpiresAtLte: now,
    nullLeaseUpdatedAtLte: new Date(now.getTime() - FIRST_SUBMISSION_RECEIPT_LEASE_MS),
  };
}
