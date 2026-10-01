"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Hand, MoreHorizontal, Pause, Pin, Play } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { AppPage } from "@/components/app/app-page";
import { useApp } from "@/components/app/app-provider";
import { ComposerShell, ComposerPrimaryAction, composerFieldClass } from "@/components/ui/composer-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { AGENT_JOB_EXAMPLES as EXAMPLES, agentNeedsYou as needsYou, newAgentInput, nextAgentFace as nextFace, nextAgentName as nextName, sortRosterAgents } from "@/lib/agents/new-agent";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AgentPresence, AgentStatusLine } from "./agent-presence";
import { formatAgo, formatLocalWhen, localStateSentence } from "./agent-bits";
import { announceAgentsChanged, hireAgent, updateAgent } from "./agents-transport";
import { useAgents } from "./use-agents";

/**
 * Agents home (docs/design/agents-rework/DIRECTION.md, revised 2026-09-30).
 *
 * The page is a person's team, not a settings screen. With no agents it is
 * the Chat landing's twin: a face, a question, the same composer. Describing
 * a job creates the agent that face belongs to, which then opens its thread
 * and sets itself up in conversation. With agents, the same composer sits
 * above a grid of live cards: the face says what each one is doing before
 * the words do.
 *
 * No second navigation column (the sidebar already lists the team), no
 * filters, no counts, no chips under the composer.
 */

function agentHref(agent: ClientAgent): string {
  return agent.conversationId
    ? `/chat/${encodeURIComponent(agent.conversationId)}`
    : `/agents/${encodeURIComponent(agent.id)}`;
}

export function AgentsHome({
  initialAgents,
  focusComposer = false,
}: {
  initialAgents?: ClientAgent[];
  focusComposer?: boolean;
} = {}) {
  const { agents: fetched, error, settled, refresh } = useAgents({ enabled: initialAgents === undefined });
  const agents = initialAgents ?? fetched;
  const ready = initialAgents !== undefined || settled;
  const ordered = React.useMemo(() => (agents ? sortRosterAgents(agents) : null), [agents]);

  if (error && !agents) {
    return (
      <AppPage measure="wide">
        <LoadError title="Couldn’t load your crew" description={error} onRetry={refresh} />
      </AppPage>
    );
  }
  if (!ready || ordered === null) return <AgentsHomeSkeleton />;
  if (ordered.length === 0) return <FirstAgent />;

  return (
    <AppPage measure="wide">
      <header className="flex flex-col gap-1 pb-8">
        <h1 className="font-serif text-page-title text-foreground">Crew</h1>
        <p className="text-body text-muted-foreground">
          <TeamSentence agents={ordered} />
        </p>
      </header>

      <JobComposer team={ordered} autoFocus={focusComposer} compact />

      <ul className="mt-10 grid grid-cols-1 gap-3 pb-16 @[40rem]/page:grid-cols-2 @[66rem]/page:grid-cols-3" aria-label="Your crew">
        {ordered.map((agent, index) => (
          <li key={agent.id} style={staggerDelay(index, "tight")} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]">
            <AgentCard agent={agent} onChanged={refresh} />
          </li>
        ))}
      </ul>
    </AppPage>
  );
}

/** "Mira needs you. Scout is working." Only what is happening, in plain words. */
function TeamSentence({ agents }: { agents: readonly ClientAgent[] }) {
  const waiting = agents.filter(needsYou);
  const busy = agents.filter((a) => a.state === "working" || a.state === "thinking");
  const names = (list: readonly ClientAgent[]) =>
    list.length === 1 ? list[0].name : list.length === 2 ? `${list[0].name} and ${list[1].name}` : `${list[0].name} and ${list.length - 1} others`;
  const parts: string[] = [];
  if (waiting.length) parts.push(`${names(waiting)} ${waiting.length === 1 ? "needs" : "need"} you.`);
  if (busy.length) parts.push(`${names(busy)} ${busy.length === 1 ? "is" : "are"} working.`);
  if (!parts.length) parts.push("Everyone is caught up.");
  return <>{parts.join(" ")}</>;
}

