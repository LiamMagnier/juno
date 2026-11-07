import type { Memory } from "@/components/memory/memory-model";

/**
 * Which facts the memory page's Review asks about, and in what order.
 *
 * Memory is only useful while it is true. Two kinds of fact are the ones
 * most likely to have quietly stopped being true, and the person is the only
 * one who can tell:
 *
 *   - UNSURE: inferred rather than stated (confidence under 0.7) and never
 *     confirmed since. These went in on a guess.
 *   - STALE: nobody has said or confirmed it in six months. People move,
 *     change jobs, finish courses.
 *
 * Temporary facts are left out (they expire on their own), and so is
 * anything not in use: a retired row or a block-list entry has nothing to
 * confirm. The least certain come first, then the oldest, so a short review
 * spends the person's attention where it changes the most.
 */
export const REVIEW_CONFIDENCE = 0.7;
export const REVIEW_STALE_DAYS = 180;
const DAY = 86_400_000;

export type ReviewReason = "unsure" | "stale";

export interface ReviewItem {
  memory: Memory;
  reason: ReviewReason;
}

/** When the fact was last known to be true: confirmed, said, or written down. */
function lastKnown(memory: Memory): number {
  const at = memory.lastVerifiedAt ?? memory.observedAt ?? memory.createdAt;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : Date.now();
}

export function reviewReason(memory: Memory, now: number = Date.now()): ReviewReason | null {
  if (memory.kind !== "FACT" || memory.status !== "active") return null;
  if (memory.category === "temporary" || memory.expiresAt) return null;
  if (memory.confidence < REVIEW_CONFIDENCE && !memory.lastVerifiedAt) return "unsure";
  if (now - lastKnown(memory) > REVIEW_STALE_DAYS * DAY) return "stale";
  return null;
}

export function memoriesToReview(memories: readonly Memory[], now: number = Date.now()): ReviewItem[] {
  return memories
    .flatMap((memory) => {
      const reason = reviewReason(memory, now);
      return reason ? [{ memory, reason }] : [];
    })
    .sort((a, b) => a.memory.confidence - b.memory.confidence || lastKnown(a.memory) - lastKnown(b.memory));
}
