"use client";

import * as React from "react";
import type { VoicePhase } from "@/lib/voice-phase";
import { cn } from "@/lib/utils";

/**
 * The one audio-reactive element in a voice call.
 *
 * WHAT IT REPLACED. The dock used to draw three bars at hardcoded heights —
 * `h-2`, `h-3`, `h-1.5` — that never read the audio level at all, plus an
 * opacity `animate-pulse` while the model spoke. It was the most-looked-at
 * element of a live call and it carried no information: you could not tell
 * from it whether your microphone was picking anything up, whether you were
 * too quiet, or whether the model was actually producing sound. Behind the
 * transcript, meanwhile, a canvas drew eighteen 120-point gradient paths per
 * frame and then blurred the result by 9px, destroying the 1.4px crest stroke
 * that was the expensive part.
 *
 * This reads the real level, and it is the only thing that moves.
 *
 * HOW. The caller's rAF loop writes `--level` (0..1) to this element once per
 * frame; the bars scale from it in CSS (`.voice-meter` in globals.css). One
 * style write per frame, no per-bar JavaScript, no compositor promotion, and
 * the value never passes through React.
 *
 * WHOSE VOICE IT IS is shown by fill direction and colour, never by a second
 * hue: bars fill from the centre outward while Juno speaks and left to right
 * while you do. `thinking` detaches from the level entirely — there is no
 * audio to show, and pretending otherwise would be the same lie the hardcoded
 * bars told.
 */
export interface VoiceMeterProps {
  phase: VoicePhase;
  /** `bar` sits in the dock at 16px; `stage` is the larger presentation size. */
  size?: "bar" | "stage";
  className?: string;
}

/** Per-bar gain so the row settles like a needle rather than five identical sticks. */
const GAIN = [0.5, 0.78, 1, 0.78, 0.5];

export const VoiceMeter = React.forwardRef<HTMLSpanElement, VoiceMeterProps>(function VoiceMeter(
  { phase, size = "bar", className },
  ref
) {
  const live = phase === "speaking" || phase === "user-speaking" || phase === "listening";
  const muted = phase === "muted";
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-phase={phase}
      className={cn(
        "voice-meter relative flex shrink-0 items-center",
        size === "stage" ? "h-12 gap-1.5" : "h-4 gap-[3px]",
        className
      )}
    >
      {GAIN.map((gain, i) => (
        <span
          key={i}
          style={{ ["--gain" as string]: gain }}
          className={cn(
            "h-full origin-center rounded-full transition-colors duration-fast ease-out-soft",
            size === "stage" ? "w-1.5" : "w-[3px]",
            phase === "speaking"
              ? "bg-primary"
              : muted
                ? "bg-muted-foreground/40"
                : live
                  ? "bg-foreground/70"
                  : "bg-muted-foreground/40"
          )}
        />
      ))}
      {/* Muted is struck through rather than dimmed. Dimming made muted, idle
          and a dead session pixel-identical — three grey dots — and "is my
          microphone open" is the one question a call must never leave open. */}
      {muted && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-px w-[130%] -translate-x-1/2 -translate-y-1/2 rotate-[-20deg] rounded-full bg-muted-foreground"
        />
      )}
    </span>
  );
});
