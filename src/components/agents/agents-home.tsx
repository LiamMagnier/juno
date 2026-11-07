"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CalendarClock, ChevronRight, Globe, Mail, Plus, Telescope } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AppPage, AppPageHeader, AppPageHeaderSkeleton } from "@/components/app/app-page";
import { useApp, useOptionalApp } from "@/components/app/app-provider";
import { ComposerShell, ComposerPrimaryAction, composerFieldClass } from "@/components/ui/composer-shell";
import type { Plan } from "@prisma/client";
import { EmptyState } from "@/components/ui/empty-state";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { agentHiringGate, type AgentHiringGate } from "@/lib/agents/plan-gate";
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
import { OrbitCrew } from "./orbit-stage";
import { formatAgo, localStateSentence } from "./agent-bits";
import { announceAgentsChanged, hireAgent } from "./agents-transport";
import { useAgents } from "./use-agents";
import { useWorkHosts, type WorkHostsState } from "./use-work-hosts";
import { OrbitComputers, RunsOnChip, runsOnInput, type RunsOn } from "./orbit-computers";
import { AGENT_NOUN, BRAND, FEATURE_NAMES } from "@/lib/brand/names";
import { prefersReducedMotion } from "@/lib/motion-preference";
import { staggerDelay } from "@/lib/motion";
import { touchReturnBreaksLine } from "@/lib/touch-keyboard";

/*
 * Orbit, the agents home (docs/rework/brand/ORBIT_SYSTEM.md; design V3 crew
 * scenes; critique 1).
 *
 * What needs you leads (every attention item the same object, saying what is
 * needed and who asked), then your crew: one tile per agent, its live face at
 * a size where form and state both read, its name in the serif, its role, and
 * its state in words (colour and pose never carry it alone). Below them, a
 * new agent starts by saying what it should take care of; the agent then sets
 * itself up in conversation.
 *
 * One object per agent and each fact once (docs/design/AGENTS.md §4.3): no
 * second list of the same agents, no status pills or dots.
 */

/**
 * The homepage's finish on the page title: tight serif tracking with optical
 * sizing (alv-display), one rung calmer than the hero.
 */
const TITLE_FINISH = "[&_h1]:tracking-[-0.03em] [&_h1]:[font-optical-sizing:auto]";

/**
 * Quiet entrance: rise 6px on the expo ease, on the shared row stagger
 * (`staggerDelay`, 30ms, at most four steps: spec D17). The curve is the
 * token, so reduced motion flattens it with the rest; it was a literal
 * cubic-bezier, the one entrance here the preference could not reach.
 */
const RISE = "motion-safe:animate-rise-in";
function stagger(step: number): React.CSSProperties {
  return {
    ...staggerDelay(step, "tight"),
    animationDuration: "var(--dur-slow)",
    animationTimingFunction: "var(--ease-out-expo)",
    animationFillMode: "both",
  };
}

function agentHref(agent: ClientAgent): string {
  return agent.conversationId ? `/chat/${encodeURIComponent(agent.conversationId)}` : `/agents/${encodeURIComponent(agent.id)}`;
}

export function AgentsHome({
  initialAgents,
  focusComposer = false,
  plan,
}: {
  initialAgents?: ClientAgent[];
  focusComposer?: boolean;
  /**
   * The account's plan, when the page read it on the server. Otherwise the
   * app's own quota; with neither (a design gallery) hiring is shown, and the
   * server still refuses a plan without agents (src/lib/agents/plan-gate.ts).
   */
  plan?: Plan;
} = {}) {
  const { agents: fetched, error, settled, refresh } = useAgents({ enabled: initialAgents === undefined });
  const agents = initialAgents ?? fetched;
  const ready = initialAgents !== undefined || settled;
  const ordered = React.useMemo(() => (agents ? sortRosterAgents(agents) : null), [agents]);
  const appPlan = useOptionalApp()?.quota.plan;
  const knownPlan = plan ?? appPlan ?? null;
  const hiring = knownPlan ? agentHiringGate(knownPlan) : null;
  const canHire = hiring?.allowed !== false;

  if (error && !agents) {
    return (
      <AppPage measure="wide">
        <LoadError title={`Couldn’t load your ${AGENT_NOUN.plural}`} description={error} onRetry={refresh} />
      </AppPage>
    );
  }
  if (!ready || ordered === null) return <AgentsHomeSkeleton />;
  if (ordered.length === 0) return canHire || !hiring ? <FirstAgent /> : <AgentsUpgrade gate={hiring} />;

  const attention = ordered.filter(needsYou);
  const asked = new Set(attention.map((agent) => agent.id));

  return <OrbitHome agents={ordered} attention={attention} asked={asked} canHire={canHire} hiring={hiring} autoFocus={focusComposer} onChanged={refresh} />;
}

