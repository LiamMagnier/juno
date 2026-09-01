"use client";

import * as React from "react";
import Link from "next/link";
import { Code2, Plus, ArrowUpRight, Search, Laptop, FolderCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";

export interface ProjectCodeSessionItem {
  id: string;
  title: string;
  workspaceName?: string;
  workspacePath?: string;
  lastMessageAt: string;
}

interface ProjectCodeListProps {
  projectId: string;
  sessions: ProjectCodeSessionItem[];
  onNewCodeSession: () => void;
  className?: string;
}

export function ProjectCodeList({
  projectId: _projectId,
  sessions,
  onNewCodeSession,
  className,
}: ProjectCodeListProps) {
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.toLowerCase();
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (s.workspaceName && s.workspaceName.toLowerCase().includes(q)) ||
        (s.workspacePath && s.workspacePath.toLowerCase().includes(q))
    );
  }, [sessions, query]);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[200px] flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter code sessions…"
            className="pl-8 h-8 text-ui font-mono bg-secondary/50"
          />
        </div>

        <Button
          type="button"
          size="sm"
          onClick={onNewCodeSession}
          className="h-8 gap-1.5 font-mono text-caption"
        >
          <Plus className="size-3.5" />
          <span>New code session</span>
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          size="panel"
          className="motion-safe:animate-rise-in py-8"
          icon={Code2}
          title={query ? "No matching code sessions" : "No code sessions in this project"}
          description={
            query
              ? "Try adjusting your filter keyword."
              : "Launch an autonomous software development agent against local, remote, or cloud repositories."
          }
        />
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {filtered.map((session) => (
            <Link
              key={session.id}
              href={`/chat/${session.id}`}
              className="group flex flex-col justify-between gap-3 rounded-card border border-border/70 bg-card p-4 transition-all duration-fast hover:border-primary/40 hover:shadow-lift hover:-translate-y-0.5"
            >
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-ui font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-1">
                    {session.title || "Code session"}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary/80 px-2 py-0.5 font-mono text-micro text-muted-foreground">
                    <Laptop className="size-3" /> Local / Remote
                  </span>
                </div>

                {session.workspaceName && (
                  <div className="flex items-center gap-1.5 font-mono text-caption text-muted-foreground">
                    <FolderCode className="size-3.5 text-primary/70 shrink-0" />
                    <span className="truncate">{session.workspaceName}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-border/40 font-mono text-micro text-muted-foreground">
                <span>Active {timeAgo(session.lastMessageAt)}</span>
                <span className="inline-flex items-center gap-0.5 text-primary group-hover:translate-x-0.5 transition-transform">
                  Open session <ArrowUpRight className="size-3" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
