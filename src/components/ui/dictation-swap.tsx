"use client";

import * as React from "react";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { cn } from "@/lib/utils";

/**
 * The composer and its dictation state, sharing one grid cell.
 *
 * WHY THE MOTION IS ONLY A CROSS-FADE NOW.
 *
 * Dictation used to be a floating capsule: a different shape, a different
 * width and a different material from the composer it replaced. Swapping
 * those two needed the transition to do a lot of apologising — each half
 * scaled and slid, and the cell animated its own height from 68px to 170px
 * over `duration-slow` to open headroom for a transcript panel that floated
 * above the capsule. Three properties moved so that two objects could pretend
 * to be one.
 *
 * They are one now. `ComposerDictation` wears the composer's own surface,
 * radius and padding, so the only honest difference between the two states is
 * what the box CONTAINS. A cross-fade says exactly that, and anything more —
 * a scale, a slide, a height animation — reinstates the lie that something
 * arrived. The height is left to the content, which is why the cell no longer
 * animates it: both halves are composer-sized, so there is nothing to travel.
 *
 * The fade is `duration-fast`. A mode change the user just asked for should
 * be over before they look up from the button they pressed.
 *
 * This replaces four hand-inlined copies of the same markup, which had already
 * drifted: one settled at `scale-95` and another at `scale-[0.98]`, two used a
 * 68px floor and two used none, and one had lost the `inert` that the other
 * three carried a five-line comment about.
 */
export function DictationSwap({
  active,
  onCancel,
  /** The transcript, and whether the reader asked for it to be sent. */
  onClose,
  className,
  children,
}: {
  active: boolean;
  onCancel: () => void;
  onClose: (transcript: string, sendNow: boolean) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("relative grid w-full grid-cols-1 grid-rows-1 items-end", className)}>
      <Layer hidden={!active} className="z-30">
        {/* Mounted only while active — ComposerDictation holds a microphone
            stream and a recognition session for its whole life. */}
        {active && (
          <ComposerDictation
            onCancel={onCancel}
            onStop={(transcript) => onClose(transcript, false)}
            onSend={(transcript) => onClose(transcript, true)}
          />
        )}
      </Layer>
      <Layer hidden={active}>{children}</Layer>
    </div>
  );
}

/**
 * One half of the cross-fade.
 *
 * `inert` is what actually takes the hidden half out of the page. `opacity-0
 * pointer-events-none` hides it from the eye and the mouse and leaves it in the
 * tab order and the accessibility tree, so a keyboard or screen-reader user
 * could reach a composer that is not on screen — and, mid-dictation, type into
 * it.
 *
 * The fade sits on this wrapper rather than on the shell inside it:
 * `.composer-surface` already declares its own focus transition, and a second
 * `transition-[…]` on the same element is resolved by stylesheet order rather
 * than class order, so one of the two would silently win.
 */
function Layer({
  hidden,
  className,
  children,
}: {
  hidden: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      inert={hidden}
      className={cn(
        "col-start-1 row-start-1 w-full transition-opacity duration-fast ease-out-soft motion-reduce:transition-none",
        hidden ? "pointer-events-none opacity-0" : "opacity-100",
        className
      )}
    >
      {children}
    </div>
  );
}
