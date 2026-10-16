"use client";

import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { Check, Hand, Minus, XCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * A plan step's state (spec §3.10, PlanStepGlyph, web twin of the Swift one):
 *
 *   done     check, foreground
 *   active   the galaxy at 12, presence
 *   waiting  hand, signal (the step needs the reader)
 *   failed   circle-x, destructive
 *   skipped  minus, muted
 *   pending  a 1.5px circle, muted
 *
 * Inks are the status role tokens (brand.css `.alevr-plan-step`). The word is
 * for assistive tech; the row beside it names the step.
 */

export type PlanStepState = "done" | "active" | "waiting" | "failed" | "skipped" | "pending";

const WORDS: Record<PlanStepState, string> = {
  done: "Done",
  active: "Running",
  waiting: "Needs you",
  failed: "Failed",
  skipped: "Skipped",
  pending: "Not started",
};

export function PlanStepGlyph({ state, className, label }: { state: PlanStepState; className?: string; label?: string }) {
  return (
    <span className={cn("alevr-plan-step", className)} data-state={state} role="img" aria-label={label ?? WORDS[state]}>
      {state === "done" ? <Check size={12} aria-hidden /> : null}
      {state === "active" ? <GalaxyMark phase="working" size={12} /> : null}
      {state === "waiting" ? <Hand size={12} aria-hidden /> : null}
      {state === "failed" ? <XCircle size={12} aria-hidden /> : null}
      {state === "skipped" ? <Minus size={12} aria-hidden /> : null}
      {state === "pending" ? (
        <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
          <circle cx={6} cy={6} r={4.25} fill="none" stroke="currentColor" strokeWidth={1.5} />
        </svg>
      ) : null}
    </span>
  );
}
