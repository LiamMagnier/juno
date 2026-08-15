"use client";

import * as React from "react";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { cn } from "@/lib/utils";

/**
 * The dictation capsule and the composer, sharing one grid cell.
 *
 * Extracted from `work-composer.tsx`. It is a layout mechanism with two moving
 * parts and four comments explaining why each is the way it is, and none of that
 * is about starting a task — which is what the file it was sitting in the middle
 * of is for.
 *
 * ── Why a cross-fade rather than a swap ────────────────────────────────────
 *
 * This is how the chat, thread and Code composers all do it, and it is a change
 * of arrangement from what Work used to do: the capsule was rendered INSIDE the
 * shell, above the field, so the shell grew and shrank around it. That was
 * tolerable while the shell had one tier. With a utility strip attached
 * underneath, a capsule pushing the field down also pushes the strip down — and
 * the one element on this page that is supposed to sit still, the standing
 * context of the run, moved every time somebody reached for the microphone.
 *
 * `min-height` is the only animated layout property. The transcript preview
 * floats above the capsule and needs the headroom; the two layers themselves
 * move on opacity and transform, which stay on the compositor.
 */
export function WorkDictationLayer({
  active,
  onCancel,
  /** The transcript, and whether the reader asked for it to be sent. */
  onClose,
  children,
}: {
  active: boolean;
  onCancel: () => void;
  onClose: (transcript: string, sendNow: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative grid w-full grid-cols-1 grid-rows-1 items-end justify-items-center",
        "transition-[min-height] duration-slow ease-out-strong motion-reduce:transition-none",
        active ? "min-h-[170px]" : "min-h-0"
      )}
    >
      <Layer hidden={!active} className="z-30 flex justify-center" scale="scale-95">
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

      {/* The fade is on a wrapper rather than on the shell: `ComposerShell`
          already declares `transition-[border-color,box-shadow]`, and a second
          arbitrary `transition-[…]` on the same element is resolved by
          stylesheet order rather than by class order — so one of the two would
          silently win, and which one is not something this file gets to
          decide. */}
      <Layer hidden={active} scale="scale-[0.98]">
        {children}
      </Layer>
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
 * it. Same defect the chat transcript's jump-to-latest button had.
 *
 * The two halves were written out twice with that paragraph copied verbatim
 * above each, which is how they came to differ: one settled at `scale-95` and
 * the other at `scale-[0.98]`, and only one of them carried the `z-30` that puts
 * the capsule over the shell. The scale stays a prop because the difference is
 * deliberate — the capsule is a smaller object and can afford to come further —
 * and everything else is now the same by construction.
 */
function Layer({
  hidden,
  scale,
  className,
  children,
}: {
  hidden: boolean;
  scale: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      inert={hidden}
      className={cn(
        "col-start-1 row-start-1 w-full transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
        className,
        hidden ? cn("pointer-events-none translate-y-1 opacity-0", scale) : "translate-y-0 opacity-100"
      )}
    >
      {children}
    </div>
  );
}
