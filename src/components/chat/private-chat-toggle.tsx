"use client";

import * as React from "react";
import { IncognitoGlyph } from "@/components/chat/incognito-glyph";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The incognito switch in the chat root's header cluster.
 *
 * "Incognito", everywhere the mode is named: the toggle, its tooltip, the
 * banner and the transcript heading. The same mode used to be "private chat"
 * on this button and "incognito" on the page it turned on, which read as two
 * features.
 *
 * THE GHOST IS A BESPOKE JUNO MARK, not an interface glyph, and it is kept on
 * purpose. A stock eye-with-a-slash was tried in its place and rejected: it is
 * the set's general "hide" drawing, and at rest (private mode OFF) a slashed
 * eye reads as if privacy were already on. If it ever moves into the icon
 * set, it goes in as its own drawing on the 256 grid with a regular and a fill
 * cut, and the pointer-tracking eyes stay unless the owner signs off on
 * dropping them.
 *
 * Its geometry lives in `juno-glyph-paths.ts` (`GHOST`) because the native
 * apps do carry it in their icon set — `juno.ghost`, with still eyes, at the
 * set's line, plus a `fill` cut for the "on" state. One drawing, two readers.
 */
export function PrivateChatToggle({
  active,
  disabled,
  onToggle,
}: {
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  /*
   * Off: a quiet 32px icon button beside Share. On: a graphite pill that
   * names the mode, so being incognito is never something you have to infer
   * from a tinted icon. The pill grows out of the button on the base rung.
   */
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={active ? "Leave incognito" : "Turn on incognito"}
          aria-pressed={active}
          disabled={disabled}
          onClick={onToggle}
          className={cn(
            "pressable inline-flex h-8 items-center justify-center gap-1.5 rounded-full text-ui font-medium",
            "transition-[background-color,color,padding,width] duration-base ease-out-soft disabled:pointer-events-none disabled:opacity-50 coarse:h-11",
            "motion-reduce:transition-none motion-reduce:active:scale-100",
            active
              ? "bg-foreground px-3 text-background hover:bg-foreground/90"
              : "w-8 text-foreground/70 hover:bg-accent hover:text-foreground coarse:w-11"
          )}
        >
          <IncognitoGlyph className="size-[18px]" />
          {active ? <span className="motion-safe:animate-fade-in">Incognito</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>{active ? "Incognito is on. Nothing is saved." : "Incognito chat"}</TooltipContent>
    </Tooltip>
  );
}
