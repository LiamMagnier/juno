"use client";

import * as React from "react";
import { BlockShell, LessonKicker, Reveal } from "@/components/chat/learning/block-shell";
import { Plus } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { DeepDiveData } from "@/lib/learning-blocks";

/**
 * An appendix entry: collapsed, it promises exactly what opening delivers —
 * title + one-line summary + a quiet `+`. Open, the content reads behind a
 * tone-colored quotation rule that tells the eye it has entered supplementary
 * material. Honest progressive disclosure at minimum visual cost.
 */
export function DeepDiveBlock({ deepDive }: { deepDive: DeepDiveData }) {
  const [open, setOpen] = React.useState(false);
  const contentId = React.useId();
  const showSummary = deepDive.summary !== deepDive.title;

  return (
    <BlockShell>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-control",
          "transition-colors duration-fast ease-out-soft hover:bg-accent/30 motion-reduce:transition-none",
          "-my-1 py-1 coarse:min-h-11"
        )}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <LessonKicker accent="bg-source" className="text-source">
            Deep dive
          </LessonKicker>
          <span className="font-sans text-body font-medium leading-6 text-foreground">{deepDive.title}</span>
          {showSummary && (
            <span
              className={cn(
                "truncate text-ui leading-5 text-muted-foreground transition-opacity duration-fast ease-out-soft",
                open && "opacity-0"
              )}
              aria-hidden={open}
            >
              {deepDive.summary}
            </span>
          )}
        </span>
        {/* The set's plus, turned an eighth to a close mark while open — the
            same disclosure glyph as TextToggle, on the symmetric curve. Its
            hover turn is off: it is the block's state, not an action icon. */}
        <Plus
          aria-hidden="true"
          motion="none"
          className={cn(
            "mr-1 size-4 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none",
            open && "rotate-45"
          )}
        />
      </button>
      <Reveal open={open} id={contentId} className="duration-slow ease-out-expo">
        <div className="pt-3">
          <p className="whitespace-pre-line border-l border-source/40 pl-4 text-body leading-7 text-foreground/85">
            {deepDive.content}
          </p>
        </div>
      </Reveal>
    </BlockShell>
  );
}
