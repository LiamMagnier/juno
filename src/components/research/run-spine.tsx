"use client";

import * as React from "react";
import { Check, Compass, FileText, Globe, Search, ShieldCheck } from "lucide-react";
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
 * The run as a progressive stage stepper.
 *
 * Modeled after ChatGPT Deep Research & Claude Research:
 * - 4 distinct, meaningful acts (Planning, Investigating, Reviewing, Writing)
 * - Clear completed, active, and upcoming visual language
 * - Active state provides high-visibility agent activity badges (searching queries, reading hosts)
 * - Smooth vertical progress spine with soft elevation
 */

const VISIBLE_STAGES: readonly ResearchStage[] = RESEARCH_STAGES.filter((key) => key !== "done");

export type StageYield = Partial<Record<ResearchStage, string | null>>;

const STAGE_SUBTITLES: Record<ResearchStage, string> = {
  plan: "Strategy & search vectors",
  investigate: "Web exploration & source harvesting",
  review: "Fact-checking & cross-validation",
  write: "Report synthesis & citation verification",
  done: "Research complete",
};

const STAGE_ICONS: Record<ResearchStage, React.ComponentType<{ className?: string }>> = {
  plan: Compass,
  investigate: Globe,
  review: ShieldCheck,
  write: FileText,
  done: Check,
};

export function RunSpine({
  state,
  live,
  detail,
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
    <ol className={cn("relative space-y-1.5", className)} aria-label={RESEARCH_STATE_MESSAGE[state]} aria-live="polite">
      {VISIBLE_STAGES.map((stage, i) => {
        const status = i < at ? "done" : i > at ? "ahead" : live ? "live" : "done";
        const last = i === VISIBLE_STAGES.length - 1;
        const yielded = yields?.[stage];
        const StageIcon = STAGE_ICONS[stage];
        const subtitle = STAGE_SUBTITLES[stage];

        const isLiveCard = status === "live";

        return (
          <li
            key={stage}
            className="relative flex items-start gap-3.5 px-3 py-1.5"
          >
            {/* The continuous vertical connector spine */}
            {!last && (
              <span
                aria-hidden
                className={cn(
                  "absolute left-[24px] top-[30px] -bottom-2 w-[2px] -translate-x-1/2 rounded-full transition-colors duration-base",
                  i < at ? "bg-primary/45" : "bg-border/60"
                )}
              />
            )}

            {/* Node indicator */}
            <div className="relative mt-0.5 flex size-6 shrink-0 items-center justify-center">
              {status === "done" && (
                <span className="flex size-6 items-center justify-center rounded-full border border-primary/30 bg-primary/15 text-primary shadow-2xs">
                  <Check className="size-3.5 stroke-[2.5]" />
                </span>
              )}

              {status === "live" && (
                <>
                  <span className="absolute -inset-1 rounded-full bg-primary/25 motion-safe:animate-pulse-ring" />
                  <span className="relative flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                    <StageIcon className="size-3.5" />
                  </span>
                </>
              )}

              {status === "ahead" && (
                <span className="flex size-6 items-center justify-center rounded-full border border-border/70 bg-secondary/30 text-muted-foreground/40">
                  <StageIcon className="size-3 text-muted-foreground/40" />
                </span>
              )}
            </div>

            {/* Stage Content */}
            <div
              className={cn(
                "min-w-0 flex-1 transition-all duration-fast",
                isLiveCard
                  ? "rounded-card border border-primary/25 bg-primary/[0.04] p-3 shadow-2xs motion-safe:animate-research-stage"
                  : "py-0.5"
              )}
            >
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p
                      className={cn(
                        "truncate text-sm transition-colors duration-base ease-out-soft",
                        status === "live" && "font-semibold text-foreground",
                        status === "done" && "font-medium text-foreground/90",
                        status === "ahead" && "font-medium text-muted-foreground/50"
                      )}
                    >
                      {RESEARCH_STAGE_LABEL[stage]}
                    </p>
                    {status === "live" && (
                      <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-micro font-semibold uppercase tracking-wider text-primary">
                        Active
                      </span>
                    )}
                  </div>
                  {status !== "live" && (
                    <p
                      className={cn(
                        "truncate text-xs transition-colors",
                        status === "done" ? "text-muted-foreground/75" : "text-muted-foreground/35"
                      )}
                    >
                      {subtitle}
                    </p>
                  )}
                </div>

                {/* Yield pill */}
                {status !== "ahead" && yielded ? (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-mono font-medium tabular-nums border",
                      status === "live"
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border/60 bg-secondary/70 text-muted-foreground"
                    )}
                  >
                    {yielded}
                  </span>
                ) : null}
              </div>

              {/* Live Activity Detail */}
              {status === "live" && (
                <div className="mt-2.5">
                  {detail ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {detail.startsWith("“") ? (
                        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 font-medium text-foreground shadow-2xs">
                          <Search className="size-3 shrink-0 text-primary" />
                          <span className="truncate">{detail}</span>
                        </span>
                      ) : (
                        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 font-mono font-medium text-foreground shadow-2xs">
                          <Globe className="size-3 shrink-0 text-primary" />
                          <span className="truncate">{detail}</span>
                        </span>
                      )}
                      <span className="text-muted-foreground">{RESEARCH_STATE_MESSAGE[state]}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
                      <span>{RESEARCH_STATE_MESSAGE[state]}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
