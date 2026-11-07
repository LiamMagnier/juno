"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronRight, Cloud, Laptop, Plus } from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ClientAgent } from "@/lib/agents/types";
import type { AgentExecutionTarget } from "@/lib/agents/domain";
import type { ClientWorkHost } from "@/lib/work/serializers";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";
import { AgentFace } from "./agent-face";
import { announceAgentsChanged, updateAgent } from "./agents-transport";
import type { WorkHostsState } from "./use-work-hosts";

/*
 * Orbit's computers: the real machines its agents work on.
 *
 * An agent runs either on its own cloud computer (a private Linux desktop,
 * src/lib/computer) or on one of the person's Macs through Work
 * (native/Packages/JunoWork: files, browser, and screen control when the Mac
 * allows it). The server has carried both for a while; Orbit never showed
 * them, so "which computer is Atlas using, and is it on?" had no answer
 * outside each agent's profile. This panel is that answer: one row per
 * machine, its live state in words, the faces of the agents that work there,
 * and one menu to move an agent onto it. Hiring picks the machine up front
 * (`RunsOnChip`).
 *
 * Presence comes from the Mac's own heartbeat (`ClientWorkHost.state`, from
 * `hostStateFor`): online, not responding, offline. Nothing here is a guess.
 */

export type RunsOn = { target: "cloud" } | { target: "mac"; hostId: string | null };

export const CLOUD_LABEL = "Cloud computer";

/** Where an agent works, in the shape the composer and the rows share. */
export function runsOnOf(agent: Pick<ClientAgent, "executionTarget" | "preferredHostId">): RunsOn {
  return agent.executionTarget === "mac" ? { target: "mac", hostId: agent.preferredHostId ?? null } : { target: "cloud" };
}

/** The create/patch fields for a machine choice. */
export function runsOnInput(choice: RunsOn): { executionTarget: AgentExecutionTarget; preferredHostId?: string | null } {
  return choice.target === "cloud" ? { executionTarget: "cloud" } : { executionTarget: "mac", preferredHostId: choice.hostId };
}

type Presence = "online" | "busy" | "stale" | "offline" | "off";

function presenceOf(host: ClientWorkHost): Presence {
  if (!host.enabled) return "off";
  if (host.state === "online") return "busy";
  if (host.state === "idle") return "online";
  if (host.state === "stale") return "stale";
  return "offline";
}

const PRESENCE_WORDS: Record<Presence, string> = {
  busy: "Working now",
  online: "Online",
  stale: "Not responding",
  offline: "Offline",
  off: "Work switched off",
};

/** What the Mac lets an agent do, after its presence: the one capability people ask about. */
function hostLine(host: ClientWorkHost): string {
  const presence = presenceOf(host);
  const words = PRESENCE_WORDS[presence];
  if (presence === "off") return words;
  const runs = host.activeRunCount > 0 ? `${host.activeRunCount} running` : null;
  const control = host.allowsComputerUse ? "screen control on" : "files and browser";
  return [presence === "busy" && runs ? runs : words, control].join(" · ");
}

/** The agents working on this Mac: those that named it, and those that take any Mac. */
function agentsOnHost(agents: readonly ClientAgent[], host: ClientWorkHost, hosts: readonly ClientWorkHost[]): ClientAgent[] {
  return agents.filter((agent) => {
    if (agent.executionTarget !== "mac") return false;
    const named = agent.preferredHostId ?? null;
    if (named === host.id) return true;
    // No Mac named, or one that is gone: dispatch uses any of them.
    return named === null || !hosts.some((h) => h.id === named);
  });
}

function sameMachine(a: RunsOn, b: RunsOn): boolean {
  if (a.target !== b.target) return false;
  return a.target === "cloud" || a.hostId === (b as { hostId: string | null }).hostId;
}

/** A row's face stack: up to three faces, then a count. */
function FaceStack({ agents }: { agents: readonly ClientAgent[] }) {
  if (agents.length === 0) return null;
  const shown = agents.slice(0, 3);
  const rest = agents.length - shown.length;
  return (
    <span className="flex shrink-0 items-center" aria-label={agents.map((a) => a.name).join(", ")} role="img">
      {shown.map((agent, index) => (
        <span
          key={agent.id}
          className={cn("grid size-7 place-items-center", index > 0 && "-ml-1.5")}
          style={{ zIndex: shown.length - index }}
        >
          <AgentFace avatar={agent.avatar} state={agent.status === "paused" ? "sleeping" : agent.state} size={24} still />
        </span>
      ))}
      {rest > 0 ? (
        <span className="-ml-1 grid h-6 min-w-6 place-items-center rounded-full bg-secondary px-1.5 font-mono text-caption tabular-nums text-muted-foreground">
          {`+${rest}`}
        </span>
      ) : null}
    </span>
  );
}

