"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowRight, Monitor, MoreHorizontal, User } from "@/components/ui/icons";
import { AgentPresence } from "@/components/agents/agent-presence";
import { AgentFaceStudio } from "@/components/agents/agent-face-studio";
import { localStateSentence } from "@/components/agents/agent-bits";
import type { AgentPanelTab } from "@/components/agents/agent-panel";
import {
  announceAgentsChanged,
  duplicateAgent,
  retireAgent,
  updateAgent,
} from "@/components/agents/agents-transport";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { cn } from "@/lib/utils";

export { threadAgentState } from "@/components/agents/thread-agent-state";

const TEMPLATE_CHIPS: Record<string, readonly string[]> = {
  "chief-of-staff": [
    "Triage my inbox and flag what needs me today",
    "Check my calendar for tomorrow and prepare a morning brief",
    "Set up a weekday 8am routine to review my schedule",
  ],
  researcher: [
    "Track our top 3 competitors and brief me every Monday",
    "Research the latest papers on this topic with citations",
    "Summarise industry news for me every morning at 9am",
  ],
  "deal-finder": [
    "Watch prices on a product I want and alert me when it drops",
    "Compare the best options under my budget before I buy",
    "Check weekly for renewal or subscription savings",
  ],
  writer: [
    "Draft a weekly update in my voice from my recent notes",
    "Turn rough bullet points into a clear client memo",
    "Help me outline and edit an upcoming article",
  ],
  coach: [
    "Check in with me every evening on my top three priorities",
    "Review my week every Friday afternoon and spot patterns",
    "Keep a running log of my habits and milestones",
  ],
  analyst: [
    "Pull our key metrics and write a weekly summary",
    "Audit our spreadsheet data and flag anomalies",
    "Give yourself a computer so you can run Python scripts on CSVs",
  ],
  ops: [
    "Monitor our support queue and summarise urgent tickets",
    "Run a daily checklist and alert me only when something breaks",
    "Keep our team documentation organised and up to date",
  ],
  custom: [
    "Watch our competitors' pricing pages every Monday morning",
    "Check my inbox each morning and draft replies for my approval",
    "Give yourself a computer and help me automate browser tasks",
  ],
};

export function getTemplateSuggestions(templateId: string | null | undefined): readonly string[] {
  if (templateId && TEMPLATE_CHIPS[templateId]) {
    return TEMPLATE_CHIPS[templateId];
  }
  return TEMPLATE_CHIPS.custom;
}

/**
 * The agent's presence at the top of its thread (docs/design/agents-rework/
 * DIRECTION.md): face on its halo, name, and one live sentence. Computer (when it
 * has one) and Profile sit on the right; Pause, Pin, Duplicate and Retire are in
 * the menu. No labels, no badges: the face carries the state.
 */
