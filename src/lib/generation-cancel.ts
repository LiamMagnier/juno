import "server-only";

type ActiveGeneration = {
  userId: string;
  controller: AbortController;
  model: string;
  conversationId?: string | null;
  startedAt: number;
  stopped: boolean;
  /** Aborted by the process draining for a restart, not by the user. */
  shutdown: boolean;
};

// Per-process, in memory. Correct with the ONE PM2 instance that runs today;
// with a second, POST /api/chat/cancel reaches the wrong process and silently
// returns { ok: true, cancelled: false }. See docs/OPEN_DECISIONS.md before
// adding an instance.
const globalState = globalThis as typeof globalThis & {
  __junoActiveGenerations?: Map<string, ActiveGeneration>;
};

const activeGenerations = globalState.__junoActiveGenerations ?? new Map<string, ActiveGeneration>();
globalState.__junoActiveGenerations = activeGenerations;

function cleanupOldGenerations() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, generation] of activeGenerations) {
    if (generation.startedAt < cutoff || generation.controller.signal.aborted) activeGenerations.delete(id);
  }
}

export function registerGeneration(
  generationId: string,
  entry: Omit<ActiveGeneration, "startedAt" | "stopped" | "shutdown">
): () => void {
  cleanupOldGenerations();
  activeGenerations.set(generationId, { ...entry, startedAt: Date.now(), stopped: false, shutdown: false });
  return () => activeGenerations.delete(generationId);
}

/** Generations registered and not yet torn down — what a drain waits on. */
export function activeGenerationCount(): number {
  return activeGenerations.size;
}

/**
 * Abort every in-flight generation because the process is stopping.
 *
 * Marked `shutdown` rather than `stopped` on purpose: the route's terminal
 * state treats a user Stop as "keep the partial, keep the charge", and a
 * restart must be the opposite — no partial, message refunded, receipt failed
 * — even though both arrive as the same AbortError from the SDK. Returns how
 * many were aborted.
 */
export function abortGenerationsForShutdown(): number {
  let aborted = 0;
  for (const [generationId, generation] of activeGenerations) {
    if (generation.controller.signal.aborted) continue;
    generation.shutdown = true;
    generation.controller.abort(new DOMException("Server shutting down", "AbortError"));
    aborted += 1;
    console.info("[chat] generation aborted for shutdown", {
      generationId,
      model: generation.model,
      conversationId: generation.conversationId ?? null,
    });
  }
  return aborted;
}

export function wasGenerationAbortedForShutdown(generationId: string): boolean {
  return activeGenerations.get(generationId)?.shutdown ?? false;
}

export function cancelGeneration(generationId: string, userId: string): boolean {
  const generation = activeGenerations.get(generationId);
  if (!generation || generation.userId !== userId) return false;
  generation.stopped = true;
  generation.controller.abort(new DOMException("Stopped by user", "AbortError"));
  console.info("[chat] generation cancel requested", {
    generationId,
    model: generation.model,
    conversationId: generation.conversationId ?? null,
  });
  return true;
}

export function wasGenerationStopped(generationId: string): boolean {
  return activeGenerations.get(generationId)?.stopped ?? false;
}

/**
 * Still registered in THIS process — the resume route's liveness signal for a
 * generation with no receipt (every web turn). Aborted-but-tearing-down still
 * counts: the terminal frame is on its way to the log. Per-process, like the
 * registry itself; see the note at the top of this file.
 */
export function isGenerationActive(generationId: string): boolean {
  return activeGenerations.has(generationId);
}

/**
 * The generation currently running for a conversation, if this process has
 * one — what lets a reopened tab find the stream to resume when its
 * sessionStorage ledger is gone. Ownership-checked: a caller can only see its
 * own generations.
 */
export function activeGenerationForConversation(conversationId: string, userId: string): string | null {
  let newest: { id: string; startedAt: number } | null = null;
  for (const [id, generation] of activeGenerations) {
    if (generation.userId !== userId || generation.conversationId !== conversationId) continue;
    if (!newest || generation.startedAt > newest.startedAt) newest = { id, startedAt: generation.startedAt };
  }
  return newest?.id ?? null;
}
