"use client";

import * as React from "react";
import Link from "next/link";
import { Code2, Plus, Search, FolderCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { staggerDelay } from "@/lib/motion";
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
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search code sessions…"
            aria-label="Search code sessions"
            className="pl-9"
          />
        </div>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {filtered.length} of {sessions.length}
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={onNewCodeSession} className="ml-auto gap-1.5">
          <Plus className="size-3.5" aria-hidden="true" />
          New code session
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          size="panel"
          className="motion-safe:animate-rise-in"
          icon={query ? Search : Code2}
          title={query ? "No matching code sessions" : "No code sessions yet"}
          description={
            query
              ? "Try another search term."
              : "Start a coding session against a local, remote or cloud repository with this project’s context."
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
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Code sessions">
          {filtered.map((session, i) => (
            <li
              key={session.id}
              className="min-w-0 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i)}
            >
              <Link
                href={`/chat/${session.id}`}
                className="surface-raised flex h-full min-h-36 flex-col rounded-card p-4 transition-[border-color,box-shadow,background-color] duration-fast ease-out-soft hover:border-foreground/20 hover:shadow-raised-lg active:shadow-pressed motion-reduce:transition-none"
              >
                <div className="flex items-start gap-3">
                  <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
                    <Code2 className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {session.title || "Code session"}
                    </span>
                    {session.workspaceName ? (
                      <p className="mt-1 flex items-center gap-1.5 truncate font-mono text-caption text-muted-foreground">
                        <FolderCode className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{session.workspaceName}</span>
                      </p>
                    ) : (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        Local or remote repository session.
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 pt-3 font-mono text-caption tabular-nums text-muted-foreground">
                  <span>Code session</span>
                  <span>Active {timeAgo(session.lastMessageAt)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
