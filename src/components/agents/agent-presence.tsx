"use client";

import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import { cn } from "@/lib/utils";

/** States in which an agent is busy on its own: the line carries a slow light. */
export const IN_PROGRESS_STATES: ReadonlySet<AgentState> = new Set(["working", "thinking"]);

/**
 * An agent's face on its halo: a soft wash of its own tone, so an agent is
 * recognised by colour before its name is read. The halo also carries state
 * the way the voice glow does in Chat: quiet at rest, breathing while it
 * works, a slow turning light while it thinks, fuller while it waits on you
 * (agent-face.css, "Presence").
 */
export function AgentPresence({
  avatar,
  state = "idle",
  size,
  name,
  className,
  spread = 0.45,
  haloScale,
  gaze = false,
  transitionName,
}: {
  avatar: AgentAvatar;
  state?: AgentState;
  /** The face's size in px. */
  size: number;
  name?: string;
  className?: string;
  /** How far the halo reaches beyond the face, as a fraction of its size. */
  spread?: number;
  /** Halo diameter as a multiple of the face size. */
  haloScale?: number;
  /** Eyes follow the pointer while it is near. Off under reduced motion. */
  gaze?: boolean;
  /** A view-transition name, so the face carries across a navigation. */
  transitionName?: string;
}) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  useGaze(ref, gaze && state !== "sleeping" && state !== "done");
  const effectiveSpread = haloScale !== undefined ? (haloScale - 1) / 2 : spread;

  return (
    <span
      ref={ref}
      data-state={state}
      className={cn("agent-presence", className)}
      style={
        {
          width: size,
          height: size,
          "--presence-tone": `var(--agent-${avatar.tone})`,
          "--halo-spread": effectiveSpread,
          viewTransitionName: transitionName,
        } as React.CSSProperties
      }
    >
      <AgentFace avatar={avatar} state={state} size={size} name={name} />
    </span>
  );
}

/**
 * The agent's one live sentence ("Drafting the renewal comparison"). A new
 * sentence rises into place; while the agent is busy the words carry a slow
 * light, so progress is seen without a spinner or a pill.
 */
export function AgentStatusLine({
  text,
  state,
  className,
}: {
  text: string;
  state: AgentState;
  className?: string;
}) {
  return (
    <span
      className={cn("agent-status-line", className)}
      data-live={IN_PROGRESS_STATES.has(state) ? "" : undefined}
      aria-live="polite"
    >
      <span key={text}>{text}</span>
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
      el.style.setProperty("--gx", "0");
      el.style.setProperty("--gy", "0");
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
        el.style.setProperty("--gx", (nx * 2.4).toFixed(3));
        el.style.setProperty("--gy", (ny * 1.8).toFixed(3));
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
