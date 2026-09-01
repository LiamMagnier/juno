"use client";

import * as React from "react";
import { Loader2, CheckCircle2, AlertTriangle, XCircle, Clock, ShieldAlert, Sparkles, Terminal } from "lucide-react";
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
    dotClass: "bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)]",
    bgClass: "bg-primary/10",
    borderClass: "border-primary/30",
    textClass: "text-primary font-medium",
    Icon: Sparkles,
    animateDot: true,
  },
  running: {
    label: "Running",
    dotClass: "bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)]",
    bgClass: "bg-primary/10",
    borderClass: "border-primary/30",
    textClass: "text-primary font-medium",
    Icon: Loader2,
    animateDot: true,
  },
  waiting_for_input: {
    label: "Needs Input",
    dotClass: "bg-warning shadow-[0_0_8px_hsl(var(--warning)/0.6)]",
    bgClass: "bg-warning/10",
    borderClass: "border-warning/30",
    textClass: "text-warning-foreground font-medium",
    Icon: Terminal,
    animateDot: true,
  },
  waiting_approval: {
    label: "Needs Approval",
    dotClass: "bg-warning shadow-[0_0_8px_hsl(var(--warning)/0.6)]",
    bgClass: "bg-warning/10",
    borderClass: "border-warning/30",
    textClass: "text-warning-foreground font-medium",
    Icon: ShieldAlert,
    animateDot: true,
  },
  streaming: {
    label: "Generating",
    dotClass: "bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.6)]",
    bgClass: "bg-primary/10",
    borderClass: "border-primary/30",
    textClass: "text-primary font-medium",
    Icon: Sparkles,
    animateDot: true,
  },
  completed: {
    label: "Done",
    dotClass: "bg-success shadow-[0_0_6px_hsl(var(--success)/0.4)]",
    bgClass: "bg-success/10",
    borderClass: "border-success/30",
    textClass: "text-success-ink font-medium",
    Icon: CheckCircle2,
  },
  failed: {
    label: "Failed",
    dotClass: "bg-destructive shadow-[0_0_6px_hsl(var(--destructive)/0.4)]",
    bgClass: "bg-destructive/10",
    borderClass: "border-destructive/30",
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
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 transition-all duration-base",
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
