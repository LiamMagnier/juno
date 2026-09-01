"use client";

import * as React from "react";
import Link from "next/link";
import { Zap, Plus, ArrowUpRight, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { AgentStatusBadge, type AgentRunStatus } from "@/components/ui/agent-status-badge";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";

export interface ProjectWorkItem {
  id: string;
  title: string;
  goal: string;
  status: AgentRunStatus;
  updatedAt: string;
  createdAt: string;
}

interface ProjectWorkListProps {
  projectId: string;
  workRuns: ProjectWorkItem[];
  onNewWork: () => void;
  className?: string;
}

export function ProjectWorkList({
  projectId: _projectId,
  workRuns,
  onNewWork,
  className,
}: ProjectWorkListProps) {
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo(() => {
    if (!query.trim()) return workRuns;
    const q = query.toLowerCase();
    return workRuns.filter(
      (w) => w.title.toLowerCase().includes(q) || w.goal.toLowerCase().includes(q)
    );
  }, [workRuns, query]);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[200px] flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter delegated work…"
            className="pl-8 h-8 text-ui font-mono bg-secondary/50"
          />
        </div>

        <Button
          type="button"
          size="sm"
          onClick={onNewWork}
          className="h-8 gap-1.5 font-mono text-caption"
        >
          <Plus className="size-3.5" />
          <span>Delegate work in project</span>
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          size="panel"
          className="motion-safe:animate-rise-in py-8"
          icon={Zap}
          title={query ? "No matching work runs" : "No delegated work in this project"}
          description={
            query
              ? "Try adjusting your filter keyword."
              : "Delegate long-running goals, computer use tasks, and automations with full project context."
          }
        />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {filtered.map((work) => (
            <Link
              key={work.id}
              href={`/work/${work.id}`}
              className="group flex flex-col justify-between gap-3 rounded-card border border-border/70 bg-card p-4 transition-all duration-fast hover:border-primary/40 hover:shadow-lift hover:-translate-y-0.5"
            >
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-ui font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-1">
                    {work.title || "Delegated task"}
                  </span>
                  <AgentStatusBadge status={work.status} size="sm" />
                </div>

                <p className="text-caption text-muted-foreground line-clamp-2 leading-relaxed">
                  {work.goal || "No goal description provided."}
                </p>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-border/40 font-mono text-micro text-muted-foreground">
                <span>Updated {timeAgo(work.updatedAt || work.createdAt)}</span>
                <span className="inline-flex items-center gap-0.5 text-primary group-hover:translate-x-0.5 transition-transform">
                  Open <ArrowUpRight className="size-3" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