function AgentCard({ agent, onChanged }: { agent: ClientAgent; onChanged: () => void }) {
  const attention = needsYou(agent);
  const sentence = localStateSentence(agent, agent.state);
  // The quiet line under the sentence says what the sentence does not: when
  // it last did something, or (when busy) what it does next.
  const footnote = agent.task
    ? `Active ${formatAgo(agent.task.lastActivityAt)}`
    : agent.nextRoutine && agent.state !== "idle"
      ? `Next: ${agent.nextRoutine.name}, ${formatLocalWhen(new Date(agent.nextRoutine.nextRunAt), new Date())}`
      : agent.status === "paused"
        ? "Resume it from the menu"
        : null;
  const paused = agent.status === "paused";
  const act = async (patch: Parameters<typeof updateAgent>[1]) => {
    const outcome = await updateAgent(agent.id, patch);
    if (outcome.kind === "ok") {
      announceAgentsChanged();
      onChanged();
    }
  };

  return (
    <div
      className="agent-card group relative"
      style={{ "--card-tone": `var(--agent-${agent.avatar.tone})` } as React.CSSProperties}
      data-attention={attention ? "" : undefined}
      data-state={agent.state}
    >
      <Link
        href={agentHref(agent)}
        data-face-trigger
        className="agent-card__link flex items-center gap-4 @[40rem]/page:block"
        aria-label={`${agent.name}. ${attention ? "Needs you. " : ""}${sentence}`}
      >
        <AgentPresence avatar={agent.avatar} state={agent.state} size={52} gaze />
        <span className="block min-w-0 flex-1 @[40rem]/page:mt-5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-body-lg font-medium text-foreground">{agent.name}</span>
            {agent.role ? <span className="truncate text-ui text-muted-foreground">{agent.role}</span> : null}
          </span>
          {attention ? (
            <span className="mt-1.5 flex items-center gap-1.5 text-ui font-medium text-primary">
              <Hand className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{sentence}</span>
            </span>
          ) : (
            <AgentStatusLine text={sentence} state={agent.state} className="mt-1.5 text-ui text-foreground/80" />
          )}
          <span className="mt-1 block truncate text-caption text-muted-foreground empty:hidden @[40rem]/page:mt-4 @[40rem]/page:h-4 @[40rem]/page:empty:block">{footnote}</span>
        </span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`More for ${agent.name}`}
          className="agent-card__more"
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

/** No agents yet: the Chat landing's twin, with the face you are about to meet. */
function FirstAgent() {
  const { user } = useApp();
  const firstName = user.name?.trim().split(/\s+/)[0];
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4 pb-[12vh] pt-10">
      <div className="flex w-full max-w-2xl flex-col items-center">
        <JobComposer team={[]} autoFocus hero heading={
          <h1 className="text-balance text-center font-serif text-display font-normal text-foreground motion-safe:animate-rise-in">
            Who should take care of it{firstName ? <>, <span>{firstName}</span></> : null}?
          </h1>
        } />
      </div>
    </div>
  );
}

/**
 * The one field. Describe a job, and the agent whose face sits beside it is
 * created, named, and opened on its thread with that job as its first
 * message. While you type, the face watches; when you send, it hops.
 */
function JobComposer({
  team,
  autoFocus = false,
  compact = false,
  hero = false,
  heading,
}: {
  team: readonly ClientAgent[];
  autoFocus?: boolean;
  compact?: boolean;
  hero?: boolean;
  heading?: React.ReactNode;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [arrived, setArrived] = React.useState(false);
  const example = 0;
  const [focused, setFocused] = React.useState(false);
  const salt = React.useMemo(() => Math.floor(Math.random() * 997), []);
  const face = React.useMemo(() => nextFace(team, salt), [team, salt]);
  const name = React.useMemo(() => nextName(team, salt), [team, salt]);
  const field = React.useRef<HTMLTextAreaElement | null>(null);
  const request = React.useRef<{ key: string; text: string } | null>(null);

  React.useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const state: AgentState = arrived ? "done" : busy ? "working" : value.trim() ? "listening" : focused ? "idle" : "idle";

  const submit = async () => {
    const text = value.trim();
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
      window.setTimeout(() => router.push(href), reduce ? 0 : 820);
    } catch {
      setError("Couldn’t start that agent. Your words are still here; try again.");
      setBusy(false);
    }
  };

  return (
    <div className={cn("w-full", hero && "flex flex-col items-center")}>
      {hero ? (
        <div className="mb-7 motion-safe:animate-rise-in">
          <AgentPresence avatar={face} state={state} size={84} spread={0.6} name={name} gaze />
        </div>
      ) : null}
      {heading}
      <form
        className={cn("relative w-full", hero ? "mt-8" : "")}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ComposerShell
          field={
            <div className="flex items-start">
              {!hero ? (
                <span className="ml-3.5 mt-3 shrink-0" aria-hidden="true">
                  <AgentPresence avatar={face} state={state} size={28} spread={0.35} gaze />
                </span>
              ) : null}
              <textarea
                ref={field}
                value={value}
                rows={1}
                autoFocus={autoFocus}
                disabled={busy}
                maxLength={6000}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                  if (event.key === "Tab" && !value) {
                    event.preventDefault();
                    setValue(EXAMPLES[example]);
                  }
                }}
                placeholder={EXAMPLES[example]}
                aria-label={compact ? "Give a new agent a job" : "Describe a job for your first agent"}
                className={cn(composerFieldClass, !hero && "pl-3")}
              />
            </div>
          }
          leading={
            <span className="pl-1.5 text-caption text-muted-foreground">
              {busy ? (
                <span key="busy" className="motion-safe:animate-fade-in">{name} is setting up…</span>
              ) : value.trim() ? (
                <span key="who" className="motion-safe:animate-fade-in">{name} will take this on</span>
              ) : hero ? null : (
                <span key="hint" className="coarse:hidden">Press Tab to use the example</span>
              )}
            </span>
          }
          action={
            <ComposerPrimaryAction
              face={busy ? "busy" : "send"}
              type="submit"
              disabled={busy || !value.trim()}
              aria-label={`Start ${name}`}
            />
          }
          dimmed={busy}
        />
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-ui text-destructive">
          {error}
        </p>
      ) : (
        <p className={cn("mt-3 text-caption text-muted-foreground", hero ? "text-center" : "px-1")}>
          It asks before sending, paying or deleting anything.
        </p>
      )}
    </div>
  );
}

function AgentsHomeSkeleton() {
  return (
    <AppPage measure="wide">
      <div role="status" aria-label="Loading agents">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="mt-3 h-4 w-64" />
        <Skeleton className="mt-8 h-[98px] w-full rounded-composer" />
        <div className="mt-10 grid grid-cols-1 gap-3 @[40rem]/page:grid-cols-2 @[66rem]/page:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-panel" />
          ))}
        </div>
      </div>
    </AppPage>
  );
}
