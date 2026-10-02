"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pause, Pin, Play } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AppPage } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { ComposerShell, ComposerPrimaryAction, composerFieldClass } from "@/components/ui/composer-shell";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import {
  AGENT_JOB_EXAMPLES as EXAMPLES,
  agentNeedsYou as needsYou,
  newAgentInput,
  nextAgentFace as nextFace,
  nextAgentName as nextName,
  sortRosterAgents,
} from "@/lib/agents/new-agent";
import { cn } from "@/lib/utils";
import { AgentPresence } from "./agent-presence";
import { formatAgo, localStateSentence } from "./agent-bits";
import { announceAgentsChanged, hireAgent, updateAgent } from "./agents-transport";
import { useAgents } from "./use-agents";
import { AGENT_NOUN, AGENT_STATE_NAMES, BRAND, FEATURE_NAMES } from "@/lib/brand/names";

/*
 * Orbit, the agents home (docs/rework/brand/ORBIT_SYSTEM.md; design V3 crew
 * scenes; critique 1).
 *
 * The page opens on your agents themselves: a lineup of the shipped faces at a
 * size where form and state both read, each with its name in the serif, its
 * role, and its state in words (colour and pose never carry it alone). Above
 * them, a new agent starts by saying what it should take care of; the agent
 * then sets itself up in conversation. Below them, what needs you: every
 * attention item the same object, saying what is needed and who asked.
 *
 * No card per agent and no status pills or dots: the face is the object and
 * the words under it are its state.
 */

function agentHref(agent: ClientAgent): string {
  return agent.conversationId ? `/chat/${encodeURIComponent(agent.conversationId)}` : `/agents/${encodeURIComponent(agent.id)}`;
}

