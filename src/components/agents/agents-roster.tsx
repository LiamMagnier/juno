"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Hand, Plus } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Button } from "@/components/ui/button";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { Skeleton } from "@/components/ui/skeleton";
import { cardVariants } from "@/components/ui/card";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agents/templates";
import type { ClientAgent } from "@/lib/agents/types";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AgentFace } from "@/components/agents/agent-face";
import { localStateSentence } from "@/components/agents/agent-bits";
import { announceAgentsChanged, hireAgent } from "@/components/agents/agents-transport";
import { useAgents } from "@/components/agents/use-agents";
import { TeamStatus } from "@/components/agents/team-status";

/**
 * The roster (`docs/design/agents-v2/BRIEF.md` §4.8.3): a compact list.
 * Each row: face `sm` · name · "role · state sentence" (one line, truncated) ·
 * trailing hand icon when it needs you · pinned agents first.
 * A row links to the thread.
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
  const { agents: fetchedAgents, error, refresh } = useAgents({ enabled: !initialAgents });
  const agents = initialAgents ?? fetchedAgents;

  const ordered = React.useMemo(
    () => (agents ? sortRosterAgents(agents) : null),
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
        lede="Teammates that take on work and come back when they need you."
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
        <LoadError title="Couldn’t load your agents" description={error} onRetry={refresh} />
      ) : ordered === null ? (
        <div className="divide-y divide-border rounded-card border border-border bg-card" role="status" aria-label="Loading agents">
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
        <FirstHire />
      ) : (
        <ul className="divide-y divide-border/60 border-y border-border/60">
          {ordered.map((agent, index) => {
            const sentence = localStateSentence(agent, agent.state);
            const subtitle = agent.role ? `${agent.role} · ${sentence}` : sentence;
            const needsYou = agent.state === "waiting" || agent.needsYou > 0;
            const href = agent.conversationId ? `/chat/${encodeURIComponent(agent.conversationId)}` : `/agents/${encodeURIComponent(agent.id)}`;
            return (
              <li
                key={agent.id}
                style={staggerDelay(index, "tight")}
                className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              >
                <Link
                  href={href}
                  data-face-trigger
                  className="flex items-center gap-3.5 px-2 py-3.5 transition-colors duration-fast ease-out-soft hover:bg-accent/40"
                >
                  <AgentFace avatar={agent.avatar} state={agent.state} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-ui font-medium text-foreground">{agent.name}</span>
                      {agent.pinnedAt ? (
                        <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground">Pinned</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-caption text-muted-foreground">{subtitle}</p>
                  </div>
                  {needsYou ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/25 bg-primary/8 px-2.5 py-0.5 text-caption font-medium text-primary"
                      aria-label="Needs you"
                    >
                      <Hand className="size-3.5" aria-hidden="true" />
                      <span>Needs you</span>
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

function FirstHire() {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const templates = AGENT_TEMPLATES.filter((template) => template.id !== "custom");

  const startFromTemplate = async (template: AgentTemplate) => {
    if (busyId) return;
    setBusyId(template.id);
    const defaultName = template.names[0] ?? "New agent";
    const isScratch = template.id === "custom";
    const outcome = await hireAgent({
      name: defaultName,
      role: isScratch ? "" : template.role,
      avatar: template.avatar,
      style: template.style,
      instructions: isScratch ? "" : template.instructions,
      approvalMode: template.approvalMode,
      connectorIds: [],
      template: template.id,
      ...(template.firstGoal ? { firstGoal: template.firstGoal } : {}),
    });
    setBusyId(null);
    if (outcome.kind !== "ok") {
      toast.error(outcome.message);
      return;
    }
    announceAgentsChanged();
    const target = outcome.value.conversationId
      ? `/chat/${encodeURIComponent(outcome.value.conversationId)}`
      : `/agents/${encodeURIComponent(outcome.value.id)}`;
    router.push(target);
  };

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
          Start from a job to open a thread right away, or set one up from scratch. Nothing it does that sends, pays or
          deletes happens without you.
        </p>
      </div>
      <ul className="grid grid-cols-1 gap-4 @[40rem]/page:grid-cols-2 @5xl/page:grid-cols-3">
        {templates.map((template, index) => (
          <li key={template.id} style={staggerDelay(index)} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]">
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void startFromTemplate(template)}
              className={cn(cardVariants({ variant: "interactive" }), "flex h-full w-full items-start gap-3 p-4 text-left")}
            >
              <AgentFace avatar={template.avatar} size="sm" state={busyId === template.id ? "working" : "idle"} />
              <span className="min-w-0">
                <span className="block text-body font-medium text-foreground">{template.label}</span>
                <span className="mt-0.5 block text-ui text-muted-foreground">{template.promise}</span>
              </span>
            </button>
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
