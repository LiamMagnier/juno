"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { toast } from "sonner";
import { ThinkingOrb } from "thinking-orbs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hand, Maximize2, MoreHorizontal, X } from "@/components/ui/icons";
import { useConversationWork } from "@/components/chat/use-conversation-work";
import { AgentPresence } from "@/components/agents/agent-presence";
import { useAgentDetail } from "@/components/agents/use-agents";
import { announceAgentsChanged, computerAction } from "@/components/agents/agents-transport";
import type { ClientAgent, ClientAgentComputer } from "@/lib/agents/types";
import { cn } from "@/lib/utils";

const ComputerViewer = nextDynamic(
  () => import("@/components/agents/computer-viewer").then((m) => m.ComputerViewer),
  { ssr: false }
);

/**
 * The agent's computer, full screen over its thread (docs/design/agents-rework/
 * DIRECTION.md, "a place you can look into"). Watching is view-only on the server;
 * Take control mints a control session, Hand back ends it and tells the waiting
 * task to continue.
 */
export function AgentComputerOverlay({
  agent,
  open,
  initialMode = "watch",
  onClose,
}: {
  agent: ClientAgent;
  open: boolean;
  initialMode?: "watch" | "control";
  onClose: () => void;
}) {
  const { detail, refresh } = useAgentDetail(agent.id, null);
  const work = useConversationWork(open ? agent.conversationId : null);
  const [mode, setMode] = React.useState<"watch" | "control">(initialMode);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const computer: ClientAgentComputer | null = detail?.computer ?? null;
  const status = computer?.status ?? "asleep";

  React.useEffect(() => {
    if (open) setMode(initialMode);
  }, [open, initialMode]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode !== "control") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, mode, onClose]);

  // A resting computer opens instantly; waking it is the point of opening the view.
  React.useEffect(() => {
    if (!open || status !== "resting") return;
    void computerAction(agent.id, "wake").then(() => refresh());
  }, [open, status, agent.id, refresh]);

  const run = async (action: "wake" | "reset") => {
    setBusy(action);
    const res = await computerAction(agent.id, action);
    setBusy(null);
    if (res.kind === "failed") {
      toast.error(res.message);
      return;
    }
    announceAgentsChanged();
    refresh();
  };

  const handBack = async () => {
    setBusy("handback");
    await fetch(`/api/agents/${encodeURIComponent(agent.id)}/computer/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "control", ended: true }),
    }).catch(() => {});
    const question = work.questions[0];
    if (question) await work.answer(question.id, "Done. I've finished on your computer; continue.").catch(() => false);
    setBusy(null);
    setMode("watch");
    announceAgentsChanged();
  };

  if (!open) return null;

  const usingNow = computer?.usingNow?.summary ?? null;
  const caption =
    mode === "control"
      ? null
      : status === "awake"
        ? usingNow ?? "Idle. It rests after a few minutes."
        : status === "waking" || status === "starting" || status === "resting"
          ? "Waking up"
          : status === "error"
            ? "Couldn’t reach the computer."
            : `Asleep. It wakes when ${agent.name} starts working.`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${agent.name}’s computer`}
      className="fixed inset-0 z-modal flex flex-col bg-background/85 backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in duration-base"
    >
      <div className="flex shrink-0 items-center gap-3 px-5 py-4">
        <AgentPresence avatar={agent.avatar} state={agent.state} size={28} haloScale={1.8} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium text-foreground">{agent.name}’s computer</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Computer options" className="text-muted-foreground">
              <MoreHorizontal className="size-[1.125rem]" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {status === "awake" ? (
              <DropdownMenuItem
                onSelect={() => {
                  void fetch(`/api/agents/${encodeURIComponent(agent.id)}/computer/view`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mode, handoff: true }),
                  })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((data: { url?: string } | null) => {
                      if (data?.url) window.open(data.url, "_blank", "noopener,noreferrer");
                    })
                    .catch(() => {});
                }}
              >
                Open in a new window
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirmReset(true)}>
              Reset computer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close" onClick={onClose} className="text-muted-foreground">
          <X className="size-[1.125rem]" aria-hidden="true" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-5 pb-5">
        <div className="w-full max-w-[min(100%,calc((100dvh-11rem)*1.6))]">
          <div
            className={cn(
              "overflow-hidden rounded-panel bg-neutral-950 shadow-[0_30px_80px_-20px_hsl(var(--foreground)/0.35)] ring-1",
              mode === "control" ? "ring-2 ring-primary" : "ring-border/60"
            )}
          >
            {status === "awake" ? (
              <ComputerViewer
                key={mode}
                agentId={agent.id}
                agentName={agent.name}
                initialMode={mode}
                onModeChange={setMode}
              />
            ) : (
              <Poster agent={agent} computer={computer} status={status} />
            )}
          </div>

          <div className="mt-4 flex min-h-10 flex-wrap items-center justify-between gap-3">
            {mode === "control" ? (
              <p className="flex items-center gap-2 text-ui font-medium text-primary">
                <Hand className="size-4 shrink-0" aria-hidden="true" />
                You have control. {agent.name} waits until you hand back.
              </p>
            ) : (
              <p className="flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
                {status === "waking" || status === "starting" || status === "resting" ? (
                  <ThinkingOrb size={20} state="working" />
                ) : null}
                <span className="truncate">{caption}</span>
              </p>
            )}
            <div className="flex items-center gap-2">
              {status === "awake" ? (
                mode === "control" ? (
                  <Button type="button" className="rounded-full px-5" loading={busy === "handback"} onClick={() => void handBack()}>
                    Hand back
                  </Button>
                ) : (
                  <Button type="button" variant="outline" className="rounded-full px-5" onClick={() => setMode("control")}>
                    Take control
                  </Button>
                )
              ) : status === "error" || status === "asleep" || status === "sleeping" ? (
                <Button type="button" variant="outline" className="rounded-full px-5" loading={busy === "wake"} onClick={() => void run("wake")}>
                  {status === "error" ? "Try again" : "Wake"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset {agent.name}’s computer?</DialogTitle>
            <DialogDescription>
              Everything it signed in to and every file on it is deleted, and it starts again with a clean desktop.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmReset(false);
                void run("reset");
              }}
            >
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Poster({
  agent,
  computer,
  status,
}: {
  agent: ClientAgent;
  computer: ClientAgentComputer | null;
  status: string;
}) {
  return (
    <div className="relative aspect-[16/10] w-full">
      {computer?.hasPoster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/agents/${encodeURIComponent(agent.id)}/computer/poster`}
          alt=""
          className={cn("absolute inset-0 h-full w-full object-cover", status === "error" ? "opacity-20" : "opacity-45")}
        />
      ) : null}
      <div className="absolute inset-0 grid place-items-center">
        <AgentPresence avatar={agent.avatar} state={status === "error" ? "blocked" : "sleeping"} size={64} haloScale={2.4} />
      </div>
    </div>
  );
}

/**
 * The live picture-in-picture: while the agent is working on its computer, a small
 * view of the screen docks above the composer. Clicking it opens the full view.
 */
export function AgentComputerPip({ agent, onOpen }: { agent: ClientAgent; onOpen: () => void }) {
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);
  const active = agent.computer?.status === "awake" && agent.state === "working";
  const key = agent.task?.sessionId ?? "live";
  if (!active || dismissedFor === key) return null;
  return (
    <div className="pointer-events-auto relative w-[17.5rem] motion-safe:animate-rise-in">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${agent.name}’s computer`}
        className="group block w-full overflow-hidden rounded-card bg-neutral-950 text-left shadow-[0_18px_50px_-18px_hsl(var(--foreground)/0.45)] ring-1 ring-border/60 transition-transform duration-base ease-out-soft hover:-translate-y-0.5 active:scale-[0.99] motion-reduce:transform-none"
      >
        <div className="pointer-events-none">
          <ComputerViewer agentId={agent.id} agentName={agent.name} initialMode="watch" />
        </div>
        <span className="flex items-center gap-2 bg-card px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">Using its computer</span>
          <Maximize2 className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
        </span>
      </button>
      <button
        type="button"
        onClick={() => setDismissedFor(key)}
        aria-label="Hide"
        className="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full bg-card text-muted-foreground shadow-soft ring-1 ring-border/70 hover:text-foreground"
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}