export function AgentsHome({ initialAgents, focusComposer = false }: { initialAgents?: ClientAgent[]; focusComposer?: boolean } = {}) {
  const { agents: fetched, error, settled, refresh } = useAgents({ enabled: initialAgents === undefined });
  const agents = initialAgents ?? fetched;
  const ready = initialAgents !== undefined || settled;
  const ordered = React.useMemo(() => (agents ? sortRosterAgents(agents) : null), [agents]);

  if (error && !agents) {
    return (
      <AppPage measure="wide">
        <LoadError title={`Couldn’t load your ${AGENT_NOUN.plural}`} description={error} onRetry={refresh} />
      </AppPage>
    );
  }
  if (!ready || ordered === null) return <AgentsHomeSkeleton />;
  if (ordered.length === 0) return <FirstAgent />;

  const attention = ordered.filter(needsYou);

  return (
    <AppPage measure="wide">
      <header className="flex flex-col gap-1.5">
        <h1 className="font-serif text-page-title font-normal text-foreground">{BRAND.orbit.label}</h1>
        <p className="max-w-[56ch] text-pretty text-body text-muted-foreground">
          <TeamSentence agents={ordered} />
        </p>
      </header>

      <div className="mt-7 max-w-3xl">
        <DescribeAgent team={ordered} autoFocus={focusComposer} />
      </div>

      <ul aria-label={BRAND.orbit.description} className="mt-10 grid grid-cols-2 gap-x-2 gap-y-1 @[40rem]/page:grid-cols-3 @[60rem]/page:grid-cols-6">
        {ordered.map((agent) => (
          <li key={agent.id} className="min-w-0">
            <Portrait agent={agent} onChanged={refresh} />
          </li>
        ))}
      </ul>

      {attention.length > 0 ? (
        <section aria-labelledby="orbit-needs-you" className="mt-11 pb-16">
          <h2 id="orbit-needs-you" className="mb-2.5 text-ui font-medium text-muted-foreground">
            {FEATURE_NAMES.needsYou.label}
          </h2>
          <ul className="flex flex-col gap-2">
            {attention.map((agent) => (
              <li key={agent.id}>
                <Attention agent={agent} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="pb-16" />
      )}
    </AppPage>
  );
}

/** "Your agents. Mira needs your answer and Ines is blocked; Otto and Rhea are working." Only what is happening. */
function TeamSentence({ agents }: { agents: readonly ClientAgent[] }) {
  const waiting = agents.filter((a) => a.state === "waiting" || (a.needsYou > 0 && a.state !== "blocked"));
  const blocked = agents.filter((a) => a.state === "blocked");
  const busy = agents.filter((a) => (a.state === "working" || a.state === "thinking") && !waiting.includes(a));
  const names = (list: readonly ClientAgent[]) =>
    list.length === 1 ? list[0].name : list.length === 2 ? `${list[0].name} and ${list[1].name}` : `${list[0].name} and ${list.length - 1} others`;
  const asks: string[] = [];
  if (waiting.length) asks.push(`${names(waiting)} ${waiting.length === 1 ? "needs" : "need"} your answer`);
  if (blocked.length) asks.push(`${names(blocked)} ${blocked.length === 1 ? "is" : "are"} blocked`);
  const doing = busy.length ? `${names(busy)} ${busy.length === 1 ? "is" : "are"} working` : "";
  const body = asks.length ? `${asks.join(" and ")}${doing ? `; ${doing}` : ""}.` : doing ? `${doing.charAt(0).toUpperCase()}${doing.slice(1)}.` : "Everyone is caught up.";
  return <>{`${BRAND.orbit.description}. ${body}`}</>;
}

/** The state under a face, in words: the live sentence while it matters, else the plain state. */
function stateWords(agent: ClientAgent): string {
  if (agent.status === "paused") return "Paused";
  if (agent.state === "waiting" || (agent.needsYou > 0 && agent.state !== "blocked")) return AGENT_STATE_NAMES.needsAnswer;
  if (agent.state === "idle") return AGENT_STATE_NAMES.ready;
  if (agent.state === "blocked") {
    const reason = localStateSentence(agent, agent.state);
    return reason ? `Blocked: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : AGENT_STATE_NAMES.blocked;
  }
  return localStateSentence(agent, agent.state) || AGENT_STATE_NAMES.working;
}

function Portrait({ agent, onChanged }: { agent: ClientAgent; onChanged: () => void }) {
  const waiting = agent.state === "waiting" || (agent.needsYou > 0 && agent.state !== "blocked");
  const words = stateWords(agent);
  const paused = agent.status === "paused";
  const act = async (patch: Parameters<typeof updateAgent>[1]) => {
    const outcome = await updateAgent(agent.id, patch);
    if (outcome.kind === "ok") {
      announceAgentsChanged();
      onChanged();
    }
  };
  return (
    <div className="group/portrait relative" data-state={agent.state}>
      <Link
        href={agentHref(agent)}
        data-face-trigger
        aria-label={`${agent.name}${agent.role ? `, ${agent.role}` : ""}. ${words}`}
        className="flex flex-col items-center rounded-panel px-2 pb-4 pt-3.5 text-center transition-colors duration-fast ease-out-soft hover:bg-accent active:bg-selected focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="grid size-24 place-items-center @[40rem]/page:size-28">
          <AgentPresence avatar={agent.avatar} state={paused ? "sleeping" : agent.state} size={88} spread={0.3} gaze />
        </span>
        <span className="mt-3.5 max-w-full truncate font-serif text-heading font-normal text-foreground">{agent.name}</span>
        {agent.role ? <span className="mt-0.5 max-w-full truncate text-ui text-muted-foreground">{agent.role}</span> : null}
        <span
          className={cn(
            "mt-2 line-clamp-2 max-w-[18ch] text-ui",
            waiting ? "font-medium text-[hsl(var(--attention))]" : paused ? "text-muted-foreground" : "text-foreground/80",
          )}
          aria-live="polite"
        >
          {words}
        </span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`More for ${agent.name}`}
          className="absolute right-2 top-2 grid size-8 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/portrait:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
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
    </div>
  );
}

/** One thing waiting on you: who, what kind of wait, where and when, then the words and the way in. */
function Attention({ agent }: { agent: ClientAgent }) {
  const blocked = agent.state === "blocked";
  const sentence = localStateSentence(agent, agent.state);
  const where = agent.task?.title;
  const when = agent.task ? formatAgo(agent.task.lastActivityAt) : null;
  const href = agent.task?.conversationId ? `/chat/${encodeURIComponent(agent.task.conversationId)}` : agentHref(agent);
  return (
    <div className="flex gap-3.5 rounded-card bg-muted px-4 py-4 dark:bg-card">
      <span className="shrink-0">
        <AgentPresence avatar={agent.avatar} state={agent.state} size={28} spread={0.2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-ui leading-[18px] text-muted-foreground">
          <span className="font-medium text-foreground">{agent.name}</span>{" "}
          {blocked ? <span className="text-foreground">is blocked</span> : <span className="font-medium text-[hsl(var(--attention))]">needs your answer</span>}
          {where ? ` in ${where}` : ""}
          {when ? `, ${when}` : ""}
        </p>
        <p className="mt-1 text-body leading-[23px] text-foreground">{sentence}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" asChild className="rounded-full">
            <Link href={href}>{blocked ? "See what’s needed" : "Answer in the chat"}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

/** No agents yet: a face, a question, and the same field. */
function FirstAgent() {
  const { user } = useApp();
  const firstName = user.name?.trim().split(/\s+/)[0];
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4 pb-[12vh] pt-10">
      <div className="flex w-full max-w-2xl flex-col items-center">
        <HeroComposer
          team={[]}
          heading={
            <h1 className="text-balance text-center font-serif text-display font-normal text-foreground">
              {`Who should take care of it${firstName ? `, ${firstName}` : ""}?`}
            </h1>
          }
        />
        <p className="mt-6 max-w-[52ch] text-center text-ui text-muted-foreground">
          {`An ${AGENT_NOUN.singular} carries one kind of work forward: it remembers what it learned, works on a schedule if you want, and asks before sending, paying or deleting anything.`}
        </p>
      </div>
    </div>
  );
}

/** Creates the agent from what was written and opens its thread, where it sets itself up in conversation. */
function useCreateAgent(team: readonly ClientAgent[]) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [arrived, setArrived] = React.useState(false);
  const salt = React.useMemo(() => Math.floor(Math.random() * 997), []);
  const face = React.useMemo(() => nextFace(team, salt), [team, salt]);
  const name = React.useMemo(() => nextName(team, salt), [team, salt]);
  const request = React.useRef<{ key: string; text: string } | null>(null);
  const create = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    if (!request.current || request.current.text !== text) request.current = { key: crypto.randomUUID(), text };
    try {
      const outcome = await hireAgent(newAgentInput({ text, name, avatar: face, creationKey: request.current.key }));
      if (outcome.kind !== "ok") {
        setError(outcome.message);
        setBusy(false);
        return;
      }
      announceAgentsChanged();
      const href = agentHref(outcome.value);
      router.prefetch(href);
      setArrived(true);
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(() => router.push(href), reduce ? 0 : 560);
    } catch {
      setError(`Couldn’t create that ${AGENT_NOUN.singular}. Your words are still here; try again.`);
      setBusy(false);
    }
  };
  return { busy, error, arrived, face, name, create };
}

function useAutosize(value: string, max: number) {
  const field = React.useRef<HTMLTextAreaElement | null>(null);
  React.useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [value, max]);
  return field;
}

/**
 * Create an agent by saying what it should take care of: the composer's
 * object (surface, one hairline, no shadow), one notch smaller. The note says
 * what it will never do without asking.
 */
function DescribeAgent({ team, autoFocus }: { team: readonly ClientAgent[]; autoFocus: boolean }) {
  const [value, setValue] = React.useState("");
  const { busy, error, name, create } = useCreateAgent(team);
  const field = useAutosize(value, 200);
  const id = React.useId();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void create(value);
      }}
      className="rounded-panel bg-background px-4 pb-2.5 pt-3 shadow-[0_0_0_1px_hsl(var(--border))] transition-shadow duration-fast ease-out-soft focus-within:shadow-[0_0_0_1px_hsl(var(--foreground)/0.25)] has-[textarea:focus-visible]:shadow-[0_0_0_2px_hsl(var(--ring)/0.55)] @[40rem]/page:pl-[18px] @[40rem]/page:pr-3"
    >
      <label htmlFor={id} className="block text-ui font-medium text-foreground/80">
        {`What should a new ${AGENT_NOUN.singular} take care of?`}
      </label>
      <textarea
        id={id}
        ref={field}
        value={value}
        rows={1}
        autoFocus={autoFocus}
        disabled={busy}
        maxLength={6000}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void create(value);
          }
          if (event.key === "Tab" && !value) {
            event.preventDefault();
            setValue(EXAMPLES[0]);
          }
        }}
        placeholder={EXAMPLES[0]}
        className="mt-1 block min-h-6 w-full resize-none bg-transparent text-body leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-70"
      />
      <div className="mt-2 flex flex-col items-stretch gap-2.5 @[40rem]/page:flex-row @[40rem]/page:items-center @[40rem]/page:justify-between">
        <p className="text-caption leading-4 text-muted-foreground" aria-live="polite">
          {error ? (
            <span role="alert" className="text-destructive-ink">
              {error}
            </span>
          ) : busy ? (
            `${name} is setting up…`
          ) : value.trim() ? (
            `${name} will take this on. It asks before sending, paying or deleting anything.`
          ) : (
            "It asks before sending, paying or deleting anything. You choose how it looks next."
          )}
        </p>
        <Button type="submit" size="sm" disabled={busy || !value.trim()} loading={busy} className="shrink-0 rounded-full coarse:h-11">
          {FEATURE_NAMES.createAgent.label}
        </Button>
      </div>
    </form>
  );
}

/** The first agent's field: the Chat landing's twin, with the face you are about to meet. */
function HeroComposer({ team, heading }: { team: readonly ClientAgent[]; heading: React.ReactNode }) {
  const [value, setValue] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const { busy, error, arrived, face, name, create } = useCreateAgent(team);
  const field = useAutosize(value, 220);
  const state: AgentState = arrived ? "done" : busy ? "working" : value.trim() ? "listening" : "idle";
  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-7">
        <AgentPresence avatar={face} state={focused && !value ? "idle" : state} size={84} spread={0.6} name={name} gaze />
      </div>
      {heading}
      <form
        className="relative mt-8 w-full"
        onSubmit={(event) => {
          event.preventDefault();
          void create(value);
        }}
      >
        <ComposerShell
          field={
            <textarea
              ref={field}
              value={value}
              rows={1}
              autoFocus
              disabled={busy}
              maxLength={6000}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void create(value);
                }
                if (event.key === "Tab" && !value) {
                  event.preventDefault();
                  setValue(EXAMPLES[0]);
                }
              }}
              placeholder={EXAMPLES[0]}
              aria-label={`Describe a job for your first ${AGENT_NOUN.singular}`}
              className={composerFieldClass}
            />
          }
          leading={
            <span className="pl-1.5 text-caption text-muted-foreground">
              {busy ? `${name} is setting up…` : value.trim() ? `${name} will take this on` : null}
            </span>
          }
          action={<ComposerPrimaryAction face={busy ? "busy" : "send"} type="submit" disabled={busy || !value.trim()} aria-label={FEATURE_NAMES.createAgent.label} />}
          dimmed={busy}
        />
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-ui text-destructive-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AgentsHomeSkeleton() {
  return (
    <AppPage measure="wide">
      <div role="status" aria-label={`Loading your ${AGENT_NOUN.plural}`}>
        <Skeleton className="h-9 w-32" />
        <Skeleton className="mt-3 h-4 w-80 max-w-full" />
        <Skeleton className="mt-7 h-[104px] w-full max-w-3xl rounded-panel" />
        <div className="mt-10 grid grid-cols-2 gap-2 @[40rem]/page:grid-cols-3 @[60rem]/page:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex flex-col items-center gap-3 py-4">
              <Skeleton className="size-24 rounded-full" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </AppPage>
  );
}
