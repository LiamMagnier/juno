"use client";

import * as React from "react";
import { BlockHeader, BlockShell } from "@/components/chat/learning/block-shell";
import { cn } from "@/lib/utils";
import type { ProcessTimelineData } from "@/lib/learning-blocks";

/**
 * A process the learner walks through. Every stage and its description stay
 * visible at all times (the process is understood by seeing the whole sequence)
 * — the interaction is purely additive EMPHASIS: click or arrow-key a stage to
 * light it, and the hairline spine fills coral up to it, so you can step through
 * cause → effect at your own pace. Nothing is ever hidden behind the selection.
 */
export function ProcessTimelineBlock({ timeline }: { timeline: ProcessTimelineData }) {
  const steps = timeline.steps;
  const [active, setActive] = React.useState<number | null>(null);
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const move = (to: number) => {
    const clamped = Math.max(0, Math.min(steps.length - 1, to));
    setActive(clamped);
    refs.current[clamped]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move((active ?? -1) + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move((active ?? steps.length) - 1);
    }
  };

  return (
    <BlockShell aria-label={timeline.title ? `${timeline.title} process` : "Process"}>
      {/* Kicker text uses warning-foreground (--warning is a fill-only tone);
          the accent dash stays on the fill. */}
      <BlockHeader kicker="Process" kickerAccent="bg-warning" kickerClassName="text-warning-foreground" title={timeline.title} />

      <ol className="flex flex-col pt-2" onKeyDown={onKeyDown}>
        {steps.map((step, index) => {
          const isActive = index === active;
          const isPast = active != null && index < active;
          const filled = active != null && index < active; // connector below a walked step
          return (
            <li key={index} className="relative">
              <button
                ref={(el) => {
                  refs.current[index] = el;
                }}
                type="button"
                aria-pressed={isActive}
                aria-label={`Stage ${index + 1}: ${step.label}`}
                onClick={() => setActive((current) => (current === index ? null : index))}
                className={cn(
                  "grid w-full grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 rounded-[8px] text-left outline-none",
                  "transition-colors duration-base ease-out-soft focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11",
                  isActive ? "bg-primary/[0.04]" : "hover:bg-accent/30"
                )}
              >
                {/* Hanging numeral (24px qualifies as WCAG large text at /80). */}
                <span className="flex justify-end pt-3">
                  <span
                    aria-hidden
                    className={cn(
                      "font-serif text-[24px] font-medium leading-none tabular-nums transition-colors duration-base ease-out-soft",
                      isActive ? "text-primary" : isPast ? "text-foreground" : "text-muted-foreground/80"
                    )}
                  >
                    {index + 1}
                  </span>
                </span>
                <span className="flex flex-col gap-1 py-3">
                  <span
                    className={cn(
                      "font-serif text-[15px] font-semibold leading-6 transition-colors duration-base ease-out-soft",
                      isActive ? "text-primary" : "text-foreground"
                    )}
                  >
                    {step.label}
                  </span>
                  {step.description && (
                    <span className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{step.description}</span>
                  )}
                </span>
              </button>
              {/* The spine: a hairline that turns coral once its step is walked. */}
              {index < steps.length - 1 && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute bottom-0 left-[1.9rem] top-11 w-px transition-colors duration-slow ease-out-soft",
                    filled ? "bg-primary/50" : "bg-border/60"
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </BlockShell>
  );
}
