"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  RESEARCH_STAGES,
  RESEARCH_STAGE_LABEL,
  stageForState,
  type ResearchStage,
  type ResearchState,
} from "@/lib/research/domain";

/**
 * The run's progress as STAGES, not as events.
 *
 * The event log carries every query, fetch and spend, and rendering all of it
 * was the earlier mistake: a fifty-line wall of "Searching the web" tells a
 * person nothing about whether to keep waiting. Five visible stages, one thin
 * fill bar and a marker on the rung that is running now is what actually
 * answers "what is it doing and is it nearly done" — in the chat panel and on
 * the run's own page, which is why this is one component and not two drawings.
 */

function stageStatus(stage: ResearchStage, current: ResearchStage, live: boolean) {
  const order = RESEARCH_STAGES.indexOf(stage);
  const at = RESEARCH_STAGES.indexOf(current);
  if (order < at) return "done" as const;
  if (order > at) return "pending" as const;
  return live ? ("active" as const) : ("done" as const);
}

/** Where the run stands, for headlines that say "Stage 2 of 5". */
export function stageProgress(state: ResearchState, live: boolean) {
  const stage = stageForState(state);
  const visible = RESEARCH_STAGES.filter((key) => key !== "done");
  const activeIndex = stage === "done" ? visible.length - 1 : Math.max(0, visible.indexOf(stage));
  return {
    number: Math.min(activeIndex + 1, visible.length),
    total: visible.length,
    // Never 0% while alive: an empty bar reads as "not started", and by the
    // time this renders the row exists and the run is being driven.
    percent: live ? Math.max(8, ((activeIndex + 0.45) / visible.length) * 100) : 100,
  };
}

export function StageRail({ state, live, className }: { state: ResearchState; live: boolean; className?: string }) {
  const stage = stageForState(state);
  const { percent } = stageProgress(state, live);
  const visibleStages = RESEARCH_STAGES.filter((key) => key !== "done");

  return (
    <div className={className}>
      <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-slow ease-out-soft"
          style={{ width: `${percent}%` }}
        />
      </div>
      <ol className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-5">
        {visibleStages.map((key) => {
          const status = stageStatus(key, stage, live);
          return (
            <li
              key={key}
              className={cn(
                "flex min-w-0 items-center gap-1.5 border-t pt-1.5 text-caption transition-colors duration-base ease-out-soft",
                // One family for the whole ladder: border → border/55 → primary.
                // "done" was drawn from --foreground while both its neighbours
                // came from --border, so the completed rung was a different
                // material to the rail it belongs to.
                status === "done" && "border-border text-muted-foreground",
                status === "active" && "border-primary text-foreground",
                status === "pending" && "border-border/55 text-muted-foreground/55"
              )}
            >
              {status === "done" && <Check className="h-3 w-3" aria-hidden />}
              {/* `animate-pulse`, not `animate-ping`. Tailwind's ping keyframe
                  scales its element to 2× and drives opacity to 0, holding it
                  there for ~75% of the cycle — it is written for a duplicate ring
                  BEHIND a solid dot. Applied to the dot itself, the one marker
                  saying which stage is running now was invisible most of the time
                  and a smeared blob over the pill's label the rest of it. This is
                  the same solid-dot + pulse marker artifact-inline-card uses for
                  its live status. */}
              {status === "active" && (
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
              )}
              <span className="truncate">{RESEARCH_STAGE_LABEL[key]}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
