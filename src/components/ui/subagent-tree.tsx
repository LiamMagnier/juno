"use client";

import * as React from "react";
import {
  ChevronRight,
  GitBranch,
  FileCode,
  StopCircle,
  Eye,
  Bot,
  Clock,
} from "@/components/ui/icons";
import { AgentStatusBadge, type AgentRunStatus } from "@/components/ui/agent-status-badge";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
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
        "group/subagents rounded-card border border-border/80 bg-secondary/40 shadow-soft transition-[border-color,box-shadow,background-color] duration-base ease-out-soft",
        className
      )}
    >
      {/* Summary Header (Collapsed / Toggle) */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        // The hairline under the header is always there and only changes
        // colour, so opening the tree never nudges the header by a pixel; the
        // hover fill rounds all four corners while the card is closed.
        className="flex w-full items-center justify-between gap-3 rounded-card border-b border-transparent px-3.5 py-2.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent/40 aria-expanded:rounded-b-none aria-expanded:border-border/60"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative flex size-6 shrink-0 items-center justify-center rounded-xs bg-primary/10 text-primary">
            <Bot className="size-3.5" />
            {/* No ping dot: the summary beside it already says how many are
                running, and a pinging pip on a normal state reads as an alarm. */}
          </div>
          <div className="min-w-0">
            <p className="truncate font-mono text-ui font-medium text-foreground">
              {summaryText}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* The row of coloured pips (one per agent, the running one
              pulsing) is gone: the summary text names the count and the
              states that need someone, and the list below names each one. */}
          {/* One caret that turns, on the symmetric curve — a disclosure
              has both of its ends on screen. */}
          <ChevronRight
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none",
              expanded && "rotate-90"
            )}
          />
        </div>
      </button>

      {/* Expanded Hierarchy View — unfolds under the header. */}
      <Collapse open={expanded}>
        <div className="p-3 space-y-2">
          {/* Main Parent Agent */}
          <div className="flex items-center gap-2 px-1 text-caption font-mono text-muted-foreground">
            <Bot className="size-3 text-muted-foreground" />
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
                    "relative rounded-field border border-border/70 bg-card p-3 transition-[border-color,box-shadow,background-color] duration-fast ease-out-soft",
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
      </Collapse>
    </div>
  );
}
