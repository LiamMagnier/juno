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
const VOICE_FIELD =
  "radial-gradient(circle at 30% 24%, hsl(190 88% 70%) 0%, hsl(222 78% 58%) 48%, hsl(263 62% 46%) 100%)";

/**
 * A restrained audio mark: one matte circle and a five-bar waveform. The bars
 * follow the live amplitude without React re-renders, keeping the animation
 * responsive while the transcript scrolls behind it.
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
        const height = Math.min(15, 4 + profile * 4 + smooth * 7 * profile + thinkingWave);
        root.style.setProperty(`--voice-bar-${index}`, `${height.toFixed(2)}px`);
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
          "absolute inset-px -z-10 rounded-full border transition-colors duration-base",
          status === "error" ? "border-destructive" : "border-[hsl(222_78%_62%)]"
        )}
        style={{
          opacity: "var(--voice-ring-opacity, .14)",
          transform: "scale(var(--voice-ring-scale, 1))",
        }}
      />
      <span
        className={cn(
          "absolute inset-[2px] flex items-center justify-center rounded-full border border-white/15 text-white shadow-[0_2px_9px_hsl(226_65%_44%/0.24)] transition-[filter,opacity] duration-base",
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
              className="block w-[1.5px] rounded-full bg-current transition-[height] duration-fast ease-out"
              style={{ height: `var(--voice-bar-${index}, 6px)` }}
            />
          ))}
        </span>
      </span>
    </span>
  );
}
