"use client";

import * as React from "react";
import Link from "next/link";
import { Hand } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientAgent } from "@/lib/agents/types";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AgentFace } from "@/components/agents/agent-face";
import { localStateSentence } from "@/components/agents/agent-bits";
import { useAgents } from "@/components/agents/use-agents";
import { TeamStatus } from "@/components/agents/team-status";
import { FirstHireBoard, NewAgentButton } from "@/components/agents/agent-job-board";

/**
 * The roster (`docs/design/agents-v2/BRIEF.md` §4.8.3): a compact list.
 * Each row: face `sm` · name · "role · state sentence" (one line, truncated) ·
 * trailing hand icon when it needs you · pinned agents first.
 * A row links to the thread.
 *
 * Empty is the job board (`agent-job-board.tsx`), shown only after a
 * successful read returned zero agents. A failed read is LoadError, never the
 * empty state.
 */
const RANK: Record<string, number> = {
  waiting: 0,
  working: 1,
  thinking: 1,
  done: 2,
  blocked: 2,
  idle: 3,
  sleeping: 4,
};

export function sortRosterAgents(agents: readonly ClientAgent[]): ClientAgent[] {
  return [...agents].sort((a, b) => {
    const aPinned = a.pinnedAt ? 1 : 0;
    const bPinned = b.pinnedAt ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || a.sortOrder - b.sortOrder;
  });
}

export function AgentsRoster({ initialAgents }: { initialAgents?: ClientAgent[] } = {}) {
  const {
    agents: fetchedAgents,
    error,
    settled,
    refresh,
  } = useAgents({ enabled: initialAgents === undefined });
  const agents = initialAgents ?? fetchedAgents;
  // `initialAgents` is a completed read; the hook only settles after its own.
  const ready = initialAgents !== undefined || settled;

  const ordered = React.useMemo(
    () => (agents ? sortRosterAgents(agents) : null),
    [agents]
  );

  return (
    <AppPage measure="wide">
      <AppPageHeader
        heading="Agents"
        lede="Teammates that take on work and come back when they need you."
        actions={
          ready && agents && agents.length > 0 ? (
            <>
              <TeamStatus agents={agents} />
              <NewAgentButton />
            </>
          ) : ready && agents && agents.length === 0 ? (
            <NewAgentButton />
          ) : undefined
        }
      />
      {error && !ready ? (
        <LoadError title="Couldn’t load your agents" description={error} onRetry={refresh} />
      ) : !ready || ordered === null ? (
        <div
          className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card"
          role="status"
          aria-label="Loading agents"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </div>
      ) : ordered.length === 0 ? (
        <FirstHireBoard />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {ordered.map((agent, index) => {
            const sentence = localStateSentence(agent, agent.state);
            const subtitle = agent.role ? `${agent.role} · ${sentence}` : sentence;
            const needsYou = agent.state === "waiting" || agent.needsYou > 0;
            const href = agent.conversationId
              ? `/chat/${encodeURIComponent(agent.conversationId)}`
              : `/agents/${encodeURIComponent(agent.id)}`;
            return (
              <li
                key={agent.id}
                style={staggerDelay(index, "tight")}
                className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              >
                <Link
                  href={href}
                  data-face-trigger
                  className="flex items-center gap-3 px-4 py-3 transition-colors duration-fast ease-out-soft hover:bg-accent"
                >
                  <AgentFace avatar={agent.avatar} state={agent.state} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-ui font-medium text-foreground">{agent.name}</span>
                      {agent.pinnedAt ? (
                        <span className="font-mono text-caption text-muted-foreground">Pinned</span>
                      ) : null}
                    </div>
                    <p className="truncate text-caption text-muted-foreground">{subtitle}</p>
                  </div>
                  {needsYou ? (
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 text-caption font-medium text-primary"
                      )}
                      aria-label="Needs you"
                    >
                      <Hand className="size-4" aria-hidden="true" />
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AppPage>
  );
}
