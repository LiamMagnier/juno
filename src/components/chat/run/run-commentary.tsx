"use client";

import * as React from "react";

import { Markdown } from "@/components/chat/markdown";
import { cn } from "@/lib/utils";

/*
 * Text the model wrote between tool calls — "Let me look that up." — when it
 * is not the answer (SPEC §2.8, §7.5). It sits directly above the answer, in
 * the answer's own typography (`prose-juno`), so a round that streamed as
 * answer text and then turned out to be commentary moves here without a
 * jump; only its ink cross-fades to muted. Rounds the provisional hold
 * already classified render here directly, and at rest the persisted
 * commentary items marked `inline` render here too, so a reload looks like
 * the live turn. Provider text: verbatim, never translated.
 */

export interface RunCommentaryProps {
  items: ReadonlyArray<{ key: string; text: string }>;
  className?: string;
}

export function RunCommentary({ items, className }: RunCommentaryProps) {
  if (!items.length) return null;
  return (
    <div lang="" translate="no" data-no-auto-translate className={cn("space-y-1", className)}>
      {items.map((item) => (
        <Markdown
          key={item.key}
          content={item.text}
          className="text-muted-foreground transition-colors duration-base ease-out-soft motion-reduce:transition-none"
        />
      ))}
    </div>
  );
}
