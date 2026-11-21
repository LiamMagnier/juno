"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { intentPrefetch } from "@/lib/intent-prefetch";
import { ArrowUpRight, Cloud, Laptop, MoreHorizontal, Pause, Pin, Play, Shapes, Trash2 } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import dynamic from "next/dynamic";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { AGENT_STATE_NAMES } from "@/lib/brand/names";
import { cn } from "@/lib/utils";
import { AgentPresence } from "./agent-presence";
import { formatAgo, localStateSentence } from "./agent-bits";
import { announceAgentsChanged, retireAgent, updateAgent } from "./agents-transport";
import { toast } from "sonner";
import { OrbitAgentActions } from "./orbit-agent-actions";

/* One card per agent. The face stays the same size when the roster is filtered,
   and computer access has its own link outside the thread's hit target. */
const CREW_FACE = 46;
const AgentFaceStudio = dynamic(() => import("./agent-face-studio").then((module) => module.AgentFaceStudio));

function drawnState(agent: ClientAgent): AgentState {
  return agent.status === "paused" ? "sleeping" : agent.state;
}

/**
 * What it is doing, in words: the live sentence while it matters, else the
 * plain state. A resting agent with a routine coming says when it runs next
 * ("Next: Weekly spend review, Mon at 09:00"), the one useful thing an idle
 * agent has to say; without one it is simply ready.
 */
function stateWords(agent: ClientAgent): string {
  if (agent.status === "paused") return "Paused";
  if (agent.state === "idle") return agent.nextRoutine ? localStateSentence(agent, "idle") : AGENT_STATE_NAMES.ready;
  return localStateSentence(agent, agent.state) || AGENT_STATE_NAMES.working;
}

export function OrbitCrew({
  agents,
  asked,
  hrefOf,
  machineOf = () => ({ kind: "cloud", name: "Cloud computer" }),
  onChanged,
}: {
  agents: readonly ClientAgent[];
  /** Agents with a Needs you card above: the card says their state. */
  asked: ReadonlySet<string>;
  hrefOf: (agent: ClientAgent) => string;
  machineOf?: (agent: ClientAgent) => { kind: "cloud" | "mac"; name: string };
  onChanged: () => void;
}) {
  return (
    <ul
      role="list"
      className="orbit-crew"
    >
      {agents.map((agent) => (
        <li key={agent.id} className="orbit-crew__agent group/tile relative min-w-0">
          <CrewTile agent={agent} size={CREW_FACE} asked={asked.has(agent.id)} href={hrefOf(agent)} machine={machineOf(agent)} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}

function CrewTile({ agent, size, asked, href, machine, onChanged }: { agent: ClientAgent; size: number; asked: boolean; href: string; machine: { kind: "cloud" | "mac"; name: string }; onChanged: () => void }) {
  const router = useRouter();
  const paused = agent.status === "paused";
  const [saving, setSaving] = React.useState(false);
  const [studio, setStudio] = React.useState(false);
  const [retiring, setRetiring] = React.useState(false);
  const [retireError, setRetireError] = React.useState<string | null>(null);
  const busy = !paused && (agent.state === "working" || agent.state === "thinking");
  const words = stateWords(agent);
  const task = busy ? agent.task?.title : null;
  // "Working on" quietly, then the task itself in full ink.
  const lead = task && words.endsWith(task) ? words.slice(0, words.length - task.length).trimEnd() : null;
  const last = agent.task && !asked ? formatAgo(agent.task.lastActivityAt) : null;
  const MachineIcon = machine.kind === "mac" ? Laptop : Cloud;
  const act = async (patch: Parameters<typeof updateAgent>[1]) => {
    if (saving) return;
    setSaving(true);
    const outcome = await updateAgent(agent.id, patch);
    setSaving(false);
    if (outcome.kind === "ok") {
      announceAgentsChanged();
      onChanged();
    } else if (outcome.kind === "failed") {
      toast.error(outcome.message);
    }
  };
  const remove = async () => {
    if (saving) return;
    setSaving(true);
    setRetireError(null);
    const outcome = await retireAgent(agent.id);
    setSaving(false);
    if (outcome.kind === "ok") {
      setRetiring(false);
      announceAgentsChanged();
      onChanged();
      toast.success(`${agent.name} was removed from Orbit.`);
    } else {
      setRetireError(outcome.message);
    }
  };
  return (
    <>
      {/* Full prefetch on aim (lib/intent-prefetch.ts): a viewport prefetch of
          a force-dynamic route stops at its loading boundary. */}
      <Link
        href={href}
        prefetch={false}
        {...intentPrefetch(router, href)}
        data-face-trigger
        data-state={paused ? "sleeping" : agent.state}
        className="orbit-agent-card"
      >
        <span className="orbit-crew__face">
          <AgentPresence avatar={agent.avatar} state={drawnState(agent)} size={size} gaze />
        </span>
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-body font-semibold">{agent.name}</span>
          {agent.role && <span className="truncate text-caption text-muted-foreground">{agent.role}</span>}
          {!asked && (
            <span className={cn("line-clamp-2 text-ui leading-5", busy ? "text-foreground" : "text-muted-foreground")} aria-live="polite">
              {lead ? <><span className="text-muted-foreground">{lead}</span> {task}</> : words}
            </span>
          )}
        </span>
        <ArrowUpRight className="orbit-agent-card__open size-4" aria-hidden="true" />
      </Link>
      <span className="orbit-crew__when flex items-center gap-1.5 text-caption text-muted-foreground">
        <MachineIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{machine.name}</span>
        {last && <span className="tabular-nums">{last}</span>}
      </span>
      <OrbitAgentActions agent={agent} href={href} onChanged={onChanged} />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`More for ${agent.name}`}
          disabled={saving}
          aria-busy={saving || undefined}
          className="orbit-crew__more absolute right-2 top-2 grid size-8 place-items-center rounded-control text-muted-foreground transition-[background-color,color] duration-fast ease-out-soft hover:bg-foreground/[0.05] hover:text-foreground coarse:size-11"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onSelect={() => setStudio(true)}>
            <Shapes className="size-4" aria-hidden="true" /> Personalize
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void act({ pinned: !agent.pinnedAt })}>
            <Pin className="size-4" aria-hidden="true" /> {agent.pinnedAt ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void act({ status: paused ? "active" : "paused" })}>
            {paused ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
            {paused ? "Resume" : "Pause"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive-ink focus:text-destructive-ink" onSelect={() => { setRetireError(null); setRetiring(true); }}>
            <Trash2 className="size-4" aria-hidden="true" /> Remove agent…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {studio && <AgentFaceStudio agent={agent} open onOpenChange={setStudio} onSaved={onChanged} />}
      <ConfirmDialog
        open={retiring}
        onOpenChange={setRetiring}
        title={`Remove ${agent.name}?`}
        description="This pauses its routines and removes its saved computer logins. Your conversations stay in history."
        confirmLabel="Remove agent"
        busy={retiring && saving}
        onConfirm={() => void remove()}
      >
        {retireError && <p role="alert" className="text-ui text-destructive-ink">{retireError}</p>}
      </ConfirmDialog>
    </>
  );
}
