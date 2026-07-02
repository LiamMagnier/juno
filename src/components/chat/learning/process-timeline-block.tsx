"use client";

import * as React from "react";
import { BlockShell, LessonKicker } from "@/components/chat/learning/block-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ProcessTimelineData } from "@/lib/learning-blocks";

/**
 * Vertical numbered timeline. Clicking a step makes it active and expands its
 * description (one open at a time); the connector fills up to the active step.
 * ArrowUp/ArrowDown move the active step while the container is focused.
 */
export function ProcessTimelineBlock({ timeline }: { timeline: ProcessTimelineData }) {
  const steps = timeline.steps;
  const [active, setActive] = React.useState(0);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((current) => Math.min(steps.length - 1, current + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((current) => Math.max(0, current - 1));
      }
    },
    [steps.length]
  );

  return (
    <BlockShell
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={timeline.title ? `${timeline.title} process timeline` : "Process timeline"}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <div className="min-w-0">
          <LessonKicker className="text-warning">Process</LessonKicker>
          {timeline.title && <h4 className="pt-1 font-serif text-[18px] font-semibold leading-tight tracking-tight">{timeline.title}</h4>}
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
      </header>

      <ol className="relative flex flex-col px-3 pb-4 sm:px-4">
        <span aria-hidden className="absolute bottom-8 left-[1.95rem] top-2 w-px bg-border/65 sm:left-[2.2rem]" />
        <span
          aria-hidden
          className="absolute left-[1.95rem] top-2 w-px rounded-full bg-primary transition-[height] duration-slow ease-out-soft sm:left-[2.2rem]"
          style={{ height: `${steps.length > 1 ? (active / (steps.length - 1)) * 100 : 0}%`, maxHeight: "calc(100% - 2.5rem)" }}
        />
        {steps.map((step, index) => {
          const isActive = index === active;
          const isPast = index < active;

          return (
            <li
              key={index}
              className="relative grid grid-cols-[2.1rem_minmax(0,1fr)] gap-3 py-1.5 motion-safe:animate-rise-in [animation-fill-mode:backwards] sm:grid-cols-[2.4rem_minmax(0,1fr)]"
              style={{ animationDelay: `${index * 40}ms` }}
            >
              <div className="relative z-10 flex justify-center pt-2">
                <Button
                  type="button"
                  variant={isActive ? "default" : isPast ? "secondary" : "outline"}
                  size="icon-sm"
                  tabIndex={-1}
                  onClick={() => setActive(index)}
                  aria-current={isActive ? "step" : undefined}
                  aria-label={`Step ${index + 1}: ${step.label}`}
                  className={cn(
                    "relative size-7 shrink-0 rounded-[9px] font-mono text-[11px] font-semibold after:absolute after:-inset-1 after:content-[''] coarse:after:-inset-2.5",
                    isActive
                      ? "border-primary text-primary-foreground"
                      : isPast
                        ? "border-primary/45 text-primary"
                        : "border-border/70 text-muted-foreground hover:border-primary/35 hover:text-foreground"
                  )}
                >
                  {String(index + 1).padStart(2, "0")}
                </Button>
              </div>

              <div className="min-w-0">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setActive(index)}
                  className={cn(
                    "group h-auto w-full flex-col items-start justify-start whitespace-normal rounded-[12px] px-3 py-3 text-left shadow-none coarse:min-h-11",
                    isActive
                      ? "border-primary/40 bg-primary/5"
                      : "border-border/60 bg-background/35 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-accent/25"
                  )}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={cn("font-mono text-[10px] uppercase tracking-[0.16em]", isActive ? "text-primary" : "text-muted-foreground")}>
                      stage {index + 1}
                    </span>
                    {isActive && <span className="h-1.5 w-1.5 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden />}
                  </span>
                  <span className={cn("block pt-1 text-[15px] font-semibold leading-5", isActive ? "text-foreground" : "text-foreground/85")}>
                    {step.label}
                  </span>
                  {step.description && (
                    <span className="block whitespace-pre-line pt-1.5 text-sm leading-6 text-muted-foreground">
                      {step.description}
                    </span>
                  )}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
    </BlockShell>
  );
}
