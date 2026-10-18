"use client";

/**
 * A run agent's face in Code: the same 2D character the Orbit roster draws
 * (`AgentFace`), derived from the agent's role and id (run-avatar.ts), with its
 * eyes saying what it is doing. It replaces the dots, the galaxy and the state
 * glyphs that used to stand beside agent rows. The face is decoration: every
 * caller prints the agent's name and its state in words beside it.
 *
 * Motion stays inside the face's own tiers (AGENTS.md §4.2, MOTION.md) and
 * only a few faces loop at once (useFaceMotionSlot); reduced motion keeps the
 * eyes' shape and stops the rest.
 */
import * as React from "react";
import { AgentFace, type AgentFaceSize } from "@/components/agents/agent-face";
import { useFaceMotionSlot } from "@/components/agents/face-motion-slot";
import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import { ANIMATED_FACE_STATES, runAgentAvatars } from "@/lib/agents/run-avatar";
import type { TurnItem } from "@/lib/code-v2/contracts";
import { LEAD_NODE_ID, latestAgentItems } from "@/lib/code-v2/agent-tree";
import { cn } from "@/lib/utils";

export function RunAgentFace({ avatar, state, size = "xs", className }: { avatar: AgentAvatar; state: AgentState; size?: AgentFaceSize; className?: string }) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const moving = useFaceMotionSlot(ANIMATED_FACE_STATES.has(state), ref);
  return (
    <span ref={ref} className={cn("cv2-aface", className)} data-size={size} aria-hidden="true">
      <AgentFace avatar={avatar} state={state} size={size} still={!moving} />
    </span>
  );
}

/** Up to three faces, overlapped, for a group's header line. */
export function RunAgentFaceStack({ faces, max = 3 }: { faces: readonly { id: string; avatar: AgentAvatar; state: AgentState }[]; max?: number }) {
  if (!faces.length) return null;
  return (
    <span className="cv2-afaces" aria-hidden="true">
      {faces.slice(0, max).map((f) => (
        <RunAgentFace key={f.id} avatar={f.avatar} state={f.state} />
      ))}
    </span>
  );
}

/**
 * Every agent of the run's face, keyed by agent id, with the lead under
 * `LEAD_NODE_ID`. The lead is first and the rest in arrival order, so a new
 * agent never changes a face already on screen.
 */
export function useRunAvatars(items: readonly TurnItem[]): Map<string, AgentAvatar> {
  const agents = React.useMemo(() => latestAgentItems(items).map((a) => `${a.agentId}\u0000${a.role}\u0000${a.phase ?? ""}`).join("\u0001"), [items]);
  return React.useMemo(() => {
    const list = agents ? agents.split("\u0001").map((row) => row.split("\u0000")) : [];
    return runAgentAvatars([{ id: LEAD_NODE_ID, role: "orchestrator" }, ...list.map(([id, role, phase]) => ({ id: id!, role, phase: phase || null }))]);
  }, [agents]);
}
