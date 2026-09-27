"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useConversationWork } from "@/components/chat/use-conversation-work";
import { WorkRunPanel } from "@/components/chat/work-run-panel";
import { WorkActivity, deriveActivity } from "@/components/work/work-timeline";
import { isTerminalStatus } from "@/lib/work/domain";
import type { ClientAgentDetail, ClientAgentIdea } from "@/lib/agents/types";
import { AppIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";
import { announceAgentsChanged, decideIdea } from "@/components/agents/agents-transport";
import { useCostConfirmation } from "@/components/agents/confirm-cost-dialog";
import { formatLocalWhen } from "@/components/agents/agent-bits";

/**
 * Now: what it is doing, and whether it needs you (docs/design/AGENTS.md §5.2).
 *
 * In the order a person reads it:
 *
 *   1. The task — drawn by `WorkRunPanel`, the same component the thread draws
 *      it with, over the same event stream (`useConversationWork` on the
 *      agent's thread). So the questions and the approval cards on this page
 *      ARE the ones in the thread — Deny first, digest-checked — and a run can
 *      never disagree with itself about what happened depending on where it
 *      was read. Nothing here is a second implementation of an approval.
 *   2. Its computer: the calls the run made, from the same log (with live
 *      desktop view and takeover in `agent-panel-computer.tsx` when an
 *      `AgentComputer` is enabled).
 *   3. Ideas it raised, each a card with Start on it.
 *   4. What is next on its clock.
 */
export function AgentNow({
  detail,
  onChanged,
}: {
  detail: ClientAgentDetail;
  onChanged: () => void;
}) {
  const { agent } = detail;
  const work = useConversationWork(agent.conversationId);
  const entries = React.useMemo(
    () => deriveActivity(work.events).filter((entry) => entry.tool !== null),
    [work.events]
  );
  const live = work.session !== null && !isTerminalStatus(work.session.status);
  const upcoming = detail.routines.filter((routine) => routine.enabled && routine.nextRunAt).slice(0, 3);

  return (
    <div className="space-y-8">
      {work.session ? (
        <section aria-label="Its task">
          <WorkRunPanel work={work} actor={agent.name} />
          {agent.conversationId ? (
            <p className="mt-2 px-1 text-ui text-muted-foreground">
              <Link href={`/chat/${agent.conversationId}`} className="text-foreground underline-offset-4 hover:underline">
                Open in its thread
              </Link>{" "}
              to steer it or ask about it.
            </p>
          ) : null}
        </section>
      ) : (
        <EmptyState
          size="panel"
          icon={AppIcons.agents}
          title={agent.status === "paused" ? `${agent.name} is paused` : `${agent.name} is free`}
          description={
            agent.status === "paused"
              ? "Resume it to start something new. Its goals, notes and routines are kept."
              : "Message it with something to take on, give it a goal, or set it a routine."
          }
        />
      )}

      {entries.length > 0 ? (
        <section aria-labelledby="agent-computer">
          {/* "Last run" only once it has finished: a "Live" tag beside the
              heading said what the moving activity under it already shows. */}
          <SectionTitle id="agent-computer" hint={live ? undefined : "Last run"}>
            Its computer
          </SectionTitle>
          <WorkActivity entries={entries.slice(-8)} phase={live ? "live" : "settled"} />
        </section>
      ) : null}

      <Ideas detail={detail} onChanged={onChanged} />

      {upcoming.length > 0 ? (
        <section aria-labelledby="agent-upcoming">
          <SectionTitle id="agent-upcoming">Upcoming</SectionTitle>
          <ul className="divide-y divide-border rounded-card border border-border">
            {upcoming.map((routine) => (
              <li key={routine.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate text-ui font-medium text-foreground">{routine.name}</span>
                  <span className="block truncate text-ui text-muted-foreground">{routine.schedule}</span>
                </span>
                <span className="shrink-0 font-mono text-caption text-muted-foreground">
                  {formatLocalWhen(new Date(routine.nextRunAt as string), new Date())}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function SectionTitle({ id, hint, children }: { id: string; hint?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mb-3 flex items-baseline gap-2 text-heading">
      {children}
      {hint ? <span className="font-mono text-caption text-muted-foreground">{hint}</span> : null}
    </h2>
  );
}

function Ideas({ detail, onChanged }: { detail: ClientAgentDetail; onChanged: () => void }) {
  const { agent, ideas } = detail;
  const [busy, setBusy] = React.useState<string | null>(null);
  const { ask, dialog } = useCostConfirmation();

  const decide = async (idea: ClientAgentIdea, action: "start" | "dismiss") => {
    setBusy(idea.id);
    let outcome = await decideIdea(agent.id, idea.id, action);
    if (outcome.kind === "confirm") {
      const yes = await ask(idea.title, outcome.estimatedCostMicroUsd);
      outcome = yes ? await decideIdea(agent.id, idea.id, action, true) : outcome;
      if (!yes) {
        setBusy(null);
        return;
      }
    }
    setBusy(null);
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    if (outcome.kind === "ok" && action === "start") toast.success(`${agent.name} started “${idea.title}”.`);
    announceAgentsChanged();
    onChanged();
  };

  if (ideas.length === 0) return null;
  return (
    <section aria-labelledby="agent-ideas">
      <SectionTitle id="agent-ideas">Ideas</SectionTitle>
      <ul className="space-y-2">
        {ideas.map((idea, index) => (
          <li
            key={idea.id}
            style={staggerDelay(index)}
            className="rounded-card border border-border bg-card p-4 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
          >
            <p className="text-body font-medium text-foreground">{idea.title}</p>
            {idea.detail ? <p className="mt-1 text-ui text-muted-foreground">{idea.detail}</p> : null}
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                loading={busy === idea.id}
                disabled={busy !== null || agent.status !== "active"}
                onClick={() => void decide(idea, "start")}
              >
                Start
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void decide(idea, "dismiss")}
              >
                Not now
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {dialog}
    </section>
  );
}
