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
   * Off: a quiet 36px circle, the same rung as Share beside it (Pressable's
   * `icon lg`, a size-5 glyph), so the header cluster is one family. On: the
   * homepage's solid primary, near-white with dark ink in the dark theme, as a
   * pill that names the mode, so being incognito is never something you have
   * to infer from a tinted icon. The pill grows out of the circle on the
   * homepage's ease, and presses at .97 like the homepage's buttons.
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
            "inline-flex h-9 items-center justify-center gap-2 rounded-full text-ui font-medium outline-none coarse:h-11",
            "transition-[background-color,color,padding,width,transform] duration-base ease-out-expo active:scale-[0.97] active:duration-75",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-colors motion-reduce:active:scale-100",
            active
              ? "bg-foreground pl-3 pr-3.5 text-background hover:bg-foreground/90"
              : "w-9 text-foreground/75 hover:bg-accent hover:text-foreground coarse:w-11"
          )}
        >
          <IncognitoGlyph className="size-5" strokeWidth={1.5} />
          {active ? <span className="tracking-[-0.005em] motion-safe:animate-fade-in">Incognito</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>{active ? "Incognito is on. Nothing is saved." : "Incognito chat"}</TooltipContent>
    </Tooltip>
  );
}
