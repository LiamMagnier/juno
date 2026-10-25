import "server-only";
import {
  createGenerationRegistry,
  type GenerationEntry,
  type GenerationRegistry,
} from "@/lib/chat/generation-registry";
import {
  createGenerationSignalPump,
  GENERATION_CANCEL_TTL_MS,
  type GenerationRef,
  type GenerationSignalPump,
  type GenerationSignalStore,
} from "@/lib/chat/generation-signals";
import { prismaGenerationSignalStore } from "@/lib/chat/generation-signals-store";

/*
 * The process's generation registry, and the bridge that makes Stop work
 * across processes.
 *
 * In memory: who is generating here, and the AbortController that stops them
 * (`chat/generation-registry.ts` — first abort wins, so the terminal state is
 * deterministic). Durable: a cancel row any process can write and a live
 * lease per saved generation, read and renewed by one pump per process
 * (`chat/generation-signals.ts`, rows in `RateLimit` via
 * `chat/generation-signals-store.ts`). A Stop that lands on another backend
 * process — a second instance, the replacement during a reload — or arrives
 * before the turn registered, reaches the generation within one poll
 * (GENERATION_CANCEL_POLL_MS) and ends it exactly as a local Stop does.
 *
 * Still per-process: `activeGenerationForConversation` (a reopened tab finding
 * its stream without its sessionStorage ledger) answers for this process
 * only — see docs/OPEN_DECISIONS.md.
 *
 * On `globalThis` because the instrumentation bundle (the drain) and the route
 * bundles are separate module graphs in a Next build: module-level state would
 * be two registries that never meet.
 */

interface GenerationRuntime {
  registry: GenerationRegistry;
  pump: GenerationSignalPump;
  store: GenerationSignalStore;
}

const globalState = globalThis as typeof globalThis & { __junoGenerationRuntime?: GenerationRuntime };

function createRuntime(store: GenerationSignalStore): GenerationRuntime {
  // The pump and the registry reference each other; the holder breaks the cycle.
  const holder: { pump?: GenerationSignalPump } = {};
  const registry = createGenerationRegistry({
    onRegister: () => holder.pump?.kick(),
    onUnregister: (ref, leased) => holder.pump?.release(ref, leased),
  });
  const pump = createGenerationSignalPump({
    store,
    held: () => registry.held(),
    // Routed through the registry, so a Stop from another process marks the
    // generation `user` exactly as a local Stop does: partial kept, charge
    // kept, receipt completed — never the refunded error a bare abort reads as.
    onCancel: (ref) => {
      if (registry.cancel(ref.generationId, ref.userId)) {
        console.info("[chat] cross-process stop delivered", { generationId: ref.generationId });
      }
    },
    onError: (stage, error) => {
      // Rate-limited by the pump. A failed read is not a Stop; the in-process
      // fast path keeps working.
      console.error("[chat] generation signal store failed", {
        stage,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  holder.pump = pump;
  return { registry, pump, store };
}

function runtime(): GenerationRuntime {
  globalState.__junoGenerationRuntime ??= createRuntime(prismaGenerationSignalStore);
  return globalState.__junoGenerationRuntime;
}

export function registerGeneration(generationId: string, entry: GenerationEntry): () => void {
  return runtime().registry.register(generationId, entry);
}

/** Generations registered and not yet torn down — what a drain waits on. */
export function activeGenerationCount(): number {
  return runtime().registry.count();
}

/**
 * Abort every in-flight generation because the process is stopping.
 *
 * Marked `shutdown` rather than `user` on purpose: the route's terminal state
 * treats a user Stop as "keep the partial, keep the charge", and a restart
 * must be the opposite — no partial, message refunded, receipt failed — even
 * though both arrive as the same AbortError from the SDK. A generation the
 * user already stopped keeps that cause. Returns how many were aborted.
 */
export function abortGenerationsForShutdown(): number {
  return runtime().registry.abortAllForShutdown();
}

export function wasGenerationAbortedForShutdown(generationId: string): boolean {
  return runtime().registry.wasAbortedForShutdown(generationId);
}

/**
 * Stop a generation THIS process holds. True when it holds it for this user
 * and the generation is now ending, so a terminal frame is on its way. The
 * route's full Stop, which also reaches other processes, is `stopGeneration`
 * (chat/stop-generation.ts) wired in POST /api/chat/cancel.
 */
export function cancelGeneration(generationId: string, userId: string): boolean {
  return runtime().registry.cancel(generationId, userId);
}

export function wasGenerationStopped(generationId: string): boolean {
  return runtime().registry.wasStopped(generationId);
}

/**
 * Record a Stop durably, for whichever process holds the generation — or will.
 * Idempotent. Rejects when the database does.
 */
export function recordGenerationCancel(ref: GenerationRef): Promise<void> {
  return runtime().store.requestCancel(ref, GENERATION_CANCEL_TTL_MS);
}

/**
 * Still registered in THIS process — the resume route's fast liveness signal.
 * Aborted-but-tearing-down still counts: the terminal frame is on its way to
 * the log. `isGenerationLive` also asks the other processes.
 */
export function isGenerationActive(generationId: string): boolean {
  return runtime().registry.isActive(generationId);
}

/**
 * Held by THIS process or by any other (its live lease), for this user. The
 * cross-process answer the resume and cancel routes need. Private turns take
 * no lease, so for them only this process can answer.
 */
export async function isGenerationLive(generationId: string, userId: string): Promise<boolean> {
  const { registry, store } = runtime();
  if (registry.isHeldFor(generationId, userId)) return true;
  return store.isLive({ generationId, userId });
}

/**
 * The generation currently running for a conversation, if this process has
 * one — what lets a reopened tab find the stream to resume when its
 * sessionStorage ledger is gone. Ownership-checked: a caller can only see its
 * own generations. Per-process; see the note at the top of this file.
 */
export function activeGenerationForConversation(conversationId: string, userId: string): string | null {
  return runtime().registry.activeForConversation(conversationId, userId);
}
