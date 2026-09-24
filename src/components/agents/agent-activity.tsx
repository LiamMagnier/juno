"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AppIcons } from "@/lib/app-icons";
import type { ClientAgentActivity } from "@/lib/agents/types";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { fetchActivity } from "@/components/agents/agents-transport";
import { formatAgo } from "@/components/agents/agent-bits";

const TONE: Record<ClientAgentActivity["tone"], string> = {
  neutral: "bg-muted-foreground/40",
  attention: "bg-primary",
  success: "bg-success",
  danger: "bg-destructive",
};

/**
 * Activity: one log for everything the agent did.
 *
 * Grok Bot shipped with its audit view "coming"; this is the view. Its own
 * events (hired, paused, goals, ideas, routines, what it learned) and one line
 * per task at its current state, newest first. A task line opens the run where
 * it lives — `/work/<id>` resolves to the conversation that holds it — because
 * the full record of a run is the run's own log, not a copy of it here.
 */
export function AgentActivity({ agentId, refreshKey }: { agentId: string; refreshKey: number }) {
  const [items, setItems] = React.useState<ClientAgentActivity[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    void fetchActivity(agentId).then((outcome) => {
      if (outcome.kind === "ok") {
        setItems(outcome.value);
        setError(null);
      } else if (outcome.kind === "failed") {
        setError(outcome.message);
      }
    });
  }, [agentId]);

  React.useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (error && !items) {
    return (
      <EmptyState
        size="panel"
        tone="error"
        title="Couldn’t load the log"
        description={error}
        action={
          <Button size="sm" variant="secondary" onClick={load}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!items) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading activity">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-2 rounded-full" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
          </div>
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return <EmptyState size="panel" icon={AppIcons.agents} title="Nothing yet" description="What it does will be written here." />;
  }

  return (
    <ol className="relative space-y-0.5">
      {items.map((item, index) => {
        const body = (
          <>
            <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE[item.tone])} />
            <span className="min-w-0 flex-1">
              <span className="block text-ui text-foreground">{item.title}</span>
              {item.detail ? <span className="mt-0.5 block text-ui text-muted-foreground">{item.detail}</span> : null}
            </span>
            <time dateTime={item.at} className="shrink-0 font-mono text-caption text-muted-foreground">
              {formatAgo(item.at)}
            </time>
          </>
        );
        return (
          <li
            key={item.id}
            style={staggerDelay(index, "tight")}
            className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
          >
            {item.sessionId && item.kind.startsWith("task_") ? (
              <Link
                href={`/work/${item.sessionId}`}
                className="flex items-start gap-3 rounded-control px-2 py-2 transition-colors duration-fast ease-out-soft hover:bg-accent"
              >
                {body}
              </Link>
            ) : (
              <div className="flex items-start gap-3 px-2 py-2">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
