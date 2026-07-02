"use client";

import { AlertTriangle, Lightbulb, StickyNote, type LucideIcon } from "lucide-react";
import { BlockShell, LessonKicker } from "@/components/chat/learning/block-shell";
import { cn } from "@/lib/utils";
import type { LearningCardData, LearningCardTone } from "@/lib/learning-blocks";

const TONES: Record<
  LearningCardTone,
  { label: string; icon: LucideIcon; bar: string; tile: string; microcap: string }
> = {
  insight: { label: "Key idea", icon: Lightbulb, bar: "bg-primary", tile: "bg-primary/10 text-primary", microcap: "text-primary/80" },
  tip: { label: "Tip", icon: Lightbulb, bar: "bg-source", tile: "bg-source/10 text-source", microcap: "text-source/90" },
  warning: { label: "Watch out", icon: AlertTriangle, bar: "bg-warning", tile: "bg-warning/10 text-warning", microcap: "text-warning" },
  note: { label: "Note", icon: StickyNote, bar: "bg-muted-foreground/60", tile: "bg-muted/60 text-muted-foreground", microcap: "text-muted-foreground" },
};

/** A single-idea callout with a quiet tone accent (insight/tip/warning/note). */
export function LearningCardBlock({ card }: { card: LearningCardData }) {
  const tone = TONES[card.tone] ?? TONES.insight;
  const Icon = tone.icon;

  return (
    <BlockShell aria-label={`${tone.label}: ${card.title}`}>
      <div className="px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[10px]", tone.tile)}>
            {card.icon ? (
              <span aria-hidden className="text-base leading-none">{card.icon}</span>
            ) : (
              <Icon aria-hidden className="size-[18px]" />
            )}
          </span>
          <LessonKicker accent={tone.bar} className={tone.microcap}>
            {tone.label}
          </LessonKicker>
        </div>
        <h4 className="pt-3 font-serif text-[18px] font-semibold leading-snug tracking-tight">{card.title}</h4>
        <p className="whitespace-pre-line pt-1.5 text-[15px] leading-7 text-foreground/80">{card.content}</p>
      </div>
    </BlockShell>
  );
}
