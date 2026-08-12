"use client";

import * as React from "react";
import { Check, Loader2, Minus, X } from "lucide-react";
import type { PlanStep, PlanStepState } from "@/components/work/work-timeline";
import { cn } from "@/lib/utils";

/*
 * The plan, as a list being crossed off.
 *
 * The old plan panel drew one icon per state in a column beside the titles, and
 * every state got the same weight: a done step and a pending step differed by
 * the colour of a 14px glyph and by nothing else. Read at arm's length it was a
 * status table, and a status table answers "what is the state of each step",
 * which is not the question. The question is "how far has this got", and a
 * to-do list answers it without being read at all — the struck-through part is
 * behind you and the plain part is ahead of you, and the boundary between them
 * is where the run is.
 *
 * So: a filled check in the accent colour and a line through the title for a
 * step that is done, plain text for one that is not, and the active step in
 * full-strength ink with its ring turning. Three visual weights for three
 * meanings, and the reader gets the shape of the answer before reading a word.
 *
 * The three states that are neither done nor pending keep their existing
 * treatments, because each of them says something a strike-through would erase:
 *
 *  - `skipped` is struck through but NOT checked. It was crossed off without
 *    being done, and a check would claim otherwise.
 *  - `failed` is a cross in destructive ink, not struck through. A strike says
 *    "behind you"; a failed step is very much not.
 *  - `unreported` — the run stopped while this step was open — keeps the dashed
 *    ring and the words "never finished". That treatment was argued for in
 *    `derivePlan`, which is where the state is derived, and repeating the
 *    argument here would be the second place to change it. `PlanStepState` is
 *    imported from that file for the same reason.
 */

export interface PlanTally {
  done: number;
  total: number;
}

/**
 * How much of the plan is behind the run, for the heading.
 *
 * `skipped` counts as behind. A step the run decided not to take is not work
 * remaining, and counting it as outstanding would leave a plan sitting for ever
 * at "4 of 6" with nothing left to do.
 */
export function planTally(steps: readonly PlanStep[]): PlanTally {
  return {
    done: steps.filter((step) => step.state === "done" || step.state === "skipped").length,
    total: steps.length,
  };
}

type MarkIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

const MARK_ICON: Record<PlanStepState, MarkIcon | null> = {
  pending: null,
  active: Loader2,
  done: Check,
  skipped: Minus,
  failed: X,
  // Deliberately no glyph. The step did not fail and it did not happen; an empty
  // dashed ring is the only mark that claims neither.
  unreported: null,
};

/** The 14px slot at the head of every row. Filled only where filled means something. */
function StepMark({ state }: { state: PlanStepState }) {
  const Icon = MARK_ICON[state];
  return (
    <span
      className={cn(
        "mt-[2px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full",
        state === "done" && "bg-primary text-primary-foreground",
        state === "failed" && "bg-destructive text-destructive-foreground",
        state === "skipped" && "border border-border text-muted-foreground",
        state === "active" && "text-primary",
        state === "pending" && "border border-border/70",
        // A hairline dashed ring, which is the one border style nothing else in
        // the rail uses — so "never finished" is legible before the words are.
        state === "unreported" && "border border-dashed border-warning/70"
      )}
      aria-hidden="true"
    >
      {Icon !== null && (
        <Icon
          className={cn(
            state === "done" || state === "failed" ? "h-2.5 w-2.5" : "h-3 w-3",
            state === "active" && "motion-safe:animate-spin"
          )}
          strokeWidth={state === "done" || state === "failed" ? 3 : 2}
        />
      )}
    </span>
  );
}

/** What a step that never reported back is called, for the reader. */
const UNREPORTED_NOTE = "never finished";

export function WorkProgressChecklist({ steps }: { steps: readonly PlanStep[] }) {
  // No sentence about the absence of a plan. A run can do a great deal before it
  // writes one — and on a run that never writes one at all, the feed below is
  // where the work is. See rule 2 in work-rail.tsx.
  if (steps.length === 0) return null;

  return (
    <ol className="space-y-2">
      {steps.map((step) => (
        <li key={step.id} className="flex items-start gap-2.5 text-[13px] leading-relaxed">
          <StepMark state={step.state} />
          <span
            className={cn(
              "min-w-0 transition-colors duration-slow ease-out-soft",
              step.state === "pending" && "text-foreground/80",
              // Struck through and dimmed together. Either alone reads as an
              // edit; the pair reads as a to-do list.
              step.state === "done" && "text-muted-foreground line-through decoration-border",
              step.state === "skipped" &&
                "text-muted-foreground line-through decoration-border",
              step.state === "active" && "font-medium text-foreground",
              step.state === "failed" && "text-foreground",
              step.state === "unreported" && "text-muted-foreground"
            )}
          >
            {step.title}
            {step.state === "unreported" && (
              // Said in words as well as in colour. The ring alone changes a
              // spinner into a dashed circle, which is a difference nobody reads
              // as "this never happened".
              <span className="ml-1.5 font-mono text-[11px] text-warning">{UNREPORTED_NOTE}</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
