"use client";

import * as React from "react";
import { Collapse } from "@/components/ui/collapse";
import { Icon } from "@/components/ui/juno-icons";
import { cn } from "@/lib/utils";
import type { ActivityLine } from "@/lib/agents/activity-words";

/**
 * Activity as sentences, with what happened underneath behind one disclosure.
 *
 *   Researcher finished
 *   Critic is reviewing the team's work
 *   Designer is waiting for your approval
 *   What happened underneath ›   researcher · finished · task cm1… · seq 14
 *
 * No pills, no dots, no cards: a line per actor, the attention ink only for
 * what needs the person, the check only for what is done. A line that changes
 * fades in place (motion is state); reduced motion keeps it still.
 */
export function ActivityLines({ lines, label, className }: { lines: readonly ActivityLine[]; label: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const detailsId = React.useId();
  if (lines.length === 0) return null;
  return (
    <section aria-label={label} className={cn("space-y-1", className)} data-activity-lines>
      <ul className="space-y-0.5">
        {lines.map((line) => (
          <li
            key={`${line.key}:${line.sentence}`}
            className={cn(
              "flex items-center gap-2 text-ui motion-safe:animate-fade-in",
              line.tone === "attention" ? "text-[hsl(var(--attention))]" : line.tone === "done" || line.tone === "missed" ? "text-foreground/75" : "text-foreground"
            )}
          >
            <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
              {line.tone === "attention" ? (
                <Icon name="hand" size={14} />
              ) : line.tone === "done" ? (
                <Icon name="check" size={14} className="text-muted-foreground" />
              ) : line.tone === "missed" ? (
                <Icon name="minus" size={14} className="text-muted-foreground" />
              ) : (
                <span className="block h-px w-2 bg-border" />
              )}
            </span>
            <span className="min-w-0 flex-1">{line.sentence}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        className="text-caption text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        {open ? "Hide what happened underneath" : "What happened underneath"}
      </button>
      <Collapse open={open}>
        <ul id={detailsId} className="space-y-0.5 pt-1 font-mono text-caption text-muted-foreground">
          {lines.map((line) => (
            <li key={`t:${line.key}`} className="break-all">
              {line.technical}
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}
