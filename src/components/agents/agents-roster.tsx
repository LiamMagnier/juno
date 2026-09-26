"use client";

import * as React from "react";
import Link from "next/link";
import { Plus } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AppIcons } from "@/lib/app-icons";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AgentFace } from "@/components/agents/agent-face";
import { AgentCard } from "@/components/agents/agent-bits";
import { useAgents } from "@/components/agents/use-agents";
import { TeamStatus } from "@/components/agents/team-status";

/**
 * The roster (docs/design/AGENTS.md §3.1): a card per agent, a New agent
 * button, and nothing else.
 *
 * The agents that need the person come first, then the ones at work, then the
 * rest in the order they were hired — so the first card is always the one to
 * look at, which is the question this page is opened to answer.
 *
 * The empty roster is not an empty state with one button. Muse's lesson was
 * that a blank canvas is the wrong first screen for an agent, so the first
 * visit shows the starting points themselves, each a press away from a
 * pre-filled hire.
 */
const RANK: Record<string, number> = { waiting: 0, working: 1, thinking: 1, done: 2, blocked: 2, idle: 3, sleeping: 4 };

export function AgentsRoster() {
  const { agents, error, refresh } = useAgents();
  const ordered = React.useMemo(
    () =>
      agents
        ? [...agents].sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || a.sortOrder - b.sortOrder)
        : null,
    [agents]
  );

  const hire = (
    <Button asChild size="sm" className="gap-1.5">
      <Link href="/agents/new">
        <Plus className="size-3.5" aria-hidden="true" /> New agent
      </Link>
    </Button>
  );

  return (
    <AppPage measure="wide">
      <AppPageHeader
        heading="Agents"
        lede="Teammates that take on work, keep going when you leave, and come back only when they need you."
        actions={
          agents && agents.length > 0 ? (
            <>
              <TeamStatus agents={agents} />
              {hire}
            </>
          ) : undefined
        }
      />
      {error && !agents ? (
        <EmptyState
          tone="error"
          icon={AppIcons.agents}
          title="Couldn’t load your agents"
          description={error}
          action={
            <Button variant="secondary" size="sm" onClick={refresh}>
              Try again
            </Button>
          }
        />
      ) : ordered === null ? (
        <div className="@container" role="status" aria-label="Loading agents">
          <div className="grid grid-cols-1 gap-3 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-4 rounded-card border border-border bg-card p-4">
                <Skeleton className="size-12 rounded-full" />
                <div className="flex-1 space-y-2 pt-1">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : ordered.length === 0 ? (
        <FirstHire />
      ) : (
        <div className="@container">
          <div className="grid grid-cols-1 gap-3 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3">
            {ordered.map((agent, index) => (
              <AgentCard key={agent.id} agent={agent} index={index} />
            ))}
          </div>
        </div>
      )}
    </AppPage>
  );
}

function FirstHire() {
  const templates = AGENT_TEMPLATES.filter((template) => template.id !== "custom");
  return (
    <section aria-labelledby="first-hire" className="@container">
      <div className="mb-5 flex flex-col items-center text-center motion-safe:animate-rise-in">
        <div className="mb-4 flex -space-x-3" aria-hidden="true">
          {templates.slice(0, 4).map((template, i) => (
            <AgentFace key={template.id} avatar={template.avatar} size="md" state={i === 1 ? "working" : "idle"} />
          ))}
        </div>
        <h2 id="first-hire" className="text-title">
          Hire your first agent
        </h2>
        <p className="mt-1.5 max-w-md text-body text-muted-foreground">
          Start from a job. Everything is editable before you hire, and nothing it does that sends, pays or
          deletes happens without you.
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-3 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3">
        {templates.map((template, index) => (
          <li key={template.id} style={staggerDelay(index)} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]">
            <Link
              href={`/agents/new?template=${template.id}`}
              className={cn(
                "flex h-full items-start gap-3 rounded-card border border-border bg-card p-4",
                "transition-colors duration-fast ease-out-soft hover:bg-accent active:bg-selected"
              )}
            >
              <AgentFace avatar={template.avatar} size="sm" />
              <span className="min-w-0">
                <span className="block text-body font-medium text-foreground">{template.label}</span>
                <span className="mt-0.5 block text-ui text-muted-foreground">{template.promise}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-center text-ui text-muted-foreground">
        Or{" "}
        <Link href="/agents/new?template=custom" className="text-foreground underline-offset-4 hover:underline">
          start from scratch
        </Link>
        .
      </p>
    </section>
  );
}
