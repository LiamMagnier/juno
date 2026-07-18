"use client";

import { BlockHeader, BlockShell } from "@/components/chat/learning/block-shell";
import type { ProcessTimelineData } from "@/lib/learning-blocks";

/**
 * A printed process diagram: every stage visible at once, ordered by large
 * editorial hanging numerals in the margin, connected by a single hairline
 * spine. The previous version wrapped each step in an outlined button with
 * selection state, arrow-key navigation, and a Previous/Next footer — all
 * machinery for content that was never hidden. A process is understood by
 * seeing all its stages and their order; plain <ol> semantics carry that
 * for screen readers too.
 */
export function ProcessTimelineBlock({ timeline }: { timeline: ProcessTimelineData }) {
  const steps = timeline.steps;

  return (
    <BlockShell aria-label={timeline.title ? `${timeline.title} process` : "Process"}>
      {/* Kicker text uses warning-foreground (--warning is a fill-only tone);
          the accent dash stays on the fill. */}
      <BlockHeader kicker="Process" kickerAccent="bg-warning" kickerClassName="text-warning-foreground" title={timeline.title} />

      <ol className="flex flex-col pt-2">
        {steps.map((step, index) => (
          <li key={index} className="relative grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4">
            {/* Hanging numeral + the hairline spine (omitted after the last row). */}
            <div className="relative flex justify-end">
              {/* 24px qualifies as WCAG large text, so /80 muted passes the 3:1
                  large-text bar in both themes while keeping the recessed look. */}
              <span
                aria-hidden
                className="pt-3 font-serif text-[24px] font-medium leading-none tabular-nums text-muted-foreground/80"
              >
                {index + 1}
              </span>
              {index < steps.length - 1 && (
                <span aria-hidden className="absolute bottom-0 right-[0.55rem] top-10 w-px bg-border/60" />
              )}
            </div>
            <div className="flex flex-col gap-1 py-3">
              <p className="font-serif text-[15px] font-semibold leading-6 text-foreground">{step.label}</p>
              {step.description && (
                <p className="whitespace-pre-line text-sm leading-6 text-muted-foreground">{step.description}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </BlockShell>
  );
}
