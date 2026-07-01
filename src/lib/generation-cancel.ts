import "server-only";

type ActiveGeneration = {
  userId: string;
  controller: AbortController;
  model: string;
  conversationId?: string | null;
  startedAt: number;
  stopped: boolean;
};

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
  entry: Omit<ActiveGeneration, "startedAt" | "stopped">
): () => void {
  cleanupOldGenerations();
  activeGenerations.set(generationId, { ...entry, startedAt: Date.now(), stopped: false });
  return () => activeGenerations.delete(generationId);
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
