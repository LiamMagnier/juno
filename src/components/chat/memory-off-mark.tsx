"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerIcons } from "@/lib/app-icons";
import { MEMORY_OFF_COPY } from "@/lib/chat/memory-off";

/*
 * The header's quiet mark for "Memory off for this chat"
 * (src/lib/chat/memory-off.ts): the memory glyph and two words, in the
 * mono metadata voice the room's member line uses under the same title.
 *
 * A mark, not a control. The two switches are the composer's + and the
 * chat's More menu beside it; a third, here, would put an "on" one press away
 * from a reader who only meant to find out what the words meant. It is in the
 * tab order so a keyboard reaches its tooltip, the way an answer's usage
 * figures are (message-item.tsx). It arrives on the shared fade, like the
 * memory notice's glyph, and simply appears under reduced motion.
 */
export function MemoryOffMark() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="mr-1 inline-flex shrink-0 items-center gap-1 rounded-xs font-mono text-caption font-normal text-muted-foreground outline-none motion-safe:animate-fade-in focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ComposerIcons.memory aria-hidden="true" className="size-3.5" />
          {MEMORY_OFF_COPY.indicatorLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent>{MEMORY_OFF_COPY.indicatorTooltip}</TooltipContent>
    </Tooltip>
  );
}
