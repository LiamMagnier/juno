"use client";

import * as React from "react";
import Link from "next/link";
import { Zap, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { AgentStatusBadge, type AgentRunStatus } from "@/components/ui/agent-status-badge";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { staggerDelay } from "@/lib/motion";
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
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search work…"
            aria-label="Search delegated work"
            className="pl-9"
          />
        </div>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {filtered.length} of {workRuns.length}
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={onNewWork} className="ml-auto gap-1.5">
          <Plus className="size-3.5" aria-hidden="true" />
          Delegate work
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          size="panel"
          className="motion-safe:animate-rise-in"
          icon={query ? Search : Zap}
          title={query ? "No matching work" : "No delegated work yet"}
          description={
            query
              ? "Try another search term."
              : "Delegate long-running goals and automations; they run with this project’s context."
          }
          action={
            query ? (
              <Button variant="ghost" size="sm" onClick={() => setQuery("")} className="text-muted-foreground">
                Clear search
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Delegated work">
          {filtered.map((work, i) => (
            <li
              key={work.id}
              className="min-w-0 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i)}
            >
              <Link
                href={`/work/${work.id}`}
                className="surface-raised flex h-full min-h-36 flex-col rounded-card p-4 transition-[border-color,box-shadow,background-color] duration-fast ease-out-soft hover:border-foreground/20 hover:shadow-raised-lg active:shadow-pressed motion-reduce:transition-none"
              >
                <div className="flex items-start gap-3">
                  <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
                    <Zap className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {work.title || "Delegated task"}
                    </span>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {work.goal || "No goal description provided."}
                    </p>
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-3 font-mono text-caption tabular-nums text-muted-foreground">
                  <AgentStatusBadge status={work.status} size="sm" />
                  <span>Updated {timeAgo(work.updatedAt || work.createdAt)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
