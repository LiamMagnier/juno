"use client";

import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import { cn } from "@/lib/utils";

/** States in which an agent is busy on its own: the line carries a slow light. */
export const IN_PROGRESS_STATES: ReadonlySet<AgentState> = new Set(["working", "thinking"]);

/**
 * An agent present on the page: its face with rest life on (it blinks, it
 * glances now and then, it notices you), at a fixed size so a row never
 * shifts as the face moves. Where a second copy of the same agent sits on the
 * page, draw that one as `<AgentFace still>` so only one copy moves. No halo or glow behind it: the face is flat and its state is in
 * its own drawing (agent-face.tsx).
 */
export function AgentPresence({
  avatar,
  state = "idle",
  size,
  name,
  className,
  gaze = false,
  direct = false,
  still = false,
  transitionName,
}: {
  avatar: AgentAvatar;
  state?: AgentState;
  /** The face's size in px. */
  size: number;
  name?: string;
  className?: string;
  /** Kept for callers; there is no halo any more. */
  spread?: number;
  /** Kept for callers; there is no halo any more. */
  haloScale?: number;
  /** The face looks toward the pointer while it is near. Off under reduced motion and on touch. */
  gaze?: boolean;
  /** A preview a person drives: each state change plays at once, without the smoothing (agent-face.tsx). */
  direct?: boolean;
  /**
   * Held still while a larger copy of the same agent is alive elsewhere on the
   * screen: the same face, on the same element, eases into its still frame and
   * stops, and lives again when let go (agent-face.tsx `still`).
   */
  still?: boolean;
  /** A view-transition name, so the face carries across a navigation. */
  transitionName?: string;
}) {
  return (
    <span
      data-state={state}
      className={cn("agent-presence", className)}
      style={{ width: size, height: size, viewTransitionName: transitionName } as React.CSSProperties}
    >
      <AgentFace avatar={avatar} state={state} size={size} name={name} live look={gaze} direct={direct} still={still} />
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
