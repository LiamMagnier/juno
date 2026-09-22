"use client";

import { Loader2, Minus, X, type IconComponent } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { useWorkArrivals } from "@/components/work/motion/use-work-arrivals";
import type { PlanStep, PlanStepState } from "@/components/work/work-timeline";
import { staggerDelay } from "@/lib/motion";
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

/**
 * The glyph each state draws in the slot, or none. Weights are the set's own
 * optical choice: at 10-12px `icons.tsx` switches to the bold cut, which is the
 * only reason the tick and the cross used to be handed a `strokeWidth`.
 */
const MARK_ICON: Partial<Record<PlanStepState, IconComponent>> = {
  active: Loader2,
  done: StatusIcons.success,
  skipped: Minus,
  // Raw `X`, not `ActionIcons.dismiss`: a STATE opposite the tick above, drawn
  // into a filled 14px slot. Nothing here is pressable.
  failed: X,
  // `pending` and `unreported` deliberately draw no glyph. An unreported step
  // did not fail and it did not happen; an empty dashed ring is the only mark
  // that claims neither.
};

/** Every state that owns a glyph, in the order the layers stack. */
const MARK_LAYERS = Object.keys(MARK_ICON) as PlanStepState[];

/**
 * The 14px slot at the head of every row. Filled only where filled means
 * something.
 *
 * A step changes state under the reader — pending, then turning, then ticked —
 * so the slot CROSS-FADES rather than repainting: every glyph it can hold sits
 * in one grid cell, and the outgoing one shrinks and fades while the incoming
 * one grows into place, over the disc's own colour change. A spinner that
 * vanished in a frame and a tick that appeared in the next read as a flicker;
 * the overlap reads as the step being checked off. Under reduced motion the
 * scale collapses and the fade keeps its timing.
 */
function StepMark({ state }: { state: PlanStepState }) {
  return (
    <span
      className={cn(
        "mt-[2px] grid size-3.5 shrink-0 place-items-center rounded-full border",
        "transition-colors duration-base ease-out-soft motion-reduce:transition-none",
        state === "done" && "border-primary bg-primary text-primary-foreground",
        state === "failed" && "border-destructive bg-destructive text-destructive-foreground",
        state === "skipped" && "border-border text-muted-foreground",
        state === "active" && "border-transparent text-primary",
        state === "pending" && "border-border/70",
        // A hairline dashed ring, which is the one border style nothing else in
        // the rail uses — so "never finished" is legible before the words are.
        state === "unreported" && "border-dashed border-warning/70"
      )}
      aria-hidden="true"
    >
      {MARK_LAYERS.map((layer) => {
        const Icon = MARK_ICON[layer];
        if (Icon === undefined) return null;
        const on = layer === state;
        return (
          <span
            key={layer}
            className={cn(
              "flex items-center justify-center [grid-area:1/1]",
              "transition-[opacity,transform] duration-fast ease-out-soft",
              on ? "scale-100 opacity-100" : "scale-75 opacity-0 motion-reduce:scale-100"
            )}
          >
            <Icon
              motion="none"
              className={cn(
                layer === "done" || layer === "failed" ? "size-2.5" : "size-3",
                // Live state is the one thing allowed to loop, and only while
                // it is live: a hidden spinner does not keep turning.
                layer === "active" && on && "motion-safe:animate-spin"
              )}
            />
          </span>
        );
      })}
    </span>
  );
}

/** What a step that never reported back is called, for the reader. */
const UNREPORTED_NOTE = "never finished";

export function WorkProgressChecklist({ steps }: { steps: readonly PlanStep[] }) {
  // No sentence about the absence of a plan. A run can do a great deal before it
  // writes one — and on a run that never writes one at all, the feed below is
  // where the work is. See rule 2 in work-rail.tsx.
  // Steps are dealt in rather than dumped: the whole plan cascades once when it
  // is first written, and a step the run adds later arrives on its own, at the
  // head of the tempo, instead of waiting out a delay borrowed from its index.
  const arrivals = useWorkArrivals(steps.map((step) => step.id));
  if (steps.length === 0) return null;

  return (
    <ol className="space-y-2">
      {steps.map((step) => {
        const rank = arrivals.rankFor(step.id);
        return (
          <li
            key={step.id}
            className={cn(
              "flex items-start gap-2.5 text-ui leading-relaxed",
              rank !== null && "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            )}
            style={rank !== null ? staggerDelay(rank, "tight") : undefined}
          >
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
                <span className="ml-1.5 font-mono text-caption text-warning">{UNREPORTED_NOTE}</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
