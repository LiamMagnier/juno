"use client";

import { cn } from "@/lib/utils";
import { runBadge } from "@/components/research/run-format";
import { isResearchState, type ResearchState } from "@/lib/research/domain";

/**
 * One run's state as a chip — the same dot-plus-word shape the roadmap's
 * StatusBadge draws, because a reader scanning two different lists of "things
 * with states" should not have to learn two different chips.
 */
export function RunStateBadge({ state, className }: { state: string; className?: string }) {
  // A state this build no longer knows renders as failed rather than crashing
  // the list: the column is TEXT and rows outlive deployments.
  const safeState: ResearchState = isResearchState(state) ? state : "failed";
  const badge = runBadge(safeState);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-caption",
        badge.tone,
        className
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", badge.dot, badge.pulse && "motion-safe:animate-pulse")}
      />
      {badge.label}
    </span>
  );
}
