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
  /** A view-transition name, so the face carries across a navigation. */
  transitionName?: string;
}) {
  return (
    <span
      data-state={state}
      className={cn("agent-presence", className)}
      style={
        {
          width: size,
          height: size,
          "--presence-tone": `var(--agent-${avatar.tone})`,
          "--halo-spread": spread,
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
