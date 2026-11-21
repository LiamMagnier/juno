"use client";

import * as React from "react";
import { IncognitoGlyph, incognitoGestureFor, type IncognitoGesture } from "@/components/chat/incognito-glyph";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
// The mark's gesture and the incognito room (the panel's ground, the
// greeting's entrance). Imported here because chat-view imports this toggle,
// so the sheet is on every chat page and the still mark elsewhere needs none.
import "@/components/chat/incognito.css";

/**
 * The incognito switch at the right of the chat's header band.
 *
 * "Incognito", everywhere the mode is named: the toggle, its tooltip, the
 * band on a phone and the page's own greeting.
 *
 * ONE CONTROL, BOTH STATES. It stays where it is when incognito turns on and
 * becomes the way back out: chat-view keeps the header band mounted in
 * incognito (it used to drop it, and this button with it, for a separate band
 * with a close button), so the thing you pressed is the thing that answers,
 * and pressing it again is how you leave.
 *
 *   Off: a 36px control, the same rung as Share beside it, the mark in
 *   outline at full ink.
 *   On: a tinted control that names the mode, the mark in its filled cut. The
 *   mark keeps its place at the control's end, so it plays its gesture
 *   where the eye already is, and the word grows in to its left. The label
 *   joins the glyph in one frame (width never tweens, D27); its
 *   fill, ink and word cross-fade in.
 *
 * The mark plays one gesture per change (incognito.css): on, the hat settles
 * onto the head and the shades onto the face; off, the brim tips. Under
 * reduced motion only the fill fades. 44px under a finger (`hit-44`).
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
  // Derived during render (React's "storing information from previous
  // renders"), so the gesture starts in the same frame as the fill change
  // rather than one effect later.
  const [seen, setSeen] = React.useState(active);
  const [gesture, setGesture] = React.useState<IncognitoGesture | null>(null);
  if (seen !== active) {
    setGesture((current) => incognitoGestureFor(seen, active, current));
    setSeen(active);
  }
  const label = active ? "Leave incognito" : "Turn on incognito";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          // How chat-view finds this button to hand focus back to it when the
          // phone band's close button folds away under the reader.
          data-incognito-toggle=""
          data-state-on={active ? "" : undefined}
          disabled={disabled}
          onClick={onToggle}
          className={cn(
            "hit-44 relative inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-control text-ui font-medium outline-none",
            "transition-[background-color,color,transform] duration-base ease-out-soft active:scale-[0.97] active:duration-press",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-colors motion-reduce:active:scale-100",
            active
              ? "bg-foreground/10 ps-3 pe-[9px] text-foreground ring-1 ring-inset ring-foreground/10 hover:bg-foreground/15"
              : "w-9 text-foreground hover:bg-accent"
          )}
        >
          {active ? (
            <span className="tracking-[-0.005em] motion-safe:animate-[incognito-word-in_220ms_var(--ease-out-expo)_both] motion-reduce:animate-fade-in">
              Incognito
            </span>
          ) : null}
          <IncognitoGlyph on={active} size={18} gesture={gesture} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">{active ? "Leave incognito" : "Incognito chat"}</TooltipContent>
    </Tooltip>
  );
}
