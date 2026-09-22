"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type OrbStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

const FLOOR: Record<OrbStatus, number> = {
  idle: 0,
  listening: 0.05,
  thinking: 0.16,
  speaking: 0.1,
  error: 0,
};

const BAR_PROFILE = [0.48, 0.78, 1, 0.72, 0.42] as const;
/** The tallest a bar draws, in px. Bars are laid out at this height and
 *  scaled down on the compositor rather than re-laid out every frame. */
const BAR_MAX = 15;
const VOICE_FIELD =
  "radial-gradient(circle at 30% 24%, hsl(190 88% 70%) 0%, hsl(222 78% 58%) 48%, hsl(263 62% 46%) 100%)";

/**
 * A restrained audio mark: one matte circle and a five-bar waveform. The bars
 * follow the live amplitude without React re-renders, keeping the animation
 * responsive while the transcript scrolls behind it.
 *
 * Each bar is a fixed-height stroke scaled on Y (transform, never `height`),
 * and the per-frame smoothing below is the only easing it gets: a CSS
 * transition on top of a value rewritten every frame only made the bars lag
 * the voice they were drawing.
 */
export function VoiceOrb({
  status,
  levelRef,
  className,
}: {
  status: OrbStatus;
  levelRef?: React.MutableRefObject<number>;
  className?: string;
}) {
  const rootRef = React.useRef<HTMLSpanElement>(null);
  const statusRef = React.useRef(status);
  const liveLevelRef = React.useRef(levelRef);
  statusRef.current = status;
  liveLevelRef.current = levelRef;

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let smooth = FLOOR[statusRef.current];

    const render = (time: number) => {
      const currentStatus = statusRef.current;
      const audio = Math.max(0, Math.min(1, liveLevelRef.current?.current ?? 0));
      const target = Math.max(FLOOR[currentStatus], audio);
      smooth += (target - smooth) * 0.2;

      BAR_PROFILE.forEach((profile, index) => {
        const thinkingWave =
          currentStatus === "thinking" && !reducedMotion
            ? (Math.sin(time / 190 + index * 0.9) + 1) * 0.9
            : 0;
        const height = Math.min(BAR_MAX, 4 + profile * 4 + smooth * 7 * profile + thinkingWave);
        root.style.setProperty(`--voice-bar-${index}`, (height / BAR_MAX).toFixed(3));
      });
      root.style.setProperty("--voice-ring-scale", String(1 + smooth * 0.07));
      root.style.setProperty("--voice-ring-opacity", String(0.2 + smooth * 0.32));
      root.style.setProperty("--voice-orb-scale", String(0.985 + smooth * 0.035));

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <span
      ref={rootRef}
      aria-hidden="true"
      data-status={status}
      className={cn("relative block aspect-square shrink-0 isolate", className)}
    >
      <span
        className={cn(
          "absolute inset-px -z-10 rounded-full border transition-colors duration-base ease-out-soft",
          status === "error" ? "border-destructive" : "border-[hsl(222_78%_62%)]"
        )}
        style={{
          opacity: "var(--voice-ring-opacity, .14)",
          transform: "scale(var(--voice-ring-scale, 1))",
        }}
      />
      <span
        className={cn(
          "absolute inset-[2px] flex items-center justify-center rounded-full border border-white/15 text-white shadow-[0_2px_9px_hsl(226_65%_44%/0.24)] transition-[filter,opacity] duration-base ease-out-soft",
          status === "idle" && "opacity-70 saturate-[.35]",
          status === "error" && "border-destructive bg-destructive text-destructive-foreground shadow-none"
        )}
        style={{
          background: status === "error" ? undefined : VOICE_FIELD,
          transform: "scale(var(--voice-orb-scale, 1))",
        }}
      >
        <span className="flex h-4 items-center gap-[1.5px]">
          {BAR_PROFILE.map((_, index) => (
            <span
              key={index}
              className="block h-[15px] w-[1.5px] rounded-full bg-current"
              // 0.4 = the 6px resting bar the layout drew before the first frame.
              style={{ transform: `scaleY(var(--voice-bar-${index}, 0.4))` }}
            />
          ))}
        </span>
      </span>
    </span>
  );
}
