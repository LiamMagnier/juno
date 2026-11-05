"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { intentPrefetch } from "@/lib/intent-prefetch";
import { MoreHorizontal, Pause, Pin, Play } from "@/components/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { AGENT_STATE_NAMES } from "@/lib/brand/names";
import { cn } from "@/lib/utils";
import { AgentPresence } from "./agent-presence";
import { formatAgo, localStateSentence } from "./agent-bits";
import { announceAgentsChanged, updateAgent } from "./agents-transport";

/*
 * Orbit's crew: your agents, one object each (docs/design/AGENTS.md §4.3).
 *
 * Each tile is the agent: its live face at a size where its shape and its
 * state both read, its name in the serif, its role, and one line saying what
 * it is doing, in words. Nothing is drawn around the faces (no card, no core,
 * no ring, no glow, no status pill or dot): the orbit is something an agent
 * does, not scenery. The grid is the real list (links a keyboard and a screen
 * reader use), and these are the only copies of the faces on the page.
 *
 * Each fact once: an agent with a Needs you card above carries no state line
 * here (the card says what it needs and when; the tile keeps its role), and
 * an agent's last activity is shown only on hover or focus.
 *
 * Calm by construction: the agents stand still, so a face is clicked where it
 * is, and rest life (a blink, a glance now and then) is all that moves while
 * nothing is happening.
 */

/** Large enough to be the page's picture, not a placeholder row: a few agents stand big. */
export function crewFaceSize(count: number) {
  if (count <= 4) return 120;
  if (count <= 6) return 96;
  return 64;
}
/** On a phone every face is drawn this size (agents.css scales the tile's face to it). */
const PHONE_FACE = 72;

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
  onChanged,
}: {
  agents: readonly ClientAgent[];
  /** Agents with a Needs you card above: the card says their state. */
  asked: ReadonlySet<string>;
  hrefOf: (agent: ClientAgent) => string;
  onChanged: () => void;
}) {
  const size = crewFaceSize(agents.length);
  const cols = agents.length > 4 && agents.length <= 6 ? "@[40rem]/page:grid-cols-3" : "@[40rem]/page:grid-cols-4";
  return (
    <ul
      role="list"
      className={cn("orbit-crew grid grid-cols-2 gap-x-2 gap-y-3 @[40rem]/page:gap-x-3", cols)}
      style={{ "--crew-phone-zoom": PHONE_FACE / size, "--crew-desk-face": `${size}px`, "--crew-phone-face": `${PHONE_FACE}px` } as React.CSSProperties}
    >
      {agents.map((agent, index) => (
        <li key={agent.id} className="orbit-crew__agent group/tile relative min-w-0" style={{ "--i": index } as React.CSSProperties}>
          <CrewTile agent={agent} size={size} asked={asked.has(agent.id)} href={hrefOf(agent)} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}

function CrewTile({ agent, size, asked, href, onChanged }: { agent: ClientAgent; size: number; asked: boolean; href: string; onChanged: () => void }) {
  const router = useRouter();
  const paused = agent.status === "paused";
  const busy = !paused && (agent.state === "working" || agent.state === "thinking");
  const words = stateWords(agent);
  const task = busy ? agent.task?.title : null;
  // "Working on" quietly, then the task itself in full ink.
  const lead = task && words.endsWith(task) ? words.slice(0, words.length - task.length).trimEnd() : null;
  const last = agent.task && !asked ? formatAgo(agent.task.lastActivityAt) : null;
  const act = async (patch: Parameters<typeof updateAgent>[1]) => {
    const outcome = await updateAgent(agent.id, patch);
    if (outcome.kind === "ok") {
      announceAgentsChanged();
      onChanged();
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
        data-state={agent.state}
        className="flex h-full flex-col items-center rounded-panel px-2 pb-4 pt-5 text-center transition-colors duration-fast ease-out-soft hover:bg-foreground/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="orbit-crew__face transition-transform duration-base ease-out-soft group-hover/tile:-translate-y-0.5 motion-reduce:transition-none">
          <AgentPresence avatar={agent.avatar} state={drawnState(agent)} size={size} gaze />
        </span>
        {/* On touch the menu sits at the end of this line (agents.css), so the name keeps clear of it on both sides. */}
        <span className="mt-3 max-w-full truncate font-serif text-body-lg leading-6 tracking-[-0.012em] text-foreground [font-optical-sizing:auto] coarse:max-w-[calc(100%-4.5rem)]">
          {agent.name}
        </span>
        {agent.role ? <span className="max-w-full truncate text-ui leading-5 text-muted-foreground">{agent.role}</span> : null}
        {asked ? null : (
          <span
            className={cn(
              "mt-1 line-clamp-2 max-w-full text-ui leading-5 [text-wrap:balance]",
              busy ? "text-foreground" : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            {lead ? (
              <>
                <span className="text-muted-foreground">{lead}</span> {task}
              </>
            ) : (
              words
            )}
          </span>
        )}
        {last ? (
          <span className="orbit-crew__when mt-0.5 text-caption tabular-nums text-muted-foreground">
            <span className="sr-only">, </span>
            {last}
          </span>
        ) : null}
      </Link>
      {/* Revealed on hover or focus at the tile's corner. On touch, where
          nothing hovers, it stays shown, but at the end of the name's line in
          the quietest ink (agents.css): away from the face, so a crew is not
          a row of ellipses at its shoulders, and never beside a thinking
          face's three dots. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`More for ${agent.name}`}
          className="orbit-crew__more absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-control text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-fast ease-out-soft hover:bg-foreground/[0.05] hover:text-foreground focus-visible:opacity-100 group-hover/tile:opacity-100 group-focus-within/tile:opacity-100 data-[state=open]:bg-foreground/[0.05] data-[state=open]:opacity-100 coarse:right-1 coarse:text-ink-tertiary coarse:opacity-100"
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
