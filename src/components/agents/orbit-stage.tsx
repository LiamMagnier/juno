"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { intentPrefetch } from "@/lib/intent-prefetch";
import { Cloud, Laptop, MoreHorizontal, Pause, Pin, Play } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { AGENT_STATE_NAMES } from "@/lib/brand/names";
import { cn } from "@/lib/utils";
import { AgentPresence } from "./agent-presence";
import { formatAgo, localStateSentence } from "./agent-bits";
import { announceAgentsChanged, updateAgent } from "./agents-transport";

/*
 * Orbit's crew (V5, Nov 2026): one card per agent.
 *
 * A card is the agent, read top to bottom the way a person scans a team: who
 * (live face, name in the serif, role), what it is doing now (one line, in
 * words, in the state's ink), and where it works (its machine) with when it
 * last moved. Nothing is drawn for decoration. The one moving thing is a 2px
 * line along the card's foot while the agent is at work, an indeterminate
 * sweep because a task has no known length; reduced motion holds it still.
 *
 * Each fact once (docs/design/AGENTS.md §4.3): an agent with a Needs you row
 * above says "Waiting on you" here, not the ask again.
 */

/** The live face on a card. Big enough for its state to read, small enough for a dense team. */
export const CARD_FACE = 44;

function drawnState(agent: ClientAgent): AgentState {
  return agent.status === "paused" ? "sleeping" : agent.state;
}

type Tone = "working" | "asked" | "blocked" | "quiet";

/** What it is doing, as a lead in quiet ink and the subject in full ink, and the tone it is said in. */
function statusOf(agent: ClientAgent, asked: boolean): { lead: string | null; body: string; tone: Tone } {
  if (agent.status === "paused") return { lead: null, body: "Paused", tone: "quiet" };
  if (asked) return { lead: null, body: agent.state === "blocked" ? "Blocked, needs you" : "Waiting on you", tone: agent.state === "blocked" ? "blocked" : "asked" };
  if (agent.state === "working" || agent.state === "thinking") {
    const words = localStateSentence(agent, agent.state) || AGENT_STATE_NAMES.working;
    const task = agent.task?.title;
    if (task && words.endsWith(task)) return { lead: words.slice(0, words.length - task.length).trimEnd(), body: task, tone: "working" };
    return { lead: null, body: words, tone: "working" };
  }
  if (agent.state === "idle") {
    if (agent.nextRoutine) return { lead: "Next:", body: localStateSentence(agent, "idle").replace(/^Next:\s*/, ""), tone: "quiet" };
    return { lead: null, body: AGENT_STATE_NAMES.ready, tone: "quiet" };
  }
  return { lead: null, body: localStateSentence(agent, agent.state) || AGENT_STATE_NAMES.ready, tone: "quiet" };
}

const TONE_INK: Record<Tone, string> = {
  working: "text-foreground",
  asked: "text-status-needs-you-ink",
  blocked: "text-destructive-ink",
  quiet: "text-muted-foreground",
};

export function OrbitCrew({
  agents,
  asked,
  hrefOf,
  machineOf,
  onChanged,
}: {
  agents: readonly ClientAgent[];
  /** Agents with a Needs you row above. */
  asked: ReadonlySet<string>;
  hrefOf: (agent: ClientAgent) => string;
  /** The machine it works on, by name ("Cloud", "Mac Studio"). */
  machineOf: (agent: ClientAgent) => { kind: "cloud" | "mac"; name: string };
  onChanged: () => void;
}) {
  return (
    <ul role="list" className="grid grid-cols-1 gap-3 @[34rem]/page:grid-cols-2 @[80rem]/page:grid-cols-3">
      {agents.map((agent, index) => (
        <li key={agent.id} className="orbit-card-in group/card relative min-w-0" style={{ "--i": index } as React.CSSProperties}>
          <AgentCard agent={agent} asked={asked.has(agent.id)} href={hrefOf(agent)} machine={machineOf(agent)} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}

function AgentCard({
  agent,
  asked,
  href,
  machine,
  onChanged,
}: {
  agent: ClientAgent;
  asked: boolean;
  href: string;
  machine: { kind: "cloud" | "mac"; name: string };
  onChanged: () => void;
}) {
  const router = useRouter();
  const paused = agent.status === "paused";
  const busy = !paused && !asked && (agent.state === "working" || agent.state === "thinking");
  const status = statusOf(agent, asked);
  const last = agent.task ? formatAgo(agent.task.lastActivityAt) : null;
  const MachineIcon = machine.kind === "cloud" ? Cloud : Laptop;
  const act = async (patch: Parameters<typeof updateAgent>[1]) => {
    const outcome = await updateAgent(agent.id, patch);
    if (outcome.kind === "ok") {
      announceAgentsChanged();
      onChanged();
    }
  };
  return (
    <>
      <Link
        href={href}
        prefetch={false}
        {...intentPrefetch(router, href)}
        data-face-trigger
        data-state={agent.state}
        data-busy={busy ? "" : undefined}
        className="orbit-card relative flex h-full flex-col overflow-hidden rounded-card border border-foreground/[0.08] bg-card px-4 pb-3 pt-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex items-center gap-3 pr-7">
          <span className="grid size-11 shrink-0 place-items-center">
            <AgentPresence avatar={agent.avatar} state={drawnState(agent)} size={CARD_FACE} gaze />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-serif text-body-lg leading-6 tracking-[-0.012em] text-foreground [font-optical-sizing:auto]">{agent.name}</span>
            {agent.role ? <span className="block truncate text-ui leading-5 text-muted-foreground">{agent.role}</span> : null}
          </span>
        </span>

        <span className={cn("mb-3 mt-3.5 line-clamp-2 text-pretty text-ui leading-5", TONE_INK[status.tone])} aria-live="polite">
          {status.lead ? <span className="text-muted-foreground">{`${status.lead} `}</span> : null}
          {status.body}
        </span>

        <span className="mt-auto flex items-center gap-2 border-t border-foreground/[0.06] pt-2.5 text-caption leading-4 text-muted-foreground">
          <MachineIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" translate={machine.kind === "mac" ? "no" : undefined}>
            {machine.name}
          </span>
          {last ? <span className="shrink-0 tabular-nums">{last}</span> : null}
        </span>

        {busy ? <span className="orbit-card__work" aria-hidden="true" /> : null}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`More for ${agent.name}`}
          className="orbit-card__more absolute right-2 top-2 grid size-8 place-items-center rounded-control text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-foreground"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onSelect={() => void act({ pinned: !agent.pinnedAt })}>
            <Pin className="size-4" aria-hidden="true" /> {agent.pinnedAt ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void act({ status: paused ? "active" : "paused" })}>
            {paused ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
            {paused ? "Resume" : "Pause"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
