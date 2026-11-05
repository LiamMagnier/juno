import type { GenerationRef } from "@/lib/chat/generation-signals";

/**
 * What `POST /api/chat/cancel` does with a Stop, wherever the generation is.
 *
 *  1. This process holds it: abort at once (sub-millisecond), nothing written.
 *  2. Otherwise record the Stop durably — the cancel row every process polls,
 *     plus the receipt flag for a receipt-backed turn — so it reaches the
 *     process that holds the generation within a poll, or the generation
 *     itself if it registers after the Stop (a client that names its own
 *     generation id can press Stop while the turn is still in admission).
 *  3. Answer honestly. `cancelled: true` tells the client a terminal frame is
 *     on its way, so it keeps reading instead of tearing the stream down: true
 *     when this process stopped it, or the Stop is recorded AND some process
 *     holds the generation (a live lease, or a running receipt that was just
 *     flagged). A Stop that is recorded but has no holder yet is `queued`:
 *     the client stops reading locally, and the server still stops the turn
 *     if it appears.
 *
 * Pure: every effect is a dependency, so the route wires Prisma and the tests
 * wire fakes. Never throws — a Stop that could not be recorded is reported as
 * `none`, and the client falls back to dropping the stream.
 */

export type StopDelivery = "local" | "remote" | "queued" | "none";

export interface StopResult {
  cancelled: boolean;
  delivery: StopDelivery;
}

export interface StopGenerationDeps {
  /** The in-process registry's Stop. True when this process holds the generation for this user. */
  cancelLocal(generationId: string, userId: string): boolean;
  /** Write the durable cancel row. Idempotent. */
  recordCancel(ref: GenerationRef): Promise<void>;
  /** Flag a receipt-backed turn's receipt; true when a running receipt took the flag. */
  flagReceipt(userId: string, generationId: string): Promise<boolean>;
  /** Whether some process holds a live lease on the generation. */
  isLive(ref: GenerationRef): Promise<boolean>;
  onError?(stage: "record" | "receipt" | "liveness", error: unknown): void;
}

export async function stopGeneration(ref: GenerationRef, deps: StopGenerationDeps): Promise<StopResult> {
  if (deps.cancelLocal(ref.generationId, ref.userId)) return { cancelled: true, delivery: "local" };

  const [recorded, flagged] = await Promise.all([
    deps.recordCancel(ref).then(
      () => true,
      (error: unknown) => {
        deps.onError?.("record", error);
        return false;
      }
    ),
    deps.flagReceipt(ref.userId, ref.generationId).catch((error: unknown) => {
      deps.onError?.("receipt", error);
      return false;
    }),
  ]);
  if (!recorded && !flagged) return { cancelled: false, delivery: "none" };
  // A running receipt is held by a process that reads its flag on every poll.
  if (flagged) return { cancelled: true, delivery: "remote" };

  const live = await deps.isLive(ref).catch((error: unknown) => {
    deps.onError?.("liveness", error);
    return false;
  });
  return live ? { cancelled: true, delivery: "remote" } : { cancelled: false, delivery: "queued" };
}