/** The machine's glyph, with its presence as a dot on the corner, in the 28px seat a face takes in the Needs you rows. */
function MachineMark({ kind, presence }: { kind: "cloud" | "mac"; presence: Presence }) {
  const Icon = kind === "cloud" ? Cloud : Laptop;
  return (
    <span className="relative grid size-7 shrink-0 place-items-center text-foreground">
      <Icon className="size-5" aria-hidden="true" />
      <span className="orbit-machine__dot absolute bottom-0.5 right-0 size-2 rounded-full ring-2 ring-card" data-presence={presence} aria-hidden="true" />
    </span>
  );
}

const PRESENCE_INK: Record<Presence, string> = {
  busy: "text-presence-ink",
  online: "text-success-ink",
  stale: "text-attention",
  offline: "text-muted-foreground",
  off: "text-muted-foreground",
};

function MoveHere({
  label,
  candidates,
  onPick,
}: {
  label: string;
  candidates: readonly ClientAgent[];
  onPick: (agent: ClientAgent) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Move an agent to ${label}`}
        className="orbit-row__action grid size-7 shrink-0 place-items-center rounded-control text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Plus className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel>{`Move to ${label}`}</DropdownMenuLabel>
        {candidates.map((agent) => (
          <DropdownMenuItem key={agent.id} onSelect={() => onPick(agent)}>
            <AgentFace avatar={agent.avatar} state="idle" size={20} still />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MachineRow({
  kind,
  name,
  status,
  detail,
  presence,
  agents,
  move,
}: {
  kind: "cloud" | "mac";
  name: string;
  status: string;
  detail: string | null;
  presence: Presence;
  agents: readonly ClientAgent[];
  move: React.ReactNode;
}) {
  return (
    <li className="orbit-row flex items-center gap-3 rounded-inner px-3 py-2.5" data-presence={presence}>
      <MachineMark kind={kind} presence={presence} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium leading-5 text-foreground" translate={kind === "mac" ? "no" : undefined}>
          {name}
        </span>
        <span className="block truncate text-caption leading-4 text-muted-foreground">
          <span className={PRESENCE_INK[presence]}>{status}</span>
          {detail ? ` · ${detail}` : null}
        </span>
      </span>
      <FaceStack agents={agents} />
      {move}
    </li>
  );
}

export function OrbitComputers({
  agents,
  hosts,
  onRetry,
  onChanged,
}: {
  agents: readonly ClientAgent[];
  hosts: WorkHostsState;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const macs = hosts.kind === "ok" ? hosts.hosts : [];
  const cloudAgents = agents.filter((agent) => agent.executionTarget !== "mac");
  const awake = cloudAgents.filter((agent) => agent.computer?.enabled && agent.computer.status === "running").length;

  const move = async (agent: ClientAgent, to: RunsOn, label: string) => {
    const outcome = await updateAgent(agent.id, runsOnInput(to));
    if (outcome.kind === "ok") {
      announceAgentsChanged();
      onChanged();
      toast.success(`${agent.name} now works on ${label}`);
    } else {
      toast.error(outcome.message || `Couldn’t move ${agent.name}.`);
    }
  };

  return (
    <section aria-labelledby="orbit-computers">
      <div className="mb-2.5 flex min-h-6 items-center gap-2 px-0.5">
        <h2 id="orbit-computers" className="text-ui font-medium text-foreground">
          Computers
        </h2>
        {macs.length > 0 ? (
          <Link
            href="/settings?section=devices"
            className="ml-auto rounded-sm text-caption text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          >
            Manage
          </Link>
        ) : null}
      </div>
      <ul className="nest-card nest-p-1 flex flex-col border border-foreground/[0.08] bg-card">
        <MachineRow
          kind="cloud"
          name={CLOUD_LABEL}
          status="Always on"
          detail={awake > 0 ? `${awake} awake` : null}
          presence="online"
          agents={cloudAgents}
          move={
            <MoveHere
              label="the cloud"
              candidates={agents.filter((agent) => agent.executionTarget === "mac")}
              onPick={(agent) => void move(agent, { target: "cloud" }, "its cloud computer")}
            />
          }
        />
        {macs.map((host) => {
          const here: RunsOn = { target: "mac", hostId: host.id };
          const presence = presenceOf(host);
          return (
            <MachineRow
              key={host.id}
              kind="mac"
              name={host.displayName}
              status={presence === "busy" && host.activeRunCount > 0 ? `${host.activeRunCount} running` : PRESENCE_WORDS[presence]}
              detail={presence === "off" ? null : host.allowsComputerUse ? "screen control" : "files and browser"}
              presence={presence}
              agents={agentsOnHost(agents, host, macs)}
              move={
                <MoveHere
                  label={host.displayName}
                  candidates={agents.filter((agent) => !sameMachine(runsOnOf(agent), here))}
                  onPick={(agent) => void move(agent, here, host.displayName)}
                />
              }
            />
          );
        })}
        {hosts.kind === "loading" ? (
          <li className="px-3 py-2.5 text-caption text-muted-foreground" role="status" aria-live="polite">
            Checking your Macs…
          </li>
        ) : hosts.kind === "failed" ? (
          <li className="flex flex-wrap items-baseline gap-x-2 px-3 py-2.5 text-caption text-muted-foreground" role="status">
            <span>{hosts.message}</span>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              Try again
            </button>
          </li>
        ) : macs.length === 0 ? (
          <ConnectMac />
        ) : null}
      </ul>
    </section>
  );
}

/**
 * No Mac yet: a row in the same list, saying what connecting one gives. The
 * pairing happens in the Mac app (sign in, turn on Work), so the way in is
 * the download; the list picks the Mac up on its next poll.
 */
function ConnectMac() {
  return (
    <li>
      <Link
        href="/download"
        className="orbit-row group/connect flex items-center gap-3 rounded-inner px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="grid size-7 shrink-0 place-items-center text-muted-foreground">
          <Laptop className="size-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium leading-5 text-foreground">Connect your Mac</span>
          <span className="block text-pretty text-caption leading-4 text-muted-foreground">
            {`Agents work in your real apps and files, and ask first. Install ${PRODUCT_NAME} for Mac and turn on Work.`}
          </span>
        </span>
        <ChevronRight className="orbit-row__go size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Link>
    </li>
  );
}

/**
 * The composer's machine choice: where a new agent will work. Cloud by
 * default; each Mac with its live state, so picking an offline one is a
 * choice made knowing it (its tasks wait for it).
 */
export function RunsOnChip({
  value,
  onChange,
  hosts,
  disabled,
}: {
  value: RunsOn;
  onChange: (next: RunsOn) => void;
  hosts: WorkHostsState;
  disabled?: boolean;
}) {
  const macs = hosts.kind === "ok" ? hosts.hosts.filter((host) => host.enabled) : [];
  const chosen = value.target === "mac" ? macs.find((host) => host.id === value.hostId) ?? null : null;
  const label = value.target === "cloud" ? "Cloud" : chosen?.displayName ?? "Your Mac";
  const Icon = value.target === "cloud" ? Cloud : Laptop;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={`Runs on: ${label}`}
        className="pressable inline-flex h-8 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full border border-foreground/[0.1] pl-2.5 pr-2 text-ui text-foreground hover:bg-foreground/[0.04] data-[state=open]:bg-foreground/[0.04] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate" translate={chosen ? "no" : undefined}>
          {label}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Works on</DropdownMenuLabel>
        <RunsOnItem
          icon={Cloud}
          title={CLOUD_LABEL}
          detail="Its own private desktop. Works with your laptop closed."
          checked={value.target === "cloud"}
          onSelect={() => onChange({ target: "cloud" })}
        />
        {macs.map((host) => (
          <RunsOnItem
            key={host.id}
            icon={Laptop}
            title={host.displayName}
            detail={hostLine(host)}
            presence={presenceOf(host)}
            checked={value.target === "mac" && value.hostId === host.id}
            onSelect={() => onChange({ target: "mac", hostId: host.id })}
          />
        ))}
        {hosts.kind === "ok" && macs.length === 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/download">
                <Laptop className="size-4" aria-hidden="true" />
                Connect a Mac…
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunsOnItem({
  icon: Icon,
  title,
  detail,
  presence,
  checked,
  onSelect,
}: {
  icon: typeof Cloud;
  title: string;
  detail: string;
  presence?: Presence;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="items-start py-2">
      <span className="relative mt-0.5 shrink-0">
        <Icon className="size-4" aria-hidden="true" />
        {presence ? (
          <span className="orbit-machine__dot absolute -bottom-0.5 -right-1 size-1.5 rounded-full" data-presence={presence} aria-hidden="true" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate" translate={presence ? "no" : undefined}>
          {title}
        </span>
        <span className="block text-caption text-muted-foreground">{detail}</span>
      </span>
      <Check className={cn("mt-0.5 size-4 shrink-0", checked ? "opacity-100" : "opacity-0")} aria-hidden="true" />
    </DropdownMenuItem>
  );
}

