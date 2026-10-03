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
import { Monitor, MoreHorizontal, Pause, Play, Shapes, User } from "@/components/ui/icons";
import { AgentPresence, AgentStatusLine } from "@/components/agents/agent-presence";
import { AgentFaceStudio } from "@/components/agents/agent-face-studio";
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
import { BRAND } from "@/lib/brand/names";

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
  const computerFeatureOn = agent.computer != null;

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

  const attention = state === "waiting" || state === "blocked" || agent.needsYou > 0;
  const profileOpen = activePanelTab === "profile";

  return (
    <div
      className="agent-thread-bar relative isolate flex shrink-0 justify-center px-4 py-2.5"
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
          <AgentPresence avatar={agent.avatar} state={state} size={34} spread={0.4} gaze />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-serif text-body-lg leading-6 tracking-[-0.012em] text-foreground [font-optical-sizing:auto]">{agent.name}</span>
            {attention ? (
              <span className="block truncate text-caption font-medium text-[hsl(var(--attention))]" aria-live="polite">
                {sentence}
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
          {/* Named actions where there is room (design: About, Appearance, Pause), icons on a phone. */}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={profileOpen}
            onClick={() => onTogglePanel?.("profile")}
            className={cn("gap-1.5 px-2.5 font-normal text-muted-foreground hover:text-foreground", profileOpen && "bg-selected text-foreground")}
          >
            <User className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{`About ${agent.name}`}</span>
            <span className="sr-only sm:hidden">{`About ${agent.name}`}</span>
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setStudio(true)} className="hidden gap-1.5 px-2.5 font-normal text-muted-foreground hover:text-foreground md:inline-flex">
            <Shapes className="size-4" aria-hidden="true" />
            Appearance
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void handlePauseResume()} className="hidden gap-1.5 px-2.5 font-normal text-muted-foreground hover:text-foreground md:inline-flex">
            {agent.status === "paused" ? <Play className="size-4" aria-hidden="true" /> : <Pause className="size-4" aria-hidden="true" />}
            {agent.status === "paused" ? "Resume" : "Pause"}
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
                <MoreHorizontal className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem className="md:hidden" onSelect={() => setStudio(true)}>Appearance</DropdownMenuItem>
              <DropdownMenuItem className="md:hidden" onSelect={() => void handlePauseResume()}>
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
              {`Its routines and tasks stop and it leaves ${BRAND.orbit.label}. This conversation stays in your history.`}
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
 * The empty thread greets in the agent's own voice. No suggestion chips: the
 * composer below is the invitation, and its placeholder says what to type.
 */
function GREETING_RISE(step: number): React.CSSProperties {
  return { animationDelay: `${80 + step * 40}ms`, animationDuration: "var(--dur-slow)", animationTimingFunction: "cubic-bezier(.16, 1, .3, 1)", animationFillMode: "both" };
}

export function AgentGreeting({
  agent,
  onSelectSuggestion: _onSelectSuggestion,
}: {
  agent: ClientAgent;
  onSelectSuggestion?: (text: string) => void;
}) {
  const paused = agent.status === "paused";
  return (
    <div className="flex flex-col items-center text-center" data-face-trigger>
      <span className="motion-safe:animate-agent-arrive">
        <AgentPresence avatar={agent.avatar} state={paused ? "sleeping" : "idle"} size={88} spread={0.6} name={agent.name} gaze />
      </span>
      {/* The homepage's display finish: tight serif tracking, optical sizing,
          a calm lede, and the two lines arriving a beat after the face on
          the same expo ease. */}
      <h1
        className="mt-7 text-balance font-serif text-display font-normal leading-[1.02] tracking-[-0.032em] text-foreground [font-optical-sizing:auto] motion-safe:animate-rise-in"
        style={GREETING_RISE(1)}
      >
        {`Hi, I’m ${agent.name}.`}
      </h1>
      <p className="mt-3.5 max-w-md text-pretty text-body-lg text-muted-foreground motion-safe:animate-rise-in" style={GREETING_RISE(2)}>
        {paused
          ? "I’m paused. Resume me from the menu above when you need me."
          : "Tell me what to take care of. I’ll set myself up and start."}
      </p>
    </div>
  );
}
