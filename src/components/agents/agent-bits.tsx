"use client";

import * as React from "react";
import Link from "next/link";
import { AgentFace } from "@/components/agents/agent-face";
import { agentStateSentence, type AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

/**
 * "today at 09:00", "tomorrow at 09:00", "Mon at 09:00", "12 Oct" — in the
 * reader's own zone. The server says the same sentence in UTC because it does
 * not know the zone; the client does, so it says it again, correctly.
 */
export function formatLocalWhen(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${at.toLocaleDateString(undefined, { weekday: "short" })} at ${time}`;
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A past moment, briefly: "just now", "12 min ago", "3 h ago", "Mon", "12 Oct". */
export function formatAgo(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: "short" });
  return at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The state sentence, re-said in the reader's zone when it names a time. */
export function localStateSentence(agent: ClientAgent, state: AgentState = agent.state): string {
  if (state !== agent.state || (state === "idle" && agent.nextRoutine)) {
    return agentStateSentence({
      state,
      task: agent.task ? { title: agent.task.title, status: agent.task.status } : null,
      nextRoutine: agent.nextRoutine
        ? { name: agent.nextRoutine.name, nextRunAt: new Date(agent.nextRoutine.nextRunAt) }
        : null,
      now: new Date(),
      formatWhen: formatLocalWhen,
    });
  }
  return agent.stateSentence;
}

/**
 * The one trailing signal a row may carry (PREMIUM_AUDIT.md §3 rule 6): a toned
 * dot while the agent needs the person, nothing otherwise. State, not
 * decoration — the same dot the sidebar's conversation rows use for a run that
 * is waiting.
 */
export function NeedsYouDot({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full bg-primary", className)} />;
}

export function AgentCard({ agent, index = 0 }: { agent: ClientAgent; index?: number }) {
  const sentence = localStateSentence(agent);
  const waiting = agent.state === "waiting";
  return (
    <Link
      href={`/agents/${agent.id}`}
      className={cn(
        "group flex min-w-0 items-start gap-4 rounded-card border border-border bg-card p-4",
        "transition-colors duration-fast ease-out-soft hover:bg-accent active:bg-selected",
        "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      )}
      style={staggerDelay(index)}
      aria-label={`${agent.name}. ${sentence}`}
    >
      <AgentFace avatar={agent.avatar} state={agent.state} size="md" />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <p className="truncate text-body font-medium text-foreground">{agent.name}</p>
          {waiting ? <NeedsYouDot /> : null}
        </div>
        {agent.role ? <p className="truncate text-ui text-muted-foreground">{agent.role}</p> : null}
        <p
          className={cn(
            "mt-2 line-clamp-2 text-ui",
            waiting ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {sentence}
        </p>
      </div>
    </Link>
  );
}
