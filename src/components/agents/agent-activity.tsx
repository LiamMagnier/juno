"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Check, Hand, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AppIcons } from "@/lib/app-icons";
import type { ClientAgentActivity } from "@/lib/agents/types";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { fetchActivity } from "@/components/agents/agents-transport";
import { formatAgo } from "@/components/agents/agent-bits";

function ActivityGlyph({ tone }: { tone: ClientAgentActivity["tone"] }) {
  if (tone === "success") {
    return <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
  }
  if (tone === "danger") {
    return <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
  }
  if (tone === "attention") {
    return <Hand aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />;
  }
  return <ArrowRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}

/**
 * The lines about one run, which open it: a task at its current state, an
 * approval one of its tasks was given, and work handed to or taken from a
 * teammate, whose run lives in the teammate's thread.
 */
const RUN_KINDS = new Set(["approval", "handed_off", "handoff_received"]);

function opensRun(item: ClientAgentActivity): item is ClientAgentActivity & { sessionId: string } {
  return item.sessionId !== null && (item.kind.startsWith("task_") || RUN_KINDS.has(item.kind));
}

/**
 * Activity: one log for everything the agent did.
 *
 * Uses plain glyphs (check, cross, hand, arrow) in muted or attention colour —
 * no coloured tone dots or pills (BRIEF.md §4.8.1).
 */
export function AgentActivity({
  agentId,
  refreshKey,
  limit = 80,
  initialItems,
}: {
  agentId: string;
  refreshKey: number;
  limit?: number;
  initialItems?: ClientAgentActivity[];
}) {
  const [items, setItems] = React.useState<ClientAgentActivity[] | null>(initialItems ?? null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    if (initialItems) return;
    void fetchActivity(agentId, limit).then((outcome) => {
      if (outcome.kind === "ok") {
        setItems(outcome.value.slice(0, limit));
        setError(null);
      } else if (outcome.kind === "failed") {
        setError(outcome.message);
      }
    });
  }, [agentId, limit, initialItems]);

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
            <Skeleton className="size-3.5" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
          </div>
        ))}
      </div>
    );
  }
  const visible = items.slice(0, limit);
  if (visible.length === 0) {
    return <EmptyState size="panel" icon={AppIcons.agents} title="Nothing yet" description="What it does will be written here." />;
  }

  return (
    <ol className="relative space-y-0.5">
      {visible.map((item, index) => {
        const body = (
          <>
            <ActivityGlyph tone={item.tone} />
            <span className="min-w-0 flex-1">
              <span className={cn("block text-ui", item.tone === "attention" ? "font-medium text-foreground" : "text-foreground")}>
                {item.title}
              </span>
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
            {opensRun(item) ? (
              <Link
                href={`/work/${item.sessionId}`}
                className="flex items-start gap-2.5 rounded-control px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent"
              >
                {body}
              </Link>
            ) : (
              <div className="flex items-start gap-2.5 px-2 py-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
