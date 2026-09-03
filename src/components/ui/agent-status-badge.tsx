"use client";

import * as React from "react";
import { Loader2, CheckCircle2, AlertTriangle, XCircle, Clock, ShieldAlert, Cpu, Terminal, Bot } from "lucide-react";
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
  pulsing?: boolean;
}

const statusConfig: Record<
  AgentRunStatus,
  {
    label: string;
    dotClass: string;
    bgClass: string;
    borderClass: string;
    textClass: string;
    Icon: React.ElementType;
    animateDot?: boolean;
  }
> = {
  idle: {
    label: "Ready",
    dotClass: "bg-muted-foreground/60",
    bgClass: "bg-secondary/60",
    borderClass: "border-border/60",
    textClass: "text-muted-foreground",
    Icon: Clock,
  },
  thinking: {
    label: "Thinking",
    dotClass: "bg-foreground/80",
    bgClass: "bg-secondary/70",
    borderClass: "border-border/60",
    textClass: "text-foreground font-medium",
    Icon: Cpu,
    animateDot: true,
  },
  running: {
    label: "Running",
    dotClass: "bg-primary",
    bgClass: "bg-primary/10",
    borderClass: "border-primary/25",
    textClass: "text-foreground font-medium",
    Icon: Loader2,
    animateDot: true,
  },
  waiting_for_input: {
    label: "Needs Input",
    dotClass: "bg-warning",
    bgClass: "bg-warning/10",
    borderClass: "border-warning/25",
    textClass: "text-warning-foreground font-medium",
    Icon: Terminal,
    animateDot: true,
  },
  waiting_approval: {
    label: "Needs Approval",
    dotClass: "bg-warning",
    bgClass: "bg-warning/10",
    borderClass: "border-warning/25",
    textClass: "text-warning-foreground font-medium",
    Icon: ShieldAlert,
    animateDot: true,
  },
  streaming: {
    label: "Generating",
    dotClass: "bg-foreground/80",
    bgClass: "bg-secondary/70",
    borderClass: "border-border/60",
    textClass: "text-foreground font-medium",
    Icon: Bot,
    animateDot: true,
  },
  completed: {
    label: "Done",
    dotClass: "bg-success",
    bgClass: "bg-success/10",
    borderClass: "border-success/25",
    textClass: "text-success-ink font-medium",
    Icon: CheckCircle2,
  },
  failed: {
    label: "Failed",
    dotClass: "bg-destructive",
    bgClass: "bg-destructive/10",
    borderClass: "border-destructive/25",
    textClass: "text-destructive-ink font-medium",
    Icon: XCircle,
  },
  cancelled: {
    label: "Stopped",
    dotClass: "bg-muted-foreground/60",
    bgClass: "bg-muted/40",
    borderClass: "border-border/60",
    textClass: "text-muted-foreground",
    Icon: AlertTriangle,
  },
};

export function AgentStatusBadge({
  status,
  label,
  size = "md",
  subtext,
  pulsing,
  className,
  ...props
}: AgentStatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.idle;
  const displayLabel = label || config.label;
  const isPulsing = pulsing !== undefined ? pulsing : config.animateDot;

  return (
    <div
      role="status"
      aria-label={`Status: ${displayLabel}${subtext ? ` — ${subtext}` : ""}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 transition-[color,background-color,border-color] duration-base ease-out-soft",
        config.bgClass,
        config.borderClass,
        config.textClass,
        size === "sm" && "px-2 py-0.5 text-micro",
        size === "md" && "px-2.5 py-0.5 text-caption",
        size === "lg" && "px-3 py-1 text-ui font-medium",
        className
      )}
      {...props}
    >
      <span className="relative flex size-2 items-center justify-center">
        {isPulsing && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-75",
              config.dotClass
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", config.dotClass)} />
      </span>

      <span className="font-mono tracking-tight">{displayLabel}</span>

      {subtext && (
        <span className="font-mono text-muted-foreground/80 opacity-90">· {subtext}</span>
      )}
    </div>
  );
}
