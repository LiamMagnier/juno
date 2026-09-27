"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUp, ArrowRight, Hand } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { AppPage } from "@/components/app/app-page";
import type { ClientAgent } from "@/lib/agents/types";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AgentPresence } from "@/components/agents/agent-presence";
import { localStateSentence } from "@/components/agents/agent-bits";
import { announceAgentsChanged, hireAgent } from "@/components/agents/agents-transport";
import { useAgents } from "@/components/agents/use-agents";

/**
 * Agents home (docs/design/agents-rework/DIRECTION.md): one sentence field. Sending
 * it creates a blank agent, opens its thread and delivers the sentence as the first
 * message; the agent names itself and sets itself up with its own tools. There is
 * no hiring step and no form.
 */
export const AGENT_HOME_SUGGESTIONS: readonly string[] = [
  "Keep my inbox at zero and draft the replies I should send",
  "Watch flights to Tokyo in March and tell me when fares drop",
  "Every Monday, brief me on what my competitors shipped",
];

const RANK: Record<string, number> = {
  waiting: 0,
  working: 1,
  thinking: 1,
  done: 2,
  blocked: 2,
  idle: 3,
  sleeping: 4,
};

export function sortRosterAgents(agents: readonly ClientAgent[]): ClientAgent[] {
  return [...agents].sort((a, b) => {
    const aPinned = a.pinnedAt ? 1 : 0;
    const bPinned = b.pinnedAt ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || a.sortOrder - b.sortOrder;
  });
}

/** Where a new agent's first message is delivered: its own thread, sent on arrival. */
export function agentFirstMessageHref(conversationId: string, message: string): string {
  return `/chat/${encodeURIComponent(conversationId)}?q=${encodeURIComponent(message)}`;
}

export function AgentsHome({ initialAgents }: { initialAgents?: ClientAgent[] } = {}) {
  const { agents: fetchedAgents, error, refresh } = useAgents({ enabled: !initialAgents });
  const agents = initialAgents ?? fetchedAgents;
  const ordered = React.useMemo(() => (agents ? sortRosterAgents(agents) : null), [agents]);

  return (
    <AppPage measure="wide">
      <div className="mx-auto w-full max-w-3xl pt-6 @[48rem]/page:pt-14">
        <AgentComposer />
      </div>

      <section aria-labelledby="your-agents" className="mx-auto mt-16 w-full max-w-3xl pb-16">
        {error && !agents ? (
          <LoadError title="Couldn’t load your agents" description={error} onRetry={refresh} />
        ) : ordered === null ? (
          <>
            <h2 id="your-agents" className="mb-5 text-ui font-medium text-muted-foreground">
              Your agents
            </h2>
            <div className="grid grid-cols-1 gap-3 @[36rem]/page:grid-cols-2" role="status" aria-label="Loading agents">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-4 rounded-panel bg-card p-5 ring-1 ring-border/60">
                  <Skeleton className="size-14 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-40" />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : ordered.length > 0 ? (
          <>
            <h2 id="your-agents" className="mb-5 text-ui font-medium text-muted-foreground">
              Your agents
            </h2>
            <ul className="grid grid-cols-1 gap-3 @[36rem]/page:grid-cols-2">
              {ordered.map((agent, index) => (
                <li
                  key={agent.id}
                  style={staggerDelay(index, "tight")}
                  className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                >
                  <AgentTile agent={agent} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <h2 id="your-agents" className="sr-only">
            Your agents
          </h2>
        )}
      </section>
    </AppPage>
  );
}

function AgentTile({ agent }: { agent: ClientAgent }) {
  const needsYou = agent.state === "waiting" || agent.needsYou > 0;
  const sentence = localStateSentence(agent, agent.state);
  const href = agent.conversationId
    ? `/chat/${encodeURIComponent(agent.conversationId)}`
    : `/agents/${encodeURIComponent(agent.id)}`;
  return (
    <Link
      href={href}
      data-face-trigger
      className={cn(
        "group flex h-full items-center gap-4 rounded-panel bg-card p-5 ring-1 ring-border/60",
        "transition-[transform,box-shadow] duration-base ease-out-soft hover:-translate-y-0.5 hover:shadow-soft hover:ring-border",
        "active:translate-y-0 active:scale-[0.99] motion-reduce:transform-none"
      )}
    >
      <AgentPresence avatar={agent.avatar} state={agent.state} size={56} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body-lg font-medium text-foreground">{agent.name}</span>
        {needsYou ? (
          <span className="mt-0.5 flex items-center gap-1.5 text-ui font-medium text-primary">
            <Hand className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">Needs you</span>
          </span>
        ) : (
          <span className="mt-0.5 block truncate text-ui text-muted-foreground">{sentence}</span>
        )}
      </span>
    </Link>
  );
}

/** The one field the page is about. Enter sends; Shift+Enter is a new line. */
export function AgentComposer({ autoFocus = true }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  const fit = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);
  React.useLayoutEffect(fit, [value, fit]);
  // Measured again when the width settles: at mount the field can be laid out
  // before its column has its final width, which reads as a tall empty box.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  const submit = async () => {
    const message = value.trim();
    if (!message || busy) return;
    setBusy(true);
    const outcome = await hireAgent({ name: "New agent" });
    if (outcome.kind !== "ok") {
      setBusy(false);
      toast.error(outcome.kind === "failed" ? outcome.message : "Couldn’t start an agent. Try again.");
      return;
    }
    announceAgentsChanged();
    const conversationId = outcome.value.conversationId;
    router.push(
      conversationId ? agentFirstMessageHref(conversationId, message) : `/agents/${encodeURIComponent(outcome.value.id)}`
    );
  };

  return (
    <div className="motion-safe:animate-rise-in">
      <h1 className="font-serif text-display italic leading-[1.1] text-foreground">
        Who should take care of it?
      </h1>
      <form
        className={cn(
          "mt-8 flex items-end gap-3 rounded-stage bg-card p-3 pl-5 ring-1 ring-border/70 shadow-soft",
          "transition-shadow duration-base ease-out-soft focus-within:ring-foreground/25"
        )}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="agent-job" className="sr-only">
          Describe a job
        </label>
        <textarea
          id="agent-job"
          ref={ref}
          rows={1}
          value={value}
          autoFocus={autoFocus}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Describe a job. An agent will set itself up."
          className="min-h-[2.75rem] flex-1 resize-none bg-transparent py-2.5 text-body-lg text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          disabled={!value.trim() || busy}
          aria-label="Start"
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground",
            "transition-[transform,opacity] duration-fast ease-out-soft active:scale-95",
            "disabled:opacity-35"
          )}
        >
          <ArrowUp className="size-5" aria-hidden="true" />
        </button>
      </form>
      <ul className="mt-5 space-y-1">
        {AGENT_HOME_SUGGESTIONS.map((suggestion, index) => (
          <li key={suggestion} style={staggerDelay(index + 1)} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]">
            <button
              type="button"
              onClick={() => {
                setValue(suggestion);
                ref.current?.focus();
              }}
              className="group flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left text-body text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
            >
              <ArrowRight className="size-4 shrink-0 opacity-60 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden="true" />
              <span>{suggestion}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
