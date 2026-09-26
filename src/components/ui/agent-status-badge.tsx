"use client";

import * as React from "react";
import { XCircle, ShieldAlert, Terminal, type IconComponent } from "@/components/ui/icons";
import { PhaseOrb, type OrbState } from "@/components/effects/phase-orb";
import { cn } from "@/lib/utils";

export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "running"
  | "waiting_for_input"
  | "waiting_approval"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

interface AgentStatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  status: AgentRunStatus;
  label?: string;
  size?: "sm" | "md" | "lg";
  subtext?: string;
  /** Kept for callers; ignored. Nothing here pulses any more. */
  pulsing?: boolean;
}

/**
 * A run's status, AS WORDS (premium pass, owner directive 2026-09-26).
 *
 * This used to be a tinted, bordered pill with a pinging dot for every state,
 * including the ones that need nothing from anybody (Ready, Running, Done). A
 * pill says "look at me" and a ping says "something is wrong right now"; on a
 * state that is simply normal both are noise, and the owner called them what
 * they read as. Three kinds now:
 *
 *  - ATTENTION (needs input, needs approval, failed): a small icon and the
 *    words in the state's colour. Still no container: colour and the mark say
 *    it, and a filled capsule is what made every state look urgent.
 *  - IN PROGRESS (thinking, running, generating): a Thinking orb sized to the
 *    text line (the brand matrix for its first two seconds) and muted words.
 *  - NORMAL (ready, done, stopped): muted words, nothing else.
 *
 * Still `role="status"` with the full sentence as its name, so a screen
 * reader hears the change.
 */
const ATTENTION: Partial<Record<AgentRunStatus, { Icon: IconComponent; text: string }>> = {
  waiting_for_input: { Icon: Terminal, text: "text-warning-foreground" },
  waiting_approval: { Icon: ShieldAlert, text: "text-warning-foreground" },
  failed: { Icon: XCircle, text: "text-destructive-ink" },
};

const IN_PROGRESS: Partial<Record<AgentRunStatus, OrbState>> = {
  thinking: "breathing",
  running: "working",
  streaming: "composing",
};

const LABEL: Record<AgentRunStatus, string> = {
  idle: "Ready",
  thinking: "Thinking",
  running: "Running",
  waiting_for_input: "Needs input",
  waiting_approval: "Needs approval",
  streaming: "Generating",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

export function AgentStatusBadge({
  status,
  label,
  size = "md",
  subtext,
  pulsing: _pulsing,
  className,
  ...props
}: AgentStatusBadgeProps) {
  const displayLabel = label || LABEL[status] || LABEL.idle;
  const attention = ATTENTION[status];
  const orb = IN_PROGRESS[status];

  return (
    <div
      role="status"
      aria-label={`Status: ${displayLabel}${subtext ? `, ${subtext}` : ""}`}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5",
        size === "sm" && "text-micro",
        size === "md" && "text-caption",
        size === "lg" && "text-ui",
        attention ? cn("font-medium", attention.text) : "text-muted-foreground",
        className
      )}
      {...props}
    >
      {attention ? (
        <attention.Icon aria-hidden="true" className="size-3.5 shrink-0" />
      ) : orb ? (
        <PhaseOrb state={orb} className="-my-1" />
      ) : null}
      <span className="truncate">{displayLabel}</span>
      {subtext && <span className="truncate text-muted-foreground">{subtext}</span>}
    </div>
  );
}
