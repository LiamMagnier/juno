"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, JunoOrbit, Plus, Search, X } from "@/components/ui/icons";
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
import { AGENT_NOUN, BRAND, FEATURE_NAMES } from "@/lib/brand/names";
import { prefersReducedMotion } from "@/lib/motion-preference";
import { staggerDelay } from "@/lib/motion";
import { touchReturnBreaksLine } from "@/lib/touch-keyboard";
import { agentIsWorking, filterRoster, type RosterFilter } from "@/lib/agents/roster-view";
import { OrbitCapabilities } from "./orbit-capabilities";

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
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<RosterFilter>("all");
  const [starter, setStarter] = React.useState<{ text: string } | null>(null);
  const composerSection = React.useRef<HTMLElement>(null);
  const focusNewAgent = () => {
    composerSection.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "instant" : "smooth", block: "center" });
    composerSection.current?.querySelector("textarea")?.focus({ preventScroll: true });
  };
  const chooseStarter = (text: string) => {
    setStarter({ text });
    focusNewAgent();
  };

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
  const working = ordered.filter(agentIsWorking).length;
  const visible = filterRoster(ordered, query, filter);
  const filters: { value: RosterFilter; label: string; count: number }[] = [
    { value: "all", label: "All agents", count: ordered.length },
    { value: "working", label: "Working", count: working },
    { value: "attention", label: "Needs you", count: attention.length },
    { value: "paused", label: "Paused", count: ordered.filter((a) => a.status === "paused").length },
  ];

  return (
    <AppPage measure="wide" className="orbit-workspace">
      <div className="orbit-masthead"><JunoOrbit className="size-4" aria-hidden="true" /><span>Your autonomous workspace</span></div>
      <AppPageHeader
        heading={BRAND.orbit.label}
        lede="A capable crew. A clearer day."
        className={cn(TITLE_FINISH, "orbit-heading")}
        actions={<>{canHire ? <Button type="button" onClick={focusNewAgent}><Plus className="size-4" aria-hidden="true" />New agent</Button> : null}<Button variant="outline" asChild><Link href="/connections">Connections<ArrowRight className="size-3.5" aria-hidden="true" /></Link></Button></>}
      />

      {attention.length > 0 ? (
        <section aria-labelledby="orbit-needs-you" className="orbit-attention">
          <h2 id="orbit-needs-you" className="mb-3 flex items-center gap-2 text-ui font-medium text-foreground">
            {FEATURE_NAMES.needsYou.label}
            {/* A count only when there is more than one card to count. */}
            {attention.length > 1 ? (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-signal-wash px-1.5 font-mono text-caption tabular-nums text-status-needs-you-ink">
                {attention.length}
              </span>
            ) : null}
          </h2>
          <ul className="grid gap-3 @[40rem]/page:grid-cols-2">
            {attention.map((agent, index) => (
              <li key={agent.id} className={RISE} style={stagger(1 + index)}>
                <Attention agent={agent} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The crew: one tile per agent, its live face, who it is and what it
          is doing (orbit-stage.tsx). The list a keyboard and a screen reader
          use; it is named aloud, and on screen only under the cards. */}
      <section aria-labelledby="orbit-crew" className="mt-9">
        <div className="orbit-section-heading">
          <div><h2 id="orbit-crew">Your crew</h2><p>{working ? `${working} ${working === 1 ? "agent is" : "agents are"} moving work forward.` : "Ready when you are."}</p></div>
          <div className="orbit-search"><Search className="size-4 shrink-0" aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search agents" placeholder="Find an agent or task…" />{query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear agent search"><X className="size-3.5" /></button> : null}</div>
        </div>
        <div className="orbit-filters" aria-label="Filter agents">
          {filters.map(({ value, label, count }) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>)}
        </div>
        <p className="sr-only" role="status">{visible.length} {visible.length === 1 ? "agent" : "agents"} shown</p>
        {visible.length ? <OrbitCrew agents={visible} asked={asked} hrefOf={agentHref} onChanged={refresh} /> : <div className="orbit-no-results"><Search className="size-5 text-muted-foreground" aria-hidden="true" /><p>No agents match this view.</p><Button type="button" variant="link" onClick={() => { setQuery(""); setFilter("all"); }}>Show all agents</Button></div>}
      </section>

      <section ref={composerSection} aria-label={`New ${AGENT_NOUN.singular}`} className={cn("orbit-new-agent mt-7", RISE)} style={stagger(Math.min(ordered.length, 6) + 3)}>
        {canHire || !hiring ? <DescribeAgent team={ordered} autoFocus={focusComposer} starter={starter} /> : <AgentsUpgrade gate={hiring} kept />}
      </section>
      {canHire ? <OrbitCapabilities onChoose={chooseStarter} /> : null}
    </AppPage>
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
export function Attention({ agent }: { agent: ClientAgent }) {
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
        "orbit-attention-card group/attn relative flex h-full flex-col items-start gap-3 rounded-card border border-foreground/[0.08] bg-card p-4",
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
      <span className="mt-auto inline-flex shrink-0 items-center gap-1.5 text-ui font-medium text-foreground transition-[gap] duration-fast ease-out-soft group-hover/attn:gap-2.5 motion-reduce:transition-none">
        {blocked ? "See what’s needed" : "Answer"}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </span>
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

/** No agents yet: a face, a question, and the same field. */
function FirstAgent() {
  const { user } = useApp();
  const [starter, setStarter] = React.useState<{ text: string } | null>(null);
  const firstName = user.name?.trim().split(/\s+/)[0];
  return (
    <div className="orbit-workspace orbit-first flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5 pb-12 pt-12">
      <div className="flex w-full max-w-2xl shrink-0 flex-col items-center">
        <div className="orbit-masthead mb-7"><JunoOrbit className="size-4" aria-hidden="true" /><span>Meet your next advantage</span></div>
        <HeroComposer
          team={[]}
          starter={starter}
          heading={
            <h1 className="text-balance text-center font-serif text-display font-normal tracking-[-0.03em] text-foreground [font-optical-sizing:auto]">
              {`A little more space${firstName ? `, ${firstName}` : ""}.`}<br /><span className="text-muted-foreground">A lot more possible.</span>
            </h1>
          }
        />
        <p className="mt-6 max-w-[52ch] text-center text-ui text-muted-foreground">
          {`An ${AGENT_NOUN.singular} carries one kind of work forward: it remembers what it learned, works on a schedule if you want, and asks before sending, paying or deleting anything.`}
        </p>
      </div>
      <div className="mt-12 w-full max-w-5xl shrink-0"><OrbitCapabilities onChoose={(text) => setStarter({ text })} /></div>
    </div>
  );
}

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
function useCreateAgent(team: readonly ClientAgent[]) {
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
      const reduce = prefersReducedMotion();
      window.setTimeout(() => router.push(href), reduce ? 0 : 220);
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
function DescribeAgent({ team, autoFocus, starter }: { team: readonly ClientAgent[]; autoFocus: boolean; starter: { text: string } | null }) {
  const [value, setValue] = React.useState("");
  const { busy, error, name, create } = useCreateAgent(team);
  const field = useAutosize(value, 200);
  const id = React.useId();
  React.useEffect(() => {
    if (!starter) return;
    setValue(starter.text);
    field.current?.focus({ preventScroll: true });
  }, [starter, field]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void create(value);
      }}
      className="orbit-create-form rounded-panel border border-foreground/[0.1] bg-card p-3 transition-[border-color,box-shadow] duration-fast ease-out-soft focus-within:border-foreground/[0.2] kbd-focus-within:border-[hsl(var(--ring)/0.55)] kbd-focus-within:shadow-[0_0_0_1px_hsl(var(--ring)/0.55)]"
    >
      <div className="px-2.5 pt-2.5">
        <label htmlFor={id} className="block text-ui font-medium text-foreground">
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
            // Return on an on-screen keyboard breaks the line; the button sends (G35).
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !touchReturnBreaksLine(event)) {
              event.preventDefault();
              void create(value);
            }
          }}
          placeholder={EXAMPLES[0]}
          className="mt-1 block min-h-6 w-full resize-none bg-transparent text-body leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-70"
        />
      </div>
      <div className="mt-3 flex flex-col items-stretch gap-2.5 @[40rem]/page:flex-row @[40rem]/page:items-center @[40rem]/page:justify-between">
        <p className="px-2.5 text-caption leading-4 text-muted-foreground" aria-live="polite">
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
        <Button type="submit" disabled={busy || !value.trim()} loading={busy} className="shrink-0 px-3.5 disabled:opacity-40">
          {FEATURE_NAMES.createAgent.label}
        </Button>
      </div>
    </form>
  );
}

/** The first agent's field: the Chat landing's twin, with the face you are about to meet. */
function HeroComposer({ team, heading, starter }: { team: readonly ClientAgent[]; heading: React.ReactNode; starter: { text: string } | null }) {
  const [value, setValue] = React.useState("");
  const [focused, setFocused] = React.useState(false);
  const { busy, error, arrived, face, name, create } = useCreateAgent(team);
  const field = useAutosize(value, 220);
  React.useEffect(() => {
    if (!starter) return;
    setValue(starter.text);
    field.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "instant" : "smooth", block: "center" });
    field.current?.focus({ preventScroll: true });
  }, [starter, field]);
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
                // Return on an on-screen keyboard breaks the line; the button sends (G35).
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !touchReturnBreaksLine(event)) {
                  event.preventDefault();
                  void create(value);
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
      {/* Jobs other people hand off, one tap from the field: the blank page
          is the hardest part of a first agent. They fill, never send. */}
      {!value && !busy ? (
        <ul aria-label="Example jobs" className="mt-5 flex flex-wrap justify-center gap-2">
          {EXAMPLES.slice(1).map((example, index) => (
            <li key={example} className="[animation-fill-mode:backwards] motion-safe:animate-rise-in" style={staggerDelay(index, "tight", 120)}>
              <button
                type="button"
                onClick={() => {
                  setValue(example);
                  field.current?.focus();
                }}
                className="pressable rounded-full border border-border bg-card px-3.5 py-1.5 text-ui text-muted-foreground hover:border-foreground/20 hover:bg-accent hover:text-foreground motion-reduce:active:scale-100"
              >
                {example}
              </button>
            </li>
          ))}
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
