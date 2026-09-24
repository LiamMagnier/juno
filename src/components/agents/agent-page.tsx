"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { AppPage } from "@/components/app/app-page";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { WORK_APPROVAL_MODE_LABEL } from "@/lib/work/domain";
import { AGENT_STATE_LABEL } from "@/lib/agents/domain";
import type { ClientAgentDetail } from "@/lib/agents/types";
import { cn } from "@/lib/utils";
import { duration, spring } from "@/lib/motion";
import { AgentFace } from "@/components/agents/agent-face";
import { localStateSentence } from "@/components/agents/agent-bits";
import { useAgentDetail } from "@/components/agents/use-agents";
import { announceAgentsChanged, openAgentThread, reflect, updateAgent } from "@/components/agents/agents-transport";
import { AgentNow } from "@/components/agents/agent-now";
import { AgentGoals } from "@/components/agents/agent-goals";
import { AgentRoutines } from "@/components/agents/agent-routines";
import { AgentActivity } from "@/components/agents/agent-activity";
import { AgentProfile } from "@/components/agents/agent-profile";

type Tab = "now" | "goals" | "routines" | "activity" | "profile";
const TABS: readonly Tab[] = ["now", "goals", "routines", "activity", "profile"];

/**
 * The hire arrival (AGENTS.md §5.1, §4.3): the new face lands at `xl` on the
 * spring — `done`'s one-shot settle, on the emphasis rung — says hello with its
 * happy eyes, opens them (`idle`), and settles into the header at `lg`. Each
 * step holds for what it shows; the last is the layout spring's own length, so
 * the page stops measuring itself the moment the face is home.
 */
type Arrival = "landing" | "greeting" | "settling";
const ARRIVAL_NEXT: Record<Arrival, Arrival | null> = { landing: "greeting", greeting: "settling", settling: null };
const ARRIVAL_HOLD_MS: Record<Arrival, number> = {
  landing: duration.emphasis * 1000 + 640,
  greeting: 600,
  settling: duration.slow * 1000 + 120,
};

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia?.(REDUCED_MOTION);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/**
 * Whether the reader asked for less motion. False while the server renders and
 * hydrates (it cannot know), and correct from the first frame of a page opened
 * in the client — which the page after Hire always is.
 */
function useReducedMotionPreference(): boolean {
  return React.useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia?.(REDUCED_MOTION).matches ?? false,
    () => false
  );
}

/**
 * An agent's page (docs/design/AGENTS.md §5.2): the one place that answers
 * "what is it doing, and does it need me?".
 *
 * The header is the face at size with its live state and the sentence that
 * says it in words, and ONE primary action — Message — because talking to it
 * is how almost everything starts. Pause sits beside it; everything rarer is
 * in the overflow. Grok's design team ended their project by taking controls
 * away; this header is written to that standard.
 *
 * On open it asks the agent to reflect, which the server answers as a no-op
 * unless six hours have passed — so a proactive agent has fresh ideas when a
 * person looks, and looking often costs nothing.
 */
