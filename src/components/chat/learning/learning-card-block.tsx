"use client";

import { BlockShell, LessonKicker } from "@/components/chat/learning/block-shell";
import { cn } from "@/lib/utils";
import type { LearningCardData, LearningCardTone } from "@/lib/learning-blocks";

const TONES: Record<LearningCardTone, { label: string; rule: string; bar: string; microcap: string }> = {
  insight: { label: "Key idea", rule: "border-primary/70", bar: "bg-primary", microcap: "text-primary" },
  tip: { label: "Tip", rule: "border-source/70", bar: "bg-source", microcap: "text-source" },
  // --warning is a FILL; text on the page background must use warning-foreground
  // (see the token note in globals.css). The bar/rule stay on the fill tone.
  warning: { label: "Watch out", rule: "border-warning/70", bar: "bg-warning", microcap: "text-warning-foreground" },
  note: { label: "Note", rule: "border-muted-foreground/50", bar: "bg-muted-foreground/60", microcap: "text-muted-foreground" },
};

/**
 * A margin note, not a card: kicker in the tone color, then title + body behind
 * a 2px tone-colored left rule — the classic printed-aside marker, and the
 * scannable landmark when skimming a long transcript. Deliberately inert.
 */
export function LearningCardBlock({ card }: { card: LearningCardData }) {
  const tone = TONES[card.tone] ?? TONES.insight;

  return (
    <BlockShell aria-label={`${tone.label}: ${card.title}`}>
      <div className="flex flex-col gap-2.5">
        <LessonKicker accent={tone.bar} className={tone.microcap}>
          {tone.label}
        </LessonKicker>
        <div className={cn("flex flex-col gap-1.5 border-l-2 pl-4", tone.rule)}>
          <h4 className="font-serif text-[19px] font-medium leading-snug tracking-[-0.01em]">
            {card.icon && (
              <span aria-hidden className="pr-2 text-[17px] leading-none">
                {card.icon}
              </span>
            )}
            {card.title}
          </h4>
          <p className="whitespace-pre-line text-[15px] leading-7 text-foreground/80">{card.content}</p>
        </div>
      </div>
    </BlockShell>
  );
}
