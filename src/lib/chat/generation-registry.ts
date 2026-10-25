import type { GenerationRef, HeldGeneration } from "@/lib/chat/generation-signals";

/**
 * The in-process half of the generation registry: who is generating in THIS
 * process, with the AbortController that stops them and the one reason they
 * were stopped.
 *
 * Pure (no Next, no Prisma, no `server-only`) so its rules are testable; the
 * per-process instance, the durable signals and the Stop orchestration are
 * wired in `src/lib/generation-cancel.ts`.
 *
 * Deterministic terminal states. A generation can be aborted by a user Stop
 * (from this process or, through the signal pump, from any other) and by a
 * process drain, and the route's terminal state reads which one it was — a
 * Stop keeps the partial and the charge, a drain refunds. The SDK throws the
 * same AbortError for both, so the registry records exactly one cause: the
 * FIRST abort wins and later ones change nothing. A Stop that arrives after a
 * drain (or after the stall watchdog or a lost lease aborted the controller
 * directly) is acknowledged without rewriting why the generation ended, and a
 * drain skips a generation the user already stopped.
 *
 * An entry also stays until its own unregister runs. The old sweep dropped
 * aborted entries whenever ANY other generation registered, so a turn still
 * tearing down after a Stop could lose its `stopped` mark to unrelated
 * traffic and be recorded by whatever the error classifier guessed.
 */

export type GenerationAbortCause = "user" | "shutdown";

export interface GenerationEntry {
  userId: string;
  controller: AbortController;
  model: string;
  conversationId?: string | null;
  /**
   * A private turn: it takes no live lease (it persists nothing on its own),
   * though a Stop still reaches it through the cancel row its owner writes.
   */
  private?: boolean;
}

interface RegisteredGeneration extends GenerationEntry {
  startedAt: number;
  cause: GenerationAbortCause | null;
}

/**
 * Entries older than this are dropped on the next registration — the backstop
 * for a teardown that never ran its unregister. Kept from the original
 * registry; a live turn's own unregister is what removes it in practice.
 */
export const GENERATION_REGISTRY_MAX_AGE_MS = 30 * 60 * 1000;

export interface GenerationRegistryLogger {
  info(message: string, fields: Record<string, unknown>): void;
}

export interface GenerationRegistry {
  /** Register a generation. Returns its unregister. */
  register(generationId: string, entry: GenerationEntry): () => void;
  /** Generations registered and not yet torn down — what a drain waits on. */
  count(): number;
  /**
   * Stop a generation this process holds, for its owner. True when this
   * process holds it and it is now ending — stopped by this call, by an
   * earlier Stop, or already aborted for another reason (whose cause stands)
   * — so a terminal frame is on its way. False when it is not here or belongs
   * to someone else.
   */
  cancel(generationId: string, userId: string): boolean;
  /** Abort every in-flight generation for a drain. Returns how many it aborted. */
  abortAllForShutdown(): number;
  wasStopped(generationId: string): boolean;
  wasAbortedForShutdown(generationId: string): boolean;
  isActive(generationId: string): boolean;
  /** Is this user's generation registered here (ownership-checked). */
  isHeldFor(generationId: string, userId: string): boolean;
  activeForConversation(conversationId: string, userId: string): string | null;
  /** What the signal pump needs on each tick. */
  held(): HeldGeneration[];
}

export function createGenerationRegistry(
  options: { now?: () => number; logger?: GenerationRegistryLogger; onRegister?: () => void; onUnregister?: (ref: GenerationRef, leased: boolean) => void } = {}
): GenerationRegistry {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? { info: (message, fields) => console.info(message, fields) };
  const generations = new Map<string, RegisteredGeneration>();

  const dropStale = () => {
    const cutoff = now() - GENERATION_REGISTRY_MAX_AGE_MS;
    for (const [id, generation] of generations) {
      if (generation.startedAt < cutoff) {
        generations.delete(id);
        options.onUnregister?.({ generationId: id, userId: generation.userId }, !generation.private);
      }
    }
  };

  return {
    register(generationId, entry) {
      dropStale();
      const registered: RegisteredGeneration = { ...entry, startedAt: now(), cause: null };
      generations.set(generationId, registered);
      options.onRegister?.();
      return () => {
        // Only our own entry: a generation id reused by a later registration
        // must not be torn down by the earlier one's late unregister.
        if (generations.get(generationId) !== registered) return;
        generations.delete(generationId);
        options.onUnregister?.({ generationId, userId: entry.userId }, !entry.private);
      };
    },

    count: () => generations.size,

    cancel(generationId, userId) {
      const generation = generations.get(generationId);
      if (!generation || generation.userId !== userId) return false;
      // First abort wins: a repeat Stop, or a Stop after a drain, the stall
      // watchdog or a lost lease, is acknowledged without rewriting the cause.
      if (generation.cause !== null || generation.controller.signal.aborted) return true;
      generation.cause = "user";
      generation.controller.abort(new DOMException("Stopped by user", "AbortError"));
      logger.info("[chat] generation cancel requested", {
        generationId,
        model: generation.model,
        conversationId: generation.conversationId ?? null,
      });
      return true;
    },

    abortAllForShutdown() {
      let aborted = 0;
      for (const [generationId, generation] of generations) {
        if (generation.cause !== null || generation.controller.signal.aborted) continue;
        generation.cause = "shutdown";
        generation.controller.abort(new DOMException("Server shutting down", "AbortError"));
        aborted += 1;
        logger.info("[chat] generation aborted for shutdown", {
          generationId,
          model: generation.model,
          conversationId: generation.conversationId ?? null,
        });
      }
      return aborted;
    },

    wasStopped: (generationId) => generations.get(generationId)?.cause === "user",
    wasAbortedForShutdown: (generationId) => generations.get(generationId)?.cause === "shutdown",
    isActive: (generationId) => generations.has(generationId),
    isHeldFor: (generationId, userId) => generations.get(generationId)?.userId === userId,

    activeForConversation(conversationId, userId) {
      let newest: { id: string; startedAt: number } | null = null;
      for (const [id, generation] of generations) {
        if (generation.userId !== userId || generation.conversationId !== conversationId) continue;
        if (!newest || generation.startedAt > newest.startedAt) newest = { id, startedAt: generation.startedAt };
      }
      return newest?.id ?? null;
    },

    held() {
      return [...generations].map(([generationId, generation]) => ({
        generationId,
        userId: generation.userId,
        aborted: generation.cause !== null || generation.controller.signal.aborted,
        leased: !generation.private,
      }));
    },
  };
}