export function AgentPage({ initial }: { initial: ClientAgentDetail }) {
  const router = useRouter();
  const params = useSearchParams();
  const hired = params?.get("hired") === "1";
  const { detail, missing, refresh } = useAgentDetail(initial.agent.id, initial);
  const [tab, setTab] = React.useState<Tab>(() => {
    const requested = params?.get("tab");
    return TABS.includes(requested as Tab) ? (requested as Tab) : "now";
  });
  const [activityKey, setActivityKey] = React.useState(0);
  const [opening, setOpening] = React.useState(false);
  const [welcome, setWelcome] = React.useState(hired);
  // Reduced motion has no arrival at all: no spring to land on, and a face
  // that later jumped from 160 to 96 would move the whole page for nothing.
  const reduceMotion = useReducedMotionPreference();
  const [arrivalStep, setArrivalStep] = React.useState<Arrival | null>(hired ? "landing" : null);
  const arrival = reduceMotion ? null : arrivalStep;
  React.useEffect(() => {
    if (!arrival) return;
    const timer = window.setTimeout(() => setArrivalStep(ARRIVAL_NEXT[arrival]), ARRIVAL_HOLD_MS[arrival]);
    return () => window.clearTimeout(timer);
  }, [arrival]);

  const agentId = initial.agent.id;
  React.useEffect(() => {
    void reflect(agentId).then((outcome) => {
      if (outcome.kind === "ok" && outcome.value.kind === "reflected") refresh();
    });
  }, [agentId, refresh]);

  if (missing || !detail) {
    return (
      <AppPage measure="wide">
        <EmptyState
          icon={AppIcons.agents}
          title="This agent is no longer here"
          description="It may have been retired. Its thread and tasks are still in your chats."
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/agents">All agents</Link>
            </Button>
          }
        />
      </AppPage>
    );
  }

  const { agent } = detail;
  const changed = () => {
    refresh();
    setActivityKey((key) => key + 1);
  };

  const message = async () => {
    if (agent.conversationId) {
      router.push(`/chat/${agent.conversationId}`);
      return;
    }
    setOpening(true);
    const outcome = await openAgentThread(agent.id);
    setOpening(false);
    if (outcome.kind !== "ok" || !outcome.value) {
      toast.error(outcome.kind === "failed" ? outcome.message : "Its thread could not be opened.");
      return;
    }
    router.push(`/chat/${outcome.value}`);
  };

  const togglePause = async () => {
    const next = agent.status === "paused" ? "active" : "paused";
    const outcome = await updateAgent(agent.id, { status: next });
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That did not work.");
      return;
    }
    toast.success(next === "paused" ? `${agent.name} is paused. Its routines are off until you resume it.` : `${agent.name} is back.`);
    announceAgentsChanged();
    changed();
  };

  const thinkItOver = async () => {
    const outcome = await reflect(agent.id, true);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That did not work.");
      return;
    }
    const result = outcome.value;
    if (result.kind === "reflected") {
      toast.success(result.ideas ? `${agent.name} has ${result.ideas} new ${result.ideas === 1 ? "idea" : "ideas"}.` : `${agent.name} looked things over. Nothing new to suggest.`);
    } else {
      toast.message(
        result.reason === "paused"
          ? `${agent.name} is paused.`
          : result.reason === "no_answer"
            ? "It could not think that over just now. Try again in a moment."
            : "It thought things over a moment ago."
      );
    }
    changed();
  };

  const sentence = localStateSentence(agent);
  // While the face settles, what sits beside and below it moves with it on the
  // same spring — transforms only (framer's layout projection) — rather than
  // jumping 64px when the face shrinks.
  const settles = arrival !== null;
  const follows = settles ? ("position" as const) : false;

  return (
    <AppPage measure="wide">
      {/* The hairline under the header is the top of what follows, so it moves
          with the content when the arriving face settles. */}
      <header className="pb-5">
        <div className="mb-3">
          <Link href="/agents" className="text-ui text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Agents
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-4">
          <motion.div layout={settles} transition={spring.layout} data-face-trigger className="shrink-0">
            <AgentFace
              avatar={agent.avatar}
              state={arrival === "landing" ? "done" : arrival ? "idle" : agent.state}
              labelState={agent.state}
              size={arrival === "landing" || arrival === "greeting" ? "xl" : "lg"}
              name={agent.name}
            />
          </motion.div>
          <motion.div layout={follows} transition={spring.layout} className="min-w-0 flex-1">
            <h1 className="truncate text-page-title">{agent.name}</h1>
            {agent.role ? <p className="text-body text-muted-foreground">{agent.role}</p> : null}
            <p className={cn("mt-2 flex items-center gap-2 text-ui", agent.state === "waiting" ? "text-foreground" : "text-muted-foreground")}>
              <span className="font-mono text-caption">{AGENT_STATE_LABEL[agent.state]}</span>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate" aria-live="polite">
                {sentence}
              </span>
            </p>
          </motion.div>
          <motion.div layout={follows} transition={spring.layout} className="flex items-center gap-2">
            <Button onClick={() => void message()} loading={opening}>
              Message
            </Button>
            <Button variant="secondary" onClick={() => void togglePause()}>
              {agent.status === "paused" ? "Resume" : "Pause"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton label={`More for ${agent.name}`} variant="ghost">
                  <ActionIcons.more className="size-4" aria-hidden="true" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void thinkItOver()} disabled={agent.status !== "active"}>
                  Think it over now
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setTab("profile")}>Edit profile</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setTab("profile")} className="text-destructive">
                  Retire…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </motion.div>
        </div>
      </header>

      <motion.div layout={follows} transition={spring.layout} className="border-t border-border pt-6">
        {welcome ? (
          <div className="mb-6 flex flex-wrap items-center gap-4 rounded-card border border-border bg-card p-4 motion-safe:animate-rise-in">
            <p className="min-w-0 flex-1 text-body">
              <span className="font-medium text-foreground">{agent.name} is here.</span>{" "}
              <span className="text-muted-foreground">
                Tell it what to take on first. It works under “{WORK_APPROVAL_MODE_LABEL[agent.approvalMode]}”, and always
                asks before anything it cannot take back.
              </span>
            </p>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void message()}>
                Message {agent.name}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setWelcome(false)}>
                Later
              </Button>
            </div>
          </div>
        ) : null}

        <SegmentedControl
          ariaLabel={`${agent.name}'s page`}
          value={tab}
          onChange={setTab}
          className="mb-6"
          options={[
            { value: "now", label: "Now", badge: agent.needsYou > 0 ? agent.needsYou : undefined },
            { value: "goals", label: "Goals", count: detail.goals.filter((goal) => goal.status === "active").length || undefined },
            { value: "routines", label: "Routines", count: detail.routines.length || undefined },
            { value: "activity", label: "Activity" },
            { value: "profile", label: "Profile" },
          ]}
        />

        <div key={tab} className="motion-safe:animate-fade-in">
          {tab === "now" ? <AgentNow detail={detail} onChanged={changed} /> : null}
          {tab === "goals" ? (
            <AgentGoals detail={detail} onChanged={changed} onStarted={() => { changed(); setTab("now"); }} />
          ) : null}
          {tab === "routines" ? <AgentRoutines detail={detail} onChanged={changed} /> : null}
          {tab === "activity" ? <AgentActivity agentId={agent.id} refreshKey={activityKey} /> : null}
          {/* Not keyed on `updatedAt`: a reflection claiming its slot bumps it too,
              and a key would throw away an edit the person is half way through. */}
          {tab === "profile" ? <AgentProfile detail={detail} onChanged={changed} /> : null}
        </div>
      </motion.div>
    </AppPage>
  );
}
