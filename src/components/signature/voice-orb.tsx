"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type OrbStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

const FLOOR: Record<OrbStatus, number> = {
  idle: 0.03,
  listening: 0.12,
  thinking: 0.2,
  speaking: 0.3,
  error: 0.02,
};

/**
 * A small liquid voice mark driven by one CSS variable. Audio analysis only
 * updates the wrapper transform/glow; the mesh itself is pure CSS and remains
 * cheap enough to sit beside a scrolling transcript.
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

    const render = () => {
      const audio = Math.max(0, Math.min(1, liveLevelRef.current?.current ?? 0));
      const target = Math.max(FLOOR[statusRef.current], audio);
      smooth += (target - smooth) * 0.18;
      root.style.setProperty("--voice-breathe", String(0.965 + smooth * 0.1));
      root.style.setProperty("--voice-halo", String(0.16 + smooth * 0.32));
      if (!reducedMotion) frame = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <span
      ref={rootRef}
      aria-hidden="true"
      data-status={status}
      className={cn(
        "relative block aspect-square rounded-full isolate",
        status === "error" ? "[--voice-a:var(--destructive)] [--voice-b:0_74%_48%]" : "[--voice-a:var(--primary)] [--voice-b:191_88%_54%]",
        className
      )}
    >
      <span
        className="absolute inset-[4%] -z-10 rounded-full bg-[hsl(var(--voice-a)/var(--voice-halo,0.2))] blur-[8px]"
        style={{ transform: "scale(var(--voice-breathe,1))" }}
      />
      <span
        className={cn(
          "absolute inset-[8%] overflow-hidden rounded-full border border-white/20 shadow-[inset_0_1px_1px_rgba(255,255,255,0.48),inset_0_-7px_14px_rgba(0,0,0,0.12),0_4px_14px_hsl(var(--voice-a)/0.22)]",
          status === "thinking" && "motion-safe:animate-[spin_3.4s_linear_infinite]"
        )}
        style={{
          transform: "scale(var(--voice-breathe,1))",
          background:
            "radial-gradient(circle at 31% 24%, rgba(255,255,255,.96) 0 5%, rgba(255,255,255,.28) 17%, transparent 34%), radial-gradient(circle at 72% 72%, hsl(var(--voice-b) / .96) 0 10%, transparent 56%), radial-gradient(circle at 72% 22%, hsl(var(--voice-a) / .86), transparent 48%), linear-gradient(145deg, hsl(var(--voice-a) / .98), hsl(var(--voice-b) / .72))",
        }}
      >
        <span className="absolute -left-[16%] top-[34%] h-[48%] w-[92%] rotate-[-18deg] rounded-full bg-white/20 blur-[5px] motion-safe:animate-[pulse_2.4s_ease-in-out_infinite]" />
        <span className="absolute -bottom-[28%] right-[-12%] size-[76%] rounded-full bg-black/10 blur-[7px]" />
      </span>
      <span className="absolute inset-[20%] rounded-full border border-white/10" />
    </span>
  );
}
