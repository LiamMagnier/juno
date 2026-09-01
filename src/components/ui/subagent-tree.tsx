"use client";

import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  FileCode,
  StopCircle,
  Eye,
  Bot,
  Clock,
  Sparkles,
} from "lucide-react";
import { AgentStatusBadge, type AgentRunStatus } from "@/components/ui/agent-status-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SubagentItem {
  id: string;
  name: string;
  role?: string;
  mission: string;
  status: AgentRunStatus;
  elapsedTime?: string;
  branch?: string;
  worktree?: string;
  filesTouched?: string[];
  resultSummary?: string;
}

interface SubagentTreeProps {
  mainAgentTitle?: string;
  subagents: SubagentItem[];
  onInspectSubagent?: (subagent: SubagentItem) => void;
  onStopSubagent?: (subagentId: string) => void;
  defaultExpanded?: boolean;
  className?: string;
}

export function SubagentTree({
  mainAgentTitle = "Main Agent",
  subagents = [],
  onInspectSubagent,
  onStopSubagent,
  defaultExpanded = false,
  className,
}: SubagentTreeProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const [selectedSubagentId, setSelectedSubagentId] = React.useState<string | null>(null);

  const runningCount = React.useMemo(
    () =>
      subagents.filter(
        (s) => s.status === "running" || s.status === "thinking" || s.status === "streaming"
      ).length,
    [subagents]
  );
  const needsInputCount = React.useMemo(
    () =>
      subagents.filter(
        (s) => s.status === "waiting_for_input" || s.status === "waiting_approval"
      ).length,
    [subagents]
  );

  const summaryText = React.useMemo(() => {
    if (runningCount > 0) {
      return `Working with ${subagents.length} agent${subagents.length > 1 ? "s" : ""} (${runningCount} active)`;
    }
    if (needsInputCount > 0) {
      return `${needsInputCount} agent${needsInputCount > 1 ? "s" : ""} need${needsInputCount === 1 ? "s" : ""} input`;
    }
    return `${subagents.length} delegated agent${subagents.length > 1 ? "s" : ""}`;
  }, [subagents.length, runningCount, needsInputCount]);

  if (!subagents || subagents.length === 0) return null;

  return (
    <div
      className={cn(
        "group/subagents rounded-card border border-border/80 bg-secondary/40 shadow-soft transition-all duration-base",
        className
      )}
    >
      {/* Summary Header (Collapsed / Toggle) */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors duration-fast hover:bg-accent/40 rounded-t-card aria-expanded:border-b aria-expanded:border-border/60"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative flex size-6 shrink-0 items-center justify-center rounded-xs bg-primary/10 text-primary">
            <Bot className="size-3.5" />
            {runningCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate font-mono text-ui font-medium text-foreground">
              {summaryText}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="flex -space-x-1.5">
            {subagents.slice(0, 4).map((s) => (
              <span
                key={s.id}
                title={`${s.name} (${s.status})`}
                className={cn(
                  "size-2 rounded-full ring-2 ring-card",
                  s.status === "running" && "bg-primary animate-pulse",
                  s.status === "completed" && "bg-success",
                  s.status === "waiting_for_input" && "bg-warning",
                  s.status === "failed" && "bg-destructive",
                  s.status === "idle" && "bg-muted-foreground/60"
                )}
              />
            ))}
          </div>
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground transition-transform duration-fast" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground transition-transform duration-fast" />
          )}
        </div>
      </button>

      {/* Expanded Hierarchy View */}
      {expanded && (
        <div className="p-3 space-y-2 motion-safe:animate-rise-in">
          {/* Main Parent Agent */}
          <div className="flex items-center gap-2 px-1 text-caption font-mono text-muted-foreground">
            <Sparkles className="size-3 text-primary" />
            <span className="font-semibold text-foreground">{mainAgentTitle}</span>
            <span>(orchestrator)</span>
          </div>

          {/* Subagent Tree List */}
          <div className="relative ml-2.5 pl-3 border-l-2 border-border/80 space-y-2">
            {subagents.map((sub, idx) => {
              const isLast = idx === subagents.length - 1;
              const isSelected = selectedSubagentId === sub.id;

              return (
                <div
                  key={sub.id}
                  className={cn(
                    "relative rounded-field border border-border/70 bg-card p-3 transition-all duration-fast",
                    isSelected && "border-primary/50 shadow-soft"
                  )}
                >
                  {/* Tree Connector Line */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute -left-[14px] top-4 h-px w-3 bg-border/80",
                      isLast && "before:absolute before:-left-px before:top-0 before:h-full before:w-px before:bg-background"
                    )}
                  />

                  {/* Header: Name, Role, Status */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-ui font-medium text-foreground">
                          {sub.name}
                        </span>
                        {sub.role && (
                          <span className="font-mono text-micro text-muted-foreground">
                            · {sub.role}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-caption text-muted-foreground line-clamp-1">
                        {sub.mission}
                      </p>
                    </div>

                    <AgentStatusBadge status={sub.status} size="sm" />
                  </div>

                  {/* Meta / Details Pill Row */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-micro text-muted-foreground/80">
                    {sub.elapsedTime && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {sub.elapsedTime}
                      </span>
                    )}

                    {sub.branch && (
                      <span className="inline-flex items-center gap-1">
                        <GitBranch className="size-3" />
                        {sub.branch}
                      </span>
                    )}

                    {sub.filesTouched && sub.filesTouched.length > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <FileCode className="size-3" />
                        {sub.filesTouched.length} file{sub.filesTouched.length > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>

                  {/* Result Summary if available */}
                  {sub.resultSummary && (
                    <p className="mt-2 rounded-xs bg-secondary/80 px-2 py-1 font-mono text-caption text-foreground/90">
                      {sub.resultSummary}
                    </p>
                  )}

                  {/* Actions Row */}
                  {(onInspectSubagent || onStopSubagent) && (
                    <div className="mt-2.5 flex items-center justify-end gap-1.5 pt-1.5 border-t border-border/50">
                      {onInspectSubagent && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-2 text-micro"
                          onClick={() => {
                            setSelectedSubagentId(sub.id);
                            onInspectSubagent(sub);
                          }}
                        >
                          <Eye className="size-3" /> Inspect
                        </Button>
                      )}

                      {onStopSubagent && (sub.status === "running" || sub.status === "thinking") && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-2 text-micro text-destructive hover:bg-destructive/10"
                          onClick={() => onStopSubagent(sub.id)}
                        >
                          <StopCircle className="size-3" /> Stop
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
