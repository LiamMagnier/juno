"use client";

import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import { cn } from "@/lib/utils";

/**
 * An agent's face on its halo: a soft radial wash of its own tone, so an agent
 * is recognised by colour before its name is read (docs/design/agents-rework/
 * DIRECTION.md, "The signature detail"). The halo is static; only the face
 * animates, and only for live state or, with `gaze`, toward the pointer.
 */
export function AgentPresence({
  avatar,
  state = "idle",
  size,
  name,
  className,
  haloScale = 1.9,
  gaze = false,
  transitionName,
}: {
  avatar: AgentAvatar;
  state?: AgentState;
  /** The face's size in px. */
  size: number;
  name?: string;
  className?: string;
  /** Halo diameter as a multiple of the face size. */
  haloScale?: number;
  /** Eyes follow the pointer while it is near. Off under reduced motion. */
  gaze?: boolean;
  /** A view-transition name, so the face carries across a navigation. */
  transitionName?: string;
}) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  useGaze(ref, gaze && state !== "sleeping" && state !== "done");
  const halo = Math.round(size * haloScale);
  return (
    <span
      ref={ref}
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size, viewTransitionName: transitionName } as React.CSSProperties}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: halo,
          height: halo,
          background: `radial-gradient(closest-side, hsl(var(--agent-${avatar.tone}) / 0.24), hsl(var(--agent-${avatar.tone}) / 0.09) 55%, transparent)`,
        }}
      />
      <AgentFace avatar={avatar} state={state} size={size} name={name} className="relative" />
    </span>
  );
}

/**
 * Sets `--gaze-x` / `--gaze-y` (each -1 to 1) on the element from the pointer's
 * position relative to it: full strength nearby, easing back to centre with
 * distance. One pointer listener per face, throttled to a frame.
 */
function useGaze(ref: React.RefObject<HTMLSpanElement | null>, enabled: boolean) {
  React.useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    let frame = 0;
    let visible = true;
    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true;
          })
        : null;
    observer?.observe(el);
    const reset = () => {
      el.style.setProperty("--gaze-x", "0");
      el.style.setProperty("--gaze-y", "0");
    };
    const onMove = (event: PointerEvent) => {
      if (!visible || frame) return;
      const { clientX, clientY } = event;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = el.getBoundingClientRect();
        const dx = clientX - (rect.left + rect.width / 2);
        const dy = clientY - (rect.top + rect.height / 2);
        const distance = Math.hypot(dx, dy);
        const reach = Math.max(260, rect.width * 5);
        const strength = Math.max(0, 1 - distance / reach);
        const nx = distance ? (dx / distance) * strength : 0;
        const ny = distance ? (dy / distance) * strength : 0;
        el.style.setProperty("--gaze-x", nx.toFixed(3));
        el.style.setProperty("--gaze-y", ny.toFixed(3));
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", reset);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", reset);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      reset();
    };
  }, [ref, enabled]);
}
