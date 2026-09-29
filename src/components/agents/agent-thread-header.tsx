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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Hand, Monitor, MoreHorizontal, PanelRight } from "@/components/ui/icons";
import { AgentPresence, AgentStatusLine } from "@/components/agents/agent-presence";
import { localStateSentence } from "@/components/agents/agent-bits";
import type { AgentPanelTab } from "@/components/agents/agent-panel";
import {
  announceAgentsChanged,
  duplicateAgent,
  retireAgent,
  updateAgent,
} from "@/components/agents/agents-transport";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import { cn } from "@/lib/utils";

export { threadAgentState } from "@/components/agents/thread-agent-state";

/**
 * The presence bar an agent's thread gains: its live face on its halo, its
 * name and the one sentence it is living right now, over a faint wash of its
 * own colour. Pressing the face opens the profile. Right side: its computer
 * (when it has one), the profile, and Pause, Pin, Duplicate, Retire.
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

  const computerFeatureOn = agent.computer != null;

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

  const attention = state === "waiting" || state === "blocked" || agent.needsYou > 0;
  const profileOpen = activePanelTab === "profile";

  return (
    <div
      className="agent-thread-bar flex shrink-0 justify-center px-4 py-2.5"
      style={{ "--bar-tone": `var(--agent-${agent.avatar.tone})` } as React.CSSProperties}
    >
      <div className="flex w-full max-w-3xl items-center gap-3">
        <button
          ref={faceRef}
          type="button"
          onClick={() => onTogglePanel?.("profile")}
          data-face-trigger
          className="flex min-w-0 flex-1 items-center gap-3 rounded-control py-0.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${agent.name}. ${sentence}. Open profile`}
          aria-expanded={profileOpen}
        >
          <AgentPresence avatar={agent.avatar} state={state} size={34} spread={0.4} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui font-medium text-foreground">{agent.name}</span>
            {attention ? (
              <span className="flex items-center gap-1 text-caption font-medium text-primary">
                <Hand className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{sentence}</span>
              </span>
            ) : (
              <AgentStatusLine text={sentence} state={state} className="text-caption text-muted-foreground" />
            )}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {computerFeatureOn ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${agent.name}’s computer`}
                  aria-pressed={activePanelTab === "computer"}
                  onClick={() => onTogglePanel?.("computer")}
                  className={cn("text-muted-foreground hover:text-foreground", activePanelTab === "computer" && "bg-selected text-foreground")}
                >
                  <Monitor className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Computer</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Profile"
                aria-pressed={profileOpen}
                onClick={() => onTogglePanel?.("profile")}
                className={cn("text-muted-foreground hover:text-foreground", profileOpen && "bg-selected text-foreground")}
              >
                <PanelRight className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Profile</TooltipContent>
          </Tooltip>

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
            <DropdownMenuContent align="end" className="min-w-44">
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
              Its routines and tasks stop and it leaves your team. This conversation stays in your history.
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
 * The empty thread greets in the agent's own voice. No suggestion chips: the
 * composer below is the invitation, and its placeholder says what to type.
 */
export function AgentGreeting({
  agent,
}: {
  agent: ClientAgent;
  onSelectSuggestion?: (text: string) => void;
}) {
  const paused = agent.status === "paused";
  return (
    <div className="flex flex-col items-center text-center motion-safe:animate-rise-in" data-face-trigger>
      <AgentPresence avatar={agent.avatar} state={paused ? "sleeping" : "idle"} size={88} spread={0.6} name={agent.name} />
      <h1 className="mt-8 text-balance font-serif text-display font-normal text-foreground">
        Hi, I’m <span className="italic">{agent.name}</span>.
      </h1>
      <p className="mt-3 max-w-md text-body-lg text-muted-foreground">
        {paused
          ? "I’m paused. Resume me from the menu above when you need me."
          : "Tell me what to take care of. I’ll set myself up and start."}
      </p>
    </div>
  );
}
