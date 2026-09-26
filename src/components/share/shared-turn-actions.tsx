"use client";

import * as React from "react";
import { IconSwap } from "@/components/ui/icon-swap";
import { Pressable } from "@/components/ui/pressable";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { stripMemoryTags } from "@/lib/message-content";

/**
 * The one action a shared answer offers: Copy. A reader of a shared chat is
 * not its author, so there is nothing to rate, regenerate or branch; copying
 * the words is what they came to do. The model that wrote the answer sits
 * beside it in the metadata voice, the receipt the app shows on hover.
 *
 * The same glyph, swap and dwell as the transcript's own Copy (message-item).
 */
export function SharedTurnActions({ content, modelName }: { content: string; modelName: string | null }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const copy = async () => {
    await navigator.clipboard.writeText(stripMemoryTags(content).trimEnd()).catch(() => {});
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable kind="icon" size="md" onClick={copy} aria-label={copied ? "Copied" : "Copy"}>
            <IconSwap
              curve="spring"
              swapped={copied}
              from={<ActionIcons.copy className="size-4" />}
              to={<StatusIcons.success className="size-4 text-success-ink" />}
            />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
      </Tooltip>
      {modelName && <span className="min-w-0 truncate text-caption text-muted-foreground">{modelName}</span>}
    </div>
  );
}
