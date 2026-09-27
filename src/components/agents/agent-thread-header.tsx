"use client";

import * as React from "react";
import Link from "next/link";
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
import { Monitor, MoreHorizontal, PanelRight } from "@/components/ui/icons";
import { AgentFace } from "@/components/agents/agent-face";
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
 * The one row an agent's thread gains (docs/design/agents-v2/BRIEF.md §4.8.1):
 * face `sm` (live state) · name · state sentence · right side: Computer button
 * (when computer feature is available), Agent panel button, and overflow menu
 * with Pause/Resume, Pin, Duplicate and Retire.
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

  const sentence =
    state === "thinking"
      ? "Thinking"
      : localStateSentence(
          taskTitle ? { ...agent, task: agent.task ? { ...agent.task, title: taskTitle } : agent.task } : agent,
          state
        );

  const computerFeatureOn = agent.computer !== null;

  const handlePauseResume = async () => {
    const nextStatus = agent.status === "paused" ? "active" : "paused";
    const res = await updateAgent(agent.id, { status: nextStatus });
    if (res.kind === "failed") {
      toast.error(res.message);
      return;
    }
    toast.success(nextStatus === "paused" ? `Paused ${agent.name}.` : `Resumed ${agent.name}.`);
    announceAgentsChanged();
  };

  const handleTogglePin = async () => {
    const isPinned = Boolean(agent.pinnedAt);
    const res = await updateAgent(agent.id, { pinned: !isPinned });
    if (res.kind === "failed") {
      toast.error(res.message);
      return;
    }
    toast.success(!isPinned ? `Pinned ${agent.name}.` : `Unpinned ${agent.name}.`);
    announceAgentsChanged();
  };

  const handleDuplicate = async () => {
    const res = await duplicateAgent(agent.id);
    if (res.kind !== "ok") {
      toast.error(res.message);
      return;
    }
    toast.success(`Duplicated as ${res.value.name}.`);
    announceAgentsChanged();
    if (res.value.conversationId) {
      router.push(`/chat/${res.value.conversationId}`);
    }
  };

  const handleRetire = async () => {
    const res = await retireAgent(agent.id);
    if (res.kind === "failed") {
      toast.error(res.message);
      return;
    }
    toast.success(`Retired ${agent.name}.`);
    announceAgentsChanged();
    router.push("/agents");
  };

  return (
    <div className="flex h-12 shrink-0 items-center justify-center border-b border-border/70 px-4">
      <div className="flex w-full max-w-3xl items-center gap-2.5">
        <button
          ref={faceRef}
          type="button"
          onClick={() => onTogglePanel?.("now")}
          data-face-trigger
          className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${agent.name} panel`}
        >
          <AgentFace avatar={agent.avatar} state={state} size="sm" />
        </button>
        <button
          type="button"
          onClick={() => onTogglePanel?.("now")}
          className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-baseline gap-2">
            <span className="truncate text-ui font-medium text-foreground">{agent.name}</span>
            {agent.role ? (
              <span className="hidden truncate text-caption text-muted-foreground sm:inline">
                {agent.role}
              </span>
            ) : null}
          </div>
          <p className="truncate text-caption text-muted-foreground" aria-live="polite">
            {sentence}
          </p>
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {computerFeatureOn ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Computer"
              aria-pressed={activePanelTab === "computer"}
              onClick={() => onTogglePanel?.("computer")}
              className={cn(
                "text-muted-foreground hover:text-foreground",
                activePanelTab === "computer" && "bg-selected text-foreground"
              )}
            >
              <Monitor className="size-4" aria-hidden="true" />
            </Button>
          ) : null}

          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Agent panel"
            aria-pressed={activePanelTab === "now" || activePanelTab === "setup"}
            onClick={() => onTogglePanel?.("now")}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              (activePanelTab === "now" || activePanelTab === "setup") && "bg-selected text-foreground"
            )}
          >
            <PanelRight className="size-4" aria-hidden="true" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`${agent.name} actions`}
                className="text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void handlePauseResume()}>
                {agent.status === "paused" ? "Resume" : "Pause"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void handleTogglePin()}>
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

      <Dialog open={confirmRetire} onOpenChange={setConfirmRetire}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Retire {agent.name}?</DialogTitle>
            <DialogDescription>
              Retiring {agent.name} stops all of its routines and tasks and removes it from your roster.
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
              Retire {agent.name}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The empty thread greets in the agent's own voice (BRIEF.md §4.8.4):
 * "Hi, I'm <name>. Tell me what you'd like me to take on and I'll set myself up."
 * Plus 3 suggestion chips drawn from the template and a "Set up with a form" link.
 */
export function AgentGreeting({
  agent,
  onSelectSuggestion,
}: {
  agent: ClientAgent;
  onSelectSuggestion?: (text: string) => void;
}) {
  const suggestions = getTemplateSuggestions(agent.template);
  const templateObj = AGENT_TEMPLATES.find((t) => t.id === agent.template);
  const chips = React.useMemo(() => {
    if (templateObj && templateObj.firstGoal) {
      const rest = suggestions.filter((s) => s !== templateObj.firstGoal);
      return [templateObj.firstGoal, ...rest].slice(0, 3);
    }
    return suggestions.slice(0, 3);
  }, [suggestions, templateObj]);

  return (
    <div className="flex flex-col items-center text-center" data-face-trigger>
      <AgentFace
        avatar={agent.avatar}
        state={agent.status === "paused" ? "sleeping" : "idle"}
        size="lg"
        name={agent.name}
      />
      <h1 className="mt-5 font-serif text-display text-foreground">
        Hi, I’m <span className="italic">{agent.name}</span>.
      </h1>
      <p className="mt-2 max-w-md text-body text-muted-foreground">
        {agent.status === "paused"
          ? "I’m paused. Resume me from the menu above to start something new."
          : "Tell me what you’d like me to take on and I’ll set myself up."}
      </p>

      {agent.status !== "paused" ? (
        <div className="mt-6 flex max-w-lg flex-wrap justify-center gap-2">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              onClick={() => onSelectSuggestion?.(chip)}
              className="rounded-control border border-border bg-card px-3 py-1.5 text-left text-ui text-foreground transition-colors duration-fast ease-out-soft hover:bg-accent"
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}

      <p className="mt-4 text-caption text-muted-foreground">
        <Link
          href={agent.template ? `/agents/new?form=1&template=${encodeURIComponent(agent.template)}` : "/agents/new?form=1"}
          className="underline-offset-4 hover:text-foreground hover:underline"
        >
          Set up with a form
        </Link>
      </p>
    </div>
  );
}
