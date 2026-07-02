"use client";

import * as React from "react";
import { BookOpen, ChevronRight } from "lucide-react";
import { BlockShell, LessonKicker, Reveal } from "@/components/chat/learning/block-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DeepDiveData } from "@/lib/learning-blocks";

/** Collapsed-by-default expandable detail section. */
export function DeepDiveBlock({ deepDive }: { deepDive: DeepDiveData }) {
  const [open, setOpen] = React.useState(false);
  const contentId = React.useId();
  const showSummary = !open && deepDive.summary !== deepDive.title;

  return (
    <BlockShell className={cn(open ? "border-source/40" : "hover:border-source/30")}>
      <Button
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="grid h-auto w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center justify-normal gap-3 rounded-none px-4 py-4 text-left whitespace-normal coarse:min-h-11 sm:px-5"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-source/10 text-source">
          <BookOpen aria-hidden className="size-4" />
        </span>
        <span className="min-w-0">
          <LessonKicker accent="bg-source" className="text-source">
            Deep dive
          </LessonKicker>
          <span className="block pt-1 text-[15px] font-semibold leading-5 text-foreground">{deepDive.title}</span>
          {showSummary && (
            <span className="block truncate pt-1 text-[13px] leading-5 text-muted-foreground">{deepDive.summary}</span>
          )}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft",
            open && "rotate-90 text-source"
          )}
        />
      </Button>
      <Reveal open={open} id={contentId}>
        <div className="px-4 pb-4 sm:px-5">
          <p className="whitespace-pre-line border-t border-dashed border-border/80 pt-3 text-sm leading-7 text-foreground/85">
            {deepDive.content}
          </p>
        </div>
      </Reveal>
    </BlockShell>
  );
}
