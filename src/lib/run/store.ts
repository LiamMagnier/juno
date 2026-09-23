/**
 * The run UI's shared client state (SPEC §7.9.1, §7.11, §7.12): the one-loop
 * arbiter and the Research phases the announcer speaks.
 *
 * "One loop owner on screen": every loop-capable element claims the loop with
 * a priority, and only the winner animates; everything else shows its phase's
 * static signature. WS0 lands the signatures; WS5 implements them.
 */

import type { LoopPriority } from "@/lib/run/types";
import type { ResearchPhase } from "@/types/research";

export type { LoopPriority } from "@/lib/run/types";

/** Claims the loop for `id`; returns the release. Ties go to the most recent claim. */
export function claimLoop(_id: string, _priority: LoopPriority): () => void {
  throw new Error("not implemented: WS5");
}

/** True while `id` owns the loop (useSyncExternalStore). */
export function useLoopOwner(_id: string): boolean {
  throw new Error("not implemented: WS5");
}

/** Research rows publish their run's phase here, so the announcer never imports the Research UI. */
export function publishResearchPhase(_runId: string, _phase: ResearchPhase): void {
  throw new Error("not implemented: WS5");
}
