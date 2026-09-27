import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import { cn } from "@/lib/utils";

/**
 * An agent's face on its halo: a soft radial wash of its own tone, so an agent
 * is recognised by colour before its name is read (docs/design/agents-rework/
 * DIRECTION.md, "The signature detail"). The halo is static; only the face
 * animates, and only for live state.
 */
export function AgentPresence({
  avatar,
  state = "idle",
  size,
  name,
  className,
  haloScale = 1.9,
}: {
  avatar: AgentAvatar;
  state?: AgentState;
  /** The face's size in px. */
  size: number;
  name?: string;
  className?: string;
  /** Halo diameter as a multiple of the face size. */
  haloScale?: number;
}) {
  const halo = Math.round(size * haloScale);
  return (
    <span
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          width: halo,
          height: halo,
          background: `radial-gradient(closest-side, hsl(var(--agent-${avatar.tone}) / 0.22), hsl(var(--agent-${avatar.tone}) / 0.08) 55%, transparent)`,
        }}
      />
      <AgentFace avatar={avatar} state={state} size={size} name={name} className="relative" />
    </span>
  );
}
