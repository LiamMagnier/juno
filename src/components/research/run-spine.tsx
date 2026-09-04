"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  RESEARCH_STAGES,
  RESEARCH_STAGE_LABEL,
  RESEARCH_STATE_MESSAGE,
  stageForState,
  type ResearchStage,
  type ResearchState,
} from "@/lib/research/domain";

/**
 * The run as a SPINE: five stages down a vertical rule, only the live one open.
 *
 * Two earlier attempts at this are worth recording, because the third exists to
 * fix what they had in common.
 *
 *   1. A five-column grid of stage names with an icon slot each. Four of the
 *      five labels are irrelevant at any moment, and printing them all at 11px
 *      in grey produced a block of noise above a bar that said the same thing.
 *   2. A segmented loading bar with the stage named beside it. Better, but a
 *      chunked progress bar is the most generic object in software — it says
 *      "something is loading" and nothing about what kind of work this is.
 *
 * Both were drawing PERCENTAGE. Research is not a percentage; it is a sequence
 * of named acts, each with a result, and the interesting one is the act
 * happening now. A spine draws exactly that: past stages collapse to a line and
 * their yield ("14 results"), the live stage opens with what it is touching, and
 * future stages are present but unlit — the shape a deploy log, an order tracker
 * and a build pipeline all converged on, because it is how sequential work is
 * legible without being loud.
 *
 * TYPOGRAPHY IS THE HIERARCHY HERE, not weight of chrome. The live stage is set
 * a rung up in the interface face; everything behind and ahead of it drops to
 * muted at the same size. There are no boxes, no borders and no fills inside
 * this component — the rule and the nodes are the only marks.
 */

/** The five rungs a person is shown; `done` is the absence of a rung, not one. */
const VISIBLE_STAGES: readonly ResearchStage[] = RESEARCH_STAGES.filter((key) => key !== "done");

/** What each stage yielded, when the run knows. Absent renders as nothing. */
export type StageYield = Partial<Record<ResearchStage, string | null>>;

export function RunSpine({
  state,
  live,
  /** What the live stage is touching this second — a host, a query. */
  detail,
  /** Per-stage results, shown on stages that are behind the live one. */
  yields,
  className,
}: {
  state: ResearchState;
  live: boolean;
  detail?: string | null;
  yields?: StageYield;
  className?: string;
}) {
  const current = stageForState(state);
  const at = current === "done" ? VISIBLE_STAGES.length : VISIBLE_STAGES.indexOf(current);

  return (
    <ol className={cn("relative", className)} aria-label={RESEARCH_STATE_MESSAGE[state]} aria-live="polite">
      {VISIBLE_STAGES.map((stage, i) => {
        const status = i < at ? "done" : i > at ? "ahead" : live ? "live" : "done";
        const last = i === VISIBLE_STAGES.length - 1;
        const yielded = yields?.[stage];

        return (
          <li
            key={stage}
            className={cn(
              "relative flex gap-3 pb-3 last:pb-0",
              // A stage transition is an event, not perpetual decoration. The
              // short settle gives the eye a precise handoff as work moves from
              // investigation to review to writing, while reduced-motion users
              // receive the same state change without movement.
              status === "live" && "motion-safe:animate-research-stage"
            )}
          >
            {/* The rule. Drawn per row rather than as one absolute element so it
                stops exactly at the last node instead of running past it, and
                so each segment can carry the colour of the stage ABOVE it —
                which is what makes the spine read as filling downward. */}
            {!last && (
              <span
                aria-hidden
                className={cn(
                  "absolute left-[3px] top-[9px] w-px",
                  // -1px so consecutive segments meet with no seam at 1x.
                  "bottom-[-1px]",
                  i < at ? "bg-primary/35" : "bg-border"
                )}
              />
            )}

            <span aria-hidden className="relative mt-[5px] flex size-[7px] shrink-0 items-center justify-center">
              {status === "live" && (
                // The one moving thing on the surface. A halo, not a spinner:
                // it says "here" rather than "wait", and it is the only element
                // in this component that animates at all.
                <span className="absolute size-[7px] rounded-full bg-primary/45 motion-safe:animate-pulse-ring" />
              )}
              <span
                className={cn(
                  "size-[7px] rounded-full transition-colors duration-base ease-out-soft motion-reduce:transition-none",
                  status === "done" && "bg-primary/45",
                  status === "live" && "bg-primary ring-[3px] ring-primary/15",
                  status === "ahead" && "border border-border bg-transparent"
                )}
              />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <p
                  className={cn(
                    "min-w-0 truncate transition-colors duration-base ease-out-soft motion-reduce:transition-none",
                    status === "live" && "text-body font-medium text-foreground",
                    status === "done" && "text-ui text-muted-foreground",
                    status === "ahead" && "text-ui text-muted-foreground/45"
                  )}
                >
                  {RESEARCH_STAGE_LABEL[stage]}
                </p>
                {/* A stage's yield is a NUMBER OF THINGS, which is the one
                    place tabular figures earn their keep. Everything else on
                    this surface is set in the interface face. */}
                {status !== "ahead" && yielded ? (
                  <p className="shrink-0 text-caption tabular-nums text-muted-foreground/80">{yielded}</p>
                ) : null}
              </div>

              {/* Only the live stage says more than its name. This is the whole
                  disclosure model of the surface, in one condition. */}
              {status === "live" && (
                <p className="mt-0.5 min-w-0 truncate text-ui text-muted-foreground">
                  {RESEARCH_STATE_MESSAGE[state]}
                  {detail ? <span className="text-foreground/55"> — {detail}</span> : null}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