export function AgentThreadHeader({
  agent,
  state,
  taskTitle,
  levelRef,
  activePanelTab,
  onTogglePanel,
}: {
  agent: ClientAgent;
  state: AgentState;
  taskTitle: string | null;
  levelRef?: React.RefObject<number>;
  activePanelTab?: AgentPanelTab | null;
  onTogglePanel?: (tab: AgentPanelTab) => void;
}) {
  const router = useRouter();
  const faceRef = React.useRef<HTMLButtonElement | null>(null);
  const listening = state === "listening" && !!levelRef;
  const [confirmRetire, setConfirmRetire] = React.useState(false);
  const [studio, setStudio] = React.useState(false);

  React.useEffect(() => {
    const face = faceRef.current;
    if (!listening || !levelRef || !face) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const tick = () => {
      face.style.setProperty("--level", levelRef.current.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      face.style.removeProperty("--level");
    };
  }, [listening, levelRef]);

  const usingComputer = agent.computer?.status === "awake" && (state === "working" || state === "waiting");
  const sentence =
    state === "thinking"
      ? "Thinking"
      : usingComputer && state === "working"
        ? "Using its computer"
        : localStateSentence(
            taskTitle ? { ...agent, task: agent.task ? { ...agent.task, title: taskTitle } : agent.task } : agent,
            state
          );
  const hasComputer = Boolean(agent.computer?.enabled);

  const run = async (label: string, action: () => Promise<{ kind: string; message?: string }>) => {
    const res = await action();
    if (res.kind === "failed") {
      toast.error(res.message ?? `Couldn’t ${label.toLowerCase()}.`);
      return false;
    }
    announceAgentsChanged();
    return true;
  };

  const handlePauseResume = async () => {
    const nextStatus = agent.status === "paused" ? "active" : "paused";
    if (await run(nextStatus === "paused" ? "Pause" : "Resume", () => updateAgent(agent.id, { status: nextStatus }))) {
      toast.success(nextStatus === "paused" ? `${agent.name} is paused.` : `${agent.name} is back.`);
    }
  };

  const handleDuplicate = async () => {
    const res = await duplicateAgent(agent.id);
    if (res.kind !== "ok") {
      toast.error(res.kind === "failed" ? res.message : "Couldn’t duplicate.");
      return;
    }
    announceAgentsChanged();
    if (res.value.conversationId) router.push(`/chat/${encodeURIComponent(res.value.conversationId)}`);
  };

  const handleRetire = async () => {
    if (await run("Retire", () => retireAgent(agent.id))) {
      toast.success(`${agent.name} is retired.`);
      router.push("/agents");
    }
  };

  return (
    <div className="relative isolate flex shrink-0 justify-center px-4 pb-1 pt-3">
      {/* The thread carries the agent's colour: a faint wash of its tone behind the header. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background: `radial-gradient(70% 140% at 50% -40%, hsl(var(--agent-${agent.avatar.tone}) / 0.13), transparent 70%)`,
        }}
      />
      <div className="flex w-full max-w-3xl items-center gap-3.5">
        <button
          ref={faceRef}
          type="button"
          onClick={() => onTogglePanel?.("profile")}
          data-face-trigger
          className="-m-1 flex min-w-0 flex-1 items-center gap-3.5 rounded-field p-1 text-left outline-none transition-colors duration-fast ease-out-soft focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${agent.name}, open profile`}
        >
          <AgentPresence avatar={agent.avatar} state={state} size={40} haloScale={1.7} gaze />
          <span className="min-w-0">
            <span className="block truncate text-body font-medium leading-tight text-foreground">{agent.name}</span>
            <span className="mt-0.5 block truncate text-ui text-muted-foreground" aria-live="polite">
              {sentence}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {hasComputer ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={`${agent.name}’s computer`}
              title="Computer"
              aria-pressed={activePanelTab === "computer"}
              onClick={() => onTogglePanel?.("computer")}
              className={cn(
                "text-muted-foreground hover:text-foreground",
                activePanelTab === "computer" && "bg-selected text-foreground"
              )}
            >
              <Monitor className="size-[1.125rem]" aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`${agent.name}’s profile`}
            title="Profile"
            aria-pressed={activePanelTab === "profile"}
            onClick={() => onTogglePanel?.("profile")}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              activePanelTab === "profile" && "bg-selected text-foreground"
            )}
          >
            <User className="size-[1.125rem]" aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`More for ${agent.name}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="size-[1.125rem]" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setStudio(true)}>Customize</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handlePauseResume()}>
                {agent.status === "paused" ? "Resume" : "Pause"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void run("Pin", () => updateAgent(agent.id, { pinned: !agent.pinnedAt }))
                }
              >
                {agent.pinnedAt ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleDuplicate()}>Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setConfirmRetire(true)}
              >
                Retire
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AgentFaceStudio agent={agent} open={studio} onOpenChange={setStudio} />

      <Dialog open={confirmRetire} onOpenChange={setConfirmRetire}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retire {agent.name}?</DialogTitle>
            <DialogDescription>
              Its routines stop and it leaves your agents. This conversation stays in your history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmRetire(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmRetire(false);
                void handleRetire();
              }}
            >
              Retire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * An empty thread greets in the agent's own voice. A brand new agent has no job
 * yet: the first message sets it up (docs/design/agents-rework/DIRECTION.md).
 */
export function AgentGreeting({
  agent,
  onSelectSuggestion,
}: {
  agent: ClientAgent;
  onSelectSuggestion?: (text: string) => void;
}) {
  const suggestions = React.useMemo(() => {
    const template = AGENT_TEMPLATES.find((t) => t.id === agent.template);
    const pool = getTemplateSuggestions(agent.template);
    const first = template?.firstGoal ? [template.firstGoal] : [];
    return [...first, ...pool.filter((s) => s !== template?.firstGoal)].slice(0, 3);
  }, [agent.template]);
  const fresh = !agent.role.trim() && !agent.instructions.trim();
  const paused = agent.status === "paused";

  return (
    <div className="flex w-full max-w-xl flex-col items-center text-center" data-face-trigger>
      <span className="motion-safe:animate-agent-arrive">
        <AgentPresence avatar={agent.avatar} state={paused ? "sleeping" : "idle"} size={88} haloScale={2.2} name={agent.name} gaze />
      </span>
      <h1 className="mt-8 font-serif text-display italic leading-[1.1] text-foreground">
        {fresh ? "Hi. What should I take care of?" : `Hi, I’m ${agent.name}.`}
      </h1>
      <p className="mt-3 max-w-md text-body-lg text-muted-foreground">
        {paused
          ? "I’m paused. Resume me from the menu to pick up where I left off."
          : fresh
            ? "Tell me the job. I’ll name myself and set myself up."
            : agent.role.trim()
              ? `${agent.role.trim()}. What should I take on next?`
              : "What should I take on next?"}
      </p>

      {!paused ? (
        <ul className="mt-8 w-full space-y-1 text-left">
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                onClick={() => onSelectSuggestion?.(suggestion)}
                className="group flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left text-body text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
              >
                <ArrowRight
                  className="size-4 shrink-0 opacity-60 transition-transform duration-fast ease-out-soft group-hover:translate-x-0.5 group-hover:opacity-100"
                  aria-hidden="true"
                />
                <span>{suggestion}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