/** "Mira", "Mira and Atlas", "Mira, Atlas and Scout", "Mira, Atlas and 2 others". */
function nameList(agents: readonly ClientAgent[]): string {
  const names = agents.map((agent) => agent.name);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/**
 * The page's lede: how the crew stands, as a sentence with names in it rather
 * than a row of coloured counters. Who needs you first, then who is at work.
 */
function crewSentence(agents: readonly ClientAgent[], attention: readonly ClientAgent[]): string {
  const asked = new Set(attention.map((agent) => agent.id));
  const working = agents.filter(
    (agent) => !asked.has(agent.id) && agent.status !== "paused" && (agent.state === "working" || agent.state === "thinking"),
  );
  const parts: string[] = [];
  if (attention.length) parts.push(`${nameList(attention)} ${attention.length === 1 ? "needs" : "need"} you.`);
  if (working.length) parts.push(`${nameList(working)} ${working.length === 1 ? "is" : "are"} working.`);
  if (!parts.length) parts.push(agents.length === 1 ? `${agents[0].name} is ready when you are.` : "Everyone is ready when you are.");
  return parts.join(" ");
}

/**
 * Orbit with a crew (V5, Nov 2026). A wide page has two columns: the crew as
 * cards with the field that starts a new agent under them, and a rail with
 * what needs you and the computers the crew works on. A narrow page is one
 * column in reading order: needs you, the crew, the field, the computers.
 * Every section is the same object (a label above, a hairline card below),
 * so the page reads as one system rather than four widgets.
 */
function OrbitHome({
  agents,
  attention,
  asked,
  canHire,
  hiring,
  autoFocus,
  onChanged,
}: {
  agents: readonly ClientAgent[];
  attention: readonly ClientAgent[];
  asked: ReadonlySet<string>;
  canHire: boolean;
  hiring: AgentHiringGate | null;
  autoFocus: boolean;
  onChanged: () => void;
}) {
  const { state: hosts, retry } = useWorkHosts(true);
  const composer = React.useRef<HTMLTextAreaElement | null>(null);
  const showHire = canHire || !hiring;
  const macs = hosts.kind === "ok" ? hosts.hosts : [];
  const machineOf = (agent: ClientAgent): { kind: "cloud" | "mac"; name: string } => {
    if (agent.executionTarget !== "mac") return { kind: "cloud", name: "Cloud computer" };
    const named = agent.preferredHostId ? macs.find((host) => host.id === agent.preferredHostId) : null;
    return { kind: "mac", name: named?.displayName ?? "Any of your Macs" };
  };
  return (
    <AppPage measure="full" contentClassName="max-w-6xl">
      <AppPageHeader
        heading={BRAND.orbit.label}
        className={TITLE_FINISH}
        lede={crewSentence(agents, attention)}
        actions={
          showHire ? (
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                const field = composer.current;
                if (!field) return;
                field.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
                field.focus({ preventScroll: true });
              }}
            >
              <Plus className="size-4" aria-hidden="true" />
              {`New ${AGENT_NOUN.singular}`}
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-8 pb-16 @[60rem]/page:grid-cols-[minmax(0,1fr)_20rem] @[60rem]/page:grid-rows-[auto_1fr] @[60rem]/page:gap-x-8">
        {attention.length > 0 ? (
          <section aria-labelledby="orbit-needs-you" className="order-1 min-w-0 @[60rem]/page:col-start-2 @[60rem]/page:row-start-1">
            <SectionLabel id="orbit-needs-you" count={attention.length > 1 ? attention.length : null} tone="needs">
              {FEATURE_NAMES.needsYou.label}
            </SectionLabel>
            <ul className="nest-card nest-p-1 flex flex-col border border-foreground/[0.08] bg-card">
              {attention.map((agent, index) => (
                <li key={agent.id} className={RISE} style={stagger(index)}>
                  <Attention agent={agent} row />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="order-2 flex min-w-0 flex-col gap-8 @[60rem]/page:col-start-1 @[60rem]/page:row-span-2 @[60rem]/page:row-start-1">
          <section aria-labelledby="orbit-crew">
            <SectionLabel id="orbit-crew" count={agents.length}>{`Your ${AGENT_NOUN.plural}`}</SectionLabel>
            <OrbitCrew agents={agents} asked={asked} hrefOf={agentHref} machineOf={machineOf} onChanged={onChanged} />
          </section>

          <section aria-label={`New ${AGENT_NOUN.singular}`} className={RISE} style={stagger(Math.min(agents.length, 4))}>
            {showHire ? (
              <DescribeAgent team={agents} autoFocus={autoFocus} hosts={hosts} fieldRef={composer} />
            ) : hiring ? (
              <AgentsUpgrade gate={hiring} kept />
            ) : null}
          </section>
        </div>

        <div className={cn("order-3 min-w-0 @[60rem]/page:col-start-2", attention.length > 0 ? "@[60rem]/page:row-start-2" : "@[60rem]/page:row-start-1 @[60rem]/page:row-span-2")}>
          <OrbitComputers agents={agents} hosts={hosts} onRetry={retry} onChanged={onChanged} />
        </div>
      </div>
    </AppPage>
  );
}

/** Every Orbit section opens the same way: a small label, an optional count, then its card. */
export function SectionLabel({
  id,
  count,
  tone,
  action,
  children,
}: {
  id: string;
  count?: number | null;
  tone?: "needs";
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 flex min-h-6 items-center gap-2 px-0.5">
      <h2 id={id} className="text-ui font-medium text-foreground">
        {children}
      </h2>
      {count != null ? (
        <span
          className={cn(
            "font-mono text-caption tabular-nums",
            tone === "needs" ? "text-status-needs-you-ink" : "text-muted-foreground",
          )}
        >
          {count}
        </span>
      ) : null}
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

/**
 * What the lead of a Needs you card says after the agent's name: the one
 * nuance the task's status carries (an approval, a usage window, a Mac that
 * went to sleep), so the line under the task never has to repeat it.
 */
function attentionLead(agent: ClientAgent): string {
  const status = agent.task?.status;
  if (status === "host_offline") return "is waiting for your Mac";
  if (agent.state === "blocked") return status === "budget_exceeded" ? "ran out of usage" : "is blocked";
  return status === "waiting_approval" ? "needs your approval" : "asked";
}

/**
 * One thing waiting on you: the ask itself leads (the task, or the agent's
 * own words), with who asked, the nuance and when above it and the way in
 * beside it (under it on a narrow page, so the ask is never cut). The section
 * heading already says it needs you and the crew below shows the face, so the
 * card neither repeats "needs your answer" nor draws the face a second time.
 * A plain card on the neutral hairline: the needs-you ember is spent on the
 * face's ball and the button's words, never on a stripe.
 */
export function Attention({ agent, row = false }: { agent: ClientAgent; row?: boolean }) {
  if (row) return <AttentionRow agent={agent} />;
  const blocked = agent.state === "blocked";
  const sentence = localStateSentence(agent, agent.state);
  const where = agent.task?.title?.trim() || null;
  const when = agent.task ? formatAgo(agent.task.lastActivityAt) : null;
  const href = agent.task?.conversationId ? `/chat/${encodeURIComponent(agent.task.conversationId)}` : agentHref(agent);
  // Each fact once (AGENTS.md §4.3). The server's sentence is a template
  // round the task's title ("Has a question about <title>", "Blocked before
  // finishing <title>"), so under the title it only says it again; it shows
  // only when it is the agent's own words (a reason it gave).
  const generic = !sentence || /^waiting on you\.?$/i.test(sentence.trim()) || (where !== null && sentence.includes(where));
  return (
    <Link
      href={href}
      className={cn(
        "group/attn relative flex flex-col items-start gap-3 rounded-card border border-foreground/[0.08] bg-card py-3.5 pl-4 pr-4",
        "@[40rem]/page:flex-row @[40rem]/page:items-center @[40rem]/page:gap-4",
        "transition-[border-color,background-color,transform] duration-fast ease-out-soft hover:border-foreground/[0.14] hover:bg-accent/40 active:scale-[.995] motion-reduce:active:scale-100",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
      )}
    >
      <span className="w-full min-w-0 flex-1">
        <span className="block text-ui leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">{agent.name}</span>{" "}
          <span className={blocked ? "font-medium text-destructive-ink" : undefined}>{attentionLead(agent)}</span>
          {when ? <span className="whitespace-nowrap">{` · ${when}`}</span> : null}
        </span>
        <span className="mt-0.5 line-clamp-2 text-pretty text-body font-medium leading-6 text-foreground">{where ?? sentence}</span>
        {where && !generic ? <span className="mt-0.5 block text-pretty text-ui leading-5 text-muted-foreground">{sentence}</span> : null}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-control bg-foreground px-3 py-1.5 text-ui font-medium text-background transition-[gap] duration-fast ease-out-soft group-hover/attn:gap-2.5 motion-reduce:transition-none">
        {blocked ? "See what’s needed" : "Answer"}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </span>
    </Link>
  );
}

/**
 * The same ask as a row of Orbit's Needs you list: the agent's face, who asked
 * and when, the ask itself, and a chevron that leans toward the thread on
 * hover. The whole row is the way in, so there is no black button per row.
 */
function AttentionRow({ agent }: { agent: ClientAgent }) {
  const blocked = agent.state === "blocked";
  const sentence = localStateSentence(agent, agent.state);
  const where = agent.task?.title?.trim() || null;
  const when = agent.task ? formatAgo(agent.task.lastActivityAt) : null;
  const href = agent.task?.conversationId ? `/chat/${encodeURIComponent(agent.task.conversationId)}` : agentHref(agent);
  return (
    <Link
      href={href}
      className="orbit-row group/attn flex items-start gap-3 rounded-inner px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center">
        <AgentPresence avatar={agent.avatar} state={agent.state} size={28} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-caption leading-4 text-muted-foreground">
          <span className="font-medium text-foreground">{agent.name}</span>{" "}
          <span className={blocked ? "text-destructive-ink" : "text-status-needs-you-ink"}>{attentionLead(agent)}</span>
          {when ? ` · ${when}` : null}
        </span>
        <span className="mt-0.5 line-clamp-2 text-pretty text-ui font-medium leading-5 text-foreground">{where ?? sentence}</span>
      </span>
      <ChevronRight className="orbit-row__go mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}

/**
 * A plan without agents (Free, Lite): one calm card where the hire field
 * would be, never a field whose agent would then have every task refused
 * (src/lib/agents/plan-gate.ts). With agents already kept, hired before a
 * downgrade, it says they stay: they are listed above and readable.
 */
export function AgentsUpgrade({ gate, kept = false }: { gate: AgentHiringGate; kept?: boolean }) {
  const action = (
    <Button asChild>
      <Link href="/upgrade">See plans</Link>
    </Button>
  );
  if (kept) {
    return (
      <EmptyState
        size="panel"
        title={`New ${AGENT_NOUN.plural} are included from ${gate.neededPlanName}`}
        description={`You’re on ${gate.planName}. Your ${AGENT_NOUN.plural} are kept with everything they did, and starting new work needs ${gate.neededPlanName}.`}
        action={action}
      />
    );
  }
  return (
    <AppPage measure="reading">
      <EmptyState
        title={`${AGENT_NOUN.pluralLabel} are included from ${gate.neededPlanName}`}
        description={`You’re on ${gate.planName}. An ${AGENT_NOUN.singular} carries one kind of work forward: it remembers what it learned, works on a schedule if you want, and asks before sending, paying or deleting anything.`}
        action={action}
      />
    </AppPage>
  );
}

/**
 * No agents yet (V5): the face you are about to meet, one short question, the
 * chat composer with the machine it will work on, and four starters as small
 * cards (a glyph, two words, a cadence) that fill the field with the whole
 * sentence. The promise that it asks before anything risky is one line under
 * the field, not a paragraph.
 */
function FirstAgent() {
  const { user } = useApp();
  const firstName = user.name?.trim().split(/\s+/)[0];
  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4 pb-[10vh] pt-10">
      <div className="flex w-full max-w-2xl flex-col items-center">
        <HeroComposer
          team={[]}
          heading={
            <h1 className="text-balance text-center font-serif text-display font-normal tracking-[-0.03em] text-foreground [font-optical-sizing:auto]">
              {firstName ? `What should run on its own, ${firstName}?` : "What should run on its own?"}
            </h1>
          }
        />
      </div>
    </div>
  );
}

/** The starters: a glyph, two words and a cadence on the card; the full job goes in the field. */
const STARTERS = [
  { icon: Mail, title: "Inbox zero", cadence: "Every day", job: EXAMPLES[0] },
  { icon: Telescope, title: "Competitor brief", cadence: "Mondays", job: EXAMPLES[1] },
  { icon: Globe, title: "Fare watch", cadence: "On a change", job: EXAMPLES[2] },
  { icon: CalendarClock, title: "Week ahead", cadence: "Sundays", job: EXAMPLES[3] },
] as const;

/** A small, stable salt from a string (FNV-1a, mod 997): the same on the server and the client. */
function hashSalt(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 997;
}

/** Creates the agent from what was written and opens its thread, where it sets itself up in conversation. */
function useCreateAgent(team: readonly ClientAgent[], runsOn: RunsOn = { target: "cloud" }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [arrived, setArrived] = React.useState(false);
  // The salt picks the next face and name: from the person, so the server and
  // the browser draw the same one from the first painted frame (a random salt
  // drawn after hydration swapped one face for another as the page loaded),
  // and different people still meet different first agents.
  const userId = useOptionalApp()?.user.id ?? "";
  const salt = React.useMemo(() => hashSalt(userId), [userId]);
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
      const outcome = await hireAgent(newAgentInput({ text, name, avatar: face, creationKey: request.current.key, ...runsOnInput(runsOn) }));
      if (outcome.kind !== "ok") {
        setError(outcome.message);
        setBusy(false);
        return;
      }
      announceAgentsChanged();
      const href = agentHref(outcome.value);
      router.prefetch(href);
      setArrived(true);
      const reduce = prefersReducedMotion();
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
function DescribeAgent({
  team,
  autoFocus,
  hosts,
  fieldRef,
}: {
  team: readonly ClientAgent[];
  autoFocus: boolean;
  hosts: WorkHostsState;
  fieldRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const [value, setValue] = React.useState("");
  const [runsOn, setRunsOn] = React.useState<RunsOn>({ target: "cloud" });
  const { busy, error, name, create } = useCreateAgent(team, runsOn);
  const autosized = useAutosize(value, 200);
  const field = React.useCallback(
    (el: HTMLTextAreaElement | null) => {
      autosized.current = el;
      if (fieldRef) fieldRef.current = el;
    },
    [autosized, fieldRef],
  );
  return (
    <form
      aria-labelledby="orbit-new-agent"
      onSubmit={(event) => {
        event.preventDefault();
        void create(value);
      }}
    >
      <SectionLabel id="orbit-new-agent">{`New ${AGENT_NOUN.singular}`}</SectionLabel>
      {/* The chat composer itself, so starting an agent feels like starting
          a chat: same surface, radius, field and send disc. The machine it
          will work on sits where the chat keeps its context chips. */}
      <ComposerShell
        field={
          <textarea
            ref={field}
            value={value}
            rows={1}
            autoFocus={autoFocus}
            disabled={busy}
            maxLength={6000}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // Return on an on-screen keyboard breaks the line; the button sends (G35).
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !touchReturnBreaksLine(event)) {
                event.preventDefault();
                void create(value);
              }
              if (event.key === "Tab" && !value) {
                event.preventDefault();
                setValue(EXAMPLES[0]);
              }
            }}
            placeholder={EXAMPLES[0]}
            aria-label={`What should a new ${AGENT_NOUN.singular} take care of?`}
            className={composerFieldClass}
          />
        }
        leading={<RunsOnChip value={runsOn} onChange={setRunsOn} hosts={hosts} disabled={busy} />}
        action={<ComposerPrimaryAction face={busy ? "busy" : "send"} type="submit" disabled={busy || !value.trim()} aria-label={FEATURE_NAMES.createAgent.label} />}
        dimmed={busy}
      />
      <p className="mt-2 px-1 text-caption leading-4 text-muted-foreground" aria-live="polite">
        {error ? (
          <span role="alert" className="text-destructive-ink">
            {error}
          </span>
        ) : busy ? (
          `${name} is setting up…`
        ) : value.trim() ? (
          `${name} will take this on. It asks before sending, paying or deleting anything.`
        ) : (
          "It asks before sending, paying or deleting anything."
        )}
      </p>
    </form>
  );
}

/** The first agent's field: the Chat landing's twin, with the face you are about to meet. */
function HeroComposer({ team, heading }: { team: readonly ClientAgent[]; heading: React.ReactNode }) {
  const [value, setValue] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const [runsOn, setRunsOn] = React.useState<RunsOn>({ target: "cloud" });
  const { state: hosts } = useWorkHosts(true);
  const { busy, error, arrived, face, name, create } = useCreateAgent(team, runsOn);
  const field = useAutosize(value, 220);
  const state: AgentState = arrived ? "done" : busy ? "working" : value.trim() ? "listening" : "idle";
  return (
    <div className="flex w-full flex-col items-center">
      <div className="mb-6">
        <AgentPresence avatar={face} state={focused && !value ? "idle" : state} size={96} spread={0.6} name={name} gaze />
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
                // Return on an on-screen keyboard breaks the line; the button sends (G35).
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !touchReturnBreaksLine(event)) {
                  event.preventDefault();
                  void create(value);
                }
                if (event.key === "Tab" && !value) {
                  event.preventDefault();
                  setValue(EXAMPLES[0]);
                }
              }}
              placeholder={`Describe a job for ${name}`}
              aria-label={`Describe a job for your first ${AGENT_NOUN.singular}`}
              className={composerFieldClass}
            />
          }
          leading={<RunsOnChip value={runsOn} onChange={setRunsOn} hosts={hosts} disabled={busy} />}
          action={<ComposerPrimaryAction face={busy ? "busy" : "send"} type="submit" disabled={busy || !value.trim()} aria-label={FEATURE_NAMES.createAgent.label} />}
          dimmed={busy}
        />
      </form>
      <p className="mt-2.5 text-center text-caption text-muted-foreground" aria-live="polite">
        {error ? (
          <span role="alert" className="text-destructive-ink">
            {error}
          </span>
        ) : busy ? (
          `${name} is setting up…`
        ) : (
          "Asks before sending, paying or deleting anything."
        )}
      </p>
      {/* Starters: the blank page is the hardest part of a first agent. A
          card fills the field with the whole job and never sends. */}
      {!busy ? (
        <ul aria-label="Example jobs" className="mt-8 grid w-full grid-cols-2 gap-2 @[40rem]/page:grid-cols-4">
          {STARTERS.map((starter, index) => {
            const Icon = starter.icon;
            const chosen = value === starter.job;
            return (
              <li key={starter.title} className="orbit-card-in" style={{ "--i": index } as React.CSSProperties}>
                <button
                  type="button"
                  aria-pressed={chosen}
                  title={starter.job}
                  onClick={() => {
                    setValue(starter.job);
                    field.current?.focus();
                  }}
                  className={cn(
                    "orbit-starter group/starter flex h-full w-full flex-col items-start gap-3 rounded-card border bg-card px-3.5 pb-3 pt-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    chosen ? "border-foreground/30" : "border-foreground/[0.08]",
                  )}
                >
                  <Icon className="size-5 text-muted-foreground transition-colors duration-fast group-hover/starter:text-foreground" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block truncate text-ui font-medium leading-5 text-foreground">{starter.title}</span>
                    <span className="block truncate text-caption leading-4 text-muted-foreground">{starter.cadence}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function AgentsHomeSkeleton() {
  return (
    <AppPage measure="wide">
      <div role="status" aria-label={`Loading your ${AGENT_NOUN.plural}`}>
        <AppPageHeaderSkeleton headingWidth="w-32" />
        {/* The crew's shape: tiles of a face, a name and a role. */}
        <div className="grid max-w-3xl grid-cols-2 gap-x-2 gap-y-3 @[40rem]/page:grid-cols-4 @[40rem]/page:gap-x-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col items-center gap-2.5 pb-4 pt-5">
              <Skeleton className="size-[72px] rounded-full @[40rem]/page:size-[120px]" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </AppPage>
  );
}
