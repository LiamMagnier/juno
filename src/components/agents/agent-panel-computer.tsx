"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Download, Hand, Maximize2, Monitor } from "@/components/ui/icons";
import { ThinkingOrb } from "thinking-orbs";
import { useConversationWork } from "@/components/chat/use-conversation-work";
import type { ClientAgentDetail } from "@/lib/agents/types";
import {
  announceAgentsChanged,
  computerAction,
  fetchComputerFiles,
  type ClientAgentComputerFile,
} from "@/components/agents/agents-transport";

const ComputerViewer = nextDynamic(
  () => import("@/components/agents/computer-viewer").then((m) => m.ComputerViewer),
  { ssr: false }
);

function formatDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (hours > 0) {
    return `${hours} h ${mins} min`;
  }
  return `${Math.max(1, mins)} min`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AgentPanelComputer({
  detail,
  onChanged,
  initialMode = "watch",
  staticPreview = false,
  mockFiles,
}: {
  detail: ClientAgentDetail;
  onChanged: () => void;
  initialMode?: "watch" | "control";
  staticPreview?: boolean;
  mockFiles?: ClientAgentComputerFile[];
}) {
  const { agent, computer } = detail;
  const work = useConversationWork(staticPreview ? null : agent.conversationId);
  const [mode, setMode] = React.useState<"watch" | "control">(initialMode);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [confirmEnable, setConfirmEnable] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [confirmTurnOff, setConfirmTurnOff] = React.useState(false);
  const [files, setFiles] = React.useState<ClientAgentComputerFile[] | null>(mockFiles ?? null);
  const [loadingFiles, setLoadingFiles] = React.useState(false);

  React.useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  const status = computer?.status ?? "disabled";
  const posterSrc = `/api/agents/${encodeURIComponent(agent.id)}/computer/poster`;

  // When resting, opening the view unpauses it automatically
  React.useEffect(() => {
    if (staticPreview) return;
    if (status === "resting") {
      void computerAction(agent.id, "wake").then((res) => {
        if (res.kind === "ok") {
          announceAgentsChanged();
          onChanged();
        }
      });
    }
  }, [agent.id, onChanged, staticPreview, status]);

  const runComputerAction = async (action: "enable" | "disable" | "wake" | "sleep" | "reset") => {
    setBusyAction(action);
    const outcome = await computerAction(agent.id, action);
    setBusyAction(null);
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    if (action === "enable") toast.success(`Enabled ${agent.name}’s computer.`);
    if (action === "reset") toast.success(`Reset ${agent.name}’s computer.`);
    if (action === "disable") toast.success(`Turned off ${agent.name}’s computer.`);
    announceAgentsChanged();
    onChanged();
  };

  const handleHandBack = async () => {
    setBusyAction("handback");
    await fetch(`/api/agents/${encodeURIComponent(agent.id)}/computer/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "control", ended: true }),
    }).catch(() => {});

    const openQuestion = work.questions[0];
    if (openQuestion) {
      await work.answer(openQuestion.id, "Done. I've finished on your computer; continue.").catch(() => false);
    }
    setBusyAction(null);
    setMode("watch");
    announceAgentsChanged();
    onChanged();
  };

  const handleOpenFullscreen = async () => {
    const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/computer/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, handoff: true }),
    }).catch(() => null);
    if (!res || !res.ok) {
      toast.error("Couldn’t open full screen view.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { url?: string };
    if (data.url) {
      window.open(data.url, "_blank", "noopener,noreferrer");
    }
  };

  const handleLoadFiles = async () => {
    if (mockFiles) return;
    setLoadingFiles(true);
    const outcome = await fetchComputerFiles(agent.id);
    setLoadingFiles(false);
    if (outcome.kind === "ok") {
      setFiles(outcome.value);
    } else if (outcome.kind === "failed") {
      toast.error(outcome.message);
    }
  };

  if (!detail.computerConfigured) {
    return null;
  }

  if (!computer || status === "disabled") {
    return (
      <div className="space-y-4">
        <div className="rounded-card border border-border bg-card p-5">
          <div className="mb-3 flex size-9 items-center justify-center rounded-control border border-border bg-muted/40 text-muted-foreground">
            <Monitor className="size-4" aria-hidden="true" />
          </div>
          <p className="text-body text-foreground">
            {agent.name} doesn’t have a computer yet. With one, it can sign in to sites, run code and keep files.
          </p>
          <div className="mt-4">
            <Button size="sm" loading={busyAction === "enable"} onClick={() => setConfirmEnable(true)}>
              Give it a computer
            </Button>
          </div>
        </div>

        <Dialog open={confirmEnable} onOpenChange={setConfirmEnable}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Give {agent.name} a computer?</DialogTitle>
              <DialogDescription>
                This creates a persistent desktop for {agent.name} on your server. Sites it signs in to and files it
                saves in <span className="font-mono">/home/agent/work</span> stay across tasks until you reset or turn
                off the computer.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmEnable(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmEnable(false);
                  void runComputerAction("enable");
                }}
              >
                Give it a computer
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Screen frame */}
      {status === "awake" ? (
        <div className="space-y-3">
          {staticPreview ? (
            <div
              translate="no"
              className="relative flex aspect-[16/10] w-full flex-col overflow-hidden rounded-lg border border-border bg-neutral-950 text-neutral-100 shadow-xs"
            >
              {/* Window title & tab bar */}
              <div className="flex h-6 shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-900 px-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex items-center gap-1" aria-hidden="true">
                    <span className="size-2 rounded-full bg-neutral-700" />
                    <span className="size-2 rounded-full bg-neutral-700" />
                    <span className="size-2 rounded-full bg-neutral-700" />
                  </div>
                  <span className="truncate rounded-t border-x border-t border-neutral-800 bg-neutral-950 px-2 py-0.5 font-sans text-[10px] font-medium text-neutral-200">
                    Acme FY26 Enterprise Renewal — Chromium
                  </span>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-neutral-300">
                  <span
                    className={
                      mode === "control"
                        ? "size-1.5 rounded-full bg-amber-400"
                        : "size-1.5 rounded-full bg-emerald-400"
                    }
                  />
                  {mode === "control" ? "CONTROL" : "WATCHING"}
                </span>
              </div>

              {/* Browser URL bar */}
              <div className="flex h-6 shrink-0 items-center justify-between gap-3 border-b border-neutral-800/80 bg-neutral-900/60 px-2.5 font-mono text-[10px] text-neutral-400">
                <span className="truncate">https://billing.acme.io/renewals/fy26</span>
                <span className="shrink-0 text-neutral-500">1280×800</span>
              </div>

              {/* Realistic document / pricing sheet inside Chromium */}
              <div className="flex flex-1 flex-col justify-between bg-neutral-950 p-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-400">
                      ACME CLOUD · QUOTE #Q4-8821
                    </span>
                    <span className="font-mono text-[9px] text-emerald-400">Saved 4s ago</span>
                  </div>
                  <p className="mt-0.5 text-xs font-semibold text-neutral-100">
                    FY26 Seat Tier &amp; Commitment Comparison
                  </p>
                  <div className="mt-2 overflow-hidden rounded border border-neutral-800 bg-neutral-900/60 text-[10px]">
                    <div className="flex items-center justify-between border-b border-neutral-800/80 px-2 py-1 text-neutral-300">
                      <span>12-Month Standard (120 seats)</span>
                      <span className="font-mono text-neutral-200">$42,000 / yr</span>
                    </div>
                    <div className="flex items-center justify-between border-b border-neutral-800/80 px-2 py-1 text-neutral-300">
                      <span>24-Month Commit (-13% discount)</span>
                      <span className="font-mono text-neutral-200">$36,400 / yr</span>
                    </div>
                    <div className="flex items-center justify-between border-l-2 border-emerald-400 bg-emerald-950/30 px-2 py-1 font-medium text-emerald-200">
                      <span>Draft Counter-Proposal (12-Month)</span>
                      <span className="font-mono">$38,000 / yr (-9.5%)</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-neutral-800/70 pt-1.5 font-mono text-[9px] text-neutral-400">
                  <span className="truncate">/home/agent/work/vendor-comparison-q4.xlsx</span>
                  <span className="shrink-0">XFCE4 · x11vnc</span>
                </div>
              </div>
            </div>
          ) : (
            <ComputerViewer
              agentId={agent.id}
              agentName={agent.name}
              initialMode={mode}
              onModeChange={(next) => setMode(next)}
            />
          )}

          {mode === "control" ? (
            <div className="flex items-center justify-between gap-3 rounded-control border border-primary/30 bg-primary/8 px-3 py-2.5">
              <p className="flex items-start gap-2 text-caption font-medium leading-snug text-primary">
                <Hand className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>You have control. {agent.name} waits until you hand back.</span>
              </p>
              <Button
                size="sm"
                loading={busyAction === "handback"}
                onClick={() => void handleHandBack()}
                className="h-7 shrink-0 px-3 text-caption"
              >
                Hand back
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-ui leading-snug text-foreground">
                  {computer.usingNow ? (
                    <>
                      <span className="font-medium">{agent.name} is using it:</span>{" "}
                      <span className="text-muted-foreground">{computer.usingNow.summary}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Idle. Rests after 3 minutes.</span>
                  )}
                </p>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setMode("control")}
                  className="h-7 gap-1.5 px-2.5 text-caption"
                >
                  <Hand className="size-3.5 text-primary" aria-hidden="true" />
                  Take control
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleOpenFullscreen()}
                  className="h-7 gap-1.5 px-2.5 text-caption text-muted-foreground hover:text-foreground"
                >
                  <Maximize2 className="size-3" aria-hidden="true" />
                  Full screen
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : status === "starting" || status === "waking" ? (
        <div className="space-y-2.5">
          <div className="relative grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-lg border border-border bg-neutral-950 text-neutral-300">
            <div className="flex items-center gap-2 text-ui">
              <ThinkingOrb size={20} state="working" />
              <span>Waking up…</span>
            </div>
          </div>
          <p className="flex items-center gap-2 text-ui text-muted-foreground">
            <ThinkingOrb size={20} state="working" />
            <span>Starting desktop environment…</span>
          </p>
        </div>
      ) : status === "resting" || status === "sleeping" ? (
        <div className="space-y-2.5">
          <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-neutral-950">
            {computer.hasPoster && !staticPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={posterSrc}
                alt={`${agent.name}'s computer screen`}
                className="h-full w-full object-cover opacity-75"
              />
            ) : null}
            <div className="absolute inset-0 grid place-items-center bg-neutral-950/60 p-4 text-center">
              <p className="text-ui text-neutral-200">Resting. Opens instantly.</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-ui text-muted-foreground">Resting. Opens instantly.</p>
            <Button size="sm" variant="secondary" loading={busyAction === "wake"} onClick={() => void runComputerAction("wake")} className="h-7 px-2.5 text-caption">
              Wake
            </Button>
          </div>
        </div>
      ) : status === "error" ? (
        <div className="space-y-2.5">
          <div className="relative grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-lg border border-destructive/40 bg-neutral-950 p-4 text-center">
            <div className="space-y-1">
              <p className="text-ui font-medium text-neutral-100">Couldn’t reach the computer.</p>
              {computer.error ? (
                <p className="text-caption text-neutral-400">{computer.error}</p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-ui text-muted-foreground">Couldn’t reach the computer.</p>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="secondary" loading={busyAction === "wake"} onClick={() => void runComputerAction("wake")} className="h-7 px-2.5 text-caption">
                Try again
              </Button>
              <Button size="sm" variant="ghost" loading={busyAction === "reset"} onClick={() => setConfirmReset(true)} className="h-7 px-2.5 text-caption">
                Reset
              </Button>
            </div>
          </div>
        </div>
      ) : (
        /* asleep */
        <div className="space-y-2.5">
          <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-neutral-950">
            {computer.hasPoster && !staticPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={posterSrc}
                alt={`${agent.name}'s last computer screen`}
                className="h-full w-full object-cover opacity-40"
              />
            ) : null}
            <div className="absolute inset-0 grid place-items-center bg-neutral-950/75 p-4 text-center">
              <p className="text-ui text-neutral-300">Asleep. It wakes when {agent.name} starts working.</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-ui text-muted-foreground">Asleep. It wakes when {agent.name} starts working.</p>
            <Button size="sm" variant="secondary" loading={busyAction === "wake"} onClick={() => void runComputerAction("wake")} className="h-7 px-2.5 text-caption">
              Wake
            </Button>
          </div>
        </div>
      )}

      {/* Disclosure: Files, Reset, Turn off, Usage */}
      <details
        className="group border-y border-border/60 py-2.5"
        open={Boolean(mockFiles)}
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open && files === null) {
            void handleLoadFiles();
          }
        }}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between text-ui font-medium text-foreground">
          <span>Files &amp; computer controls</span>
          <span className="font-mono text-micro text-muted-foreground">
            Awake {formatDuration(computer.activeSeconds)}
          </span>
        </summary>
        <div className="mt-3 space-y-3 border-t border-border/50 pt-3">
          {/* Files */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-micro text-muted-foreground">/home/agent/work</span>
              <button
                type="button"
                onClick={() => void handleLoadFiles()}
                disabled={loadingFiles}
                className="text-micro text-muted-foreground hover:text-foreground"
              >
                {loadingFiles ? "Loading…" : "Refresh"}
              </button>
            </div>
            {files && files.length > 0 ? (
              <ul className="divide-y divide-border/60 border-y border-border/60">
                {files.map((file) => (
                  <li key={file.name} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate font-mono text-caption text-foreground">{file.name}</span>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="font-mono text-micro text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                      <a
                        href={`/api/agents/${encodeURIComponent(agent.id)}/computer/files/${encodeURIComponent(file.name)}`}
                        download={file.name}
                        className="inline-flex items-center gap-1 text-caption font-medium text-foreground hover:underline"
                      >
                        <Download className="size-3" aria-hidden="true" />
                        Download
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-muted-foreground">No files in /home/agent/work yet.</p>
            )}
          </div>

          {/* Usage & Retention */}
          <p className="text-caption text-muted-foreground">
            Awake {formatDuration(computer.activeSeconds)} in total. Asleep more than 30 days: its sign-ins and files
            are cleared.
          </p>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button size="sm" variant="secondary" loading={busyAction === "reset"} onClick={() => setConfirmReset(true)} className="h-7 px-2.5 text-caption">
              Reset computer
            </Button>
            <Button size="sm" variant="ghost" loading={busyAction === "disable"} onClick={() => setConfirmTurnOff(true)} className="h-7 px-2.5 text-caption text-muted-foreground hover:text-foreground">
              Turn off
            </Button>
          </div>
        </div>
      </details>

      {/* Confirm Reset */}
      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset {agent.name}’s computer?</DialogTitle>
            <DialogDescription>
              All sign-ins, browser cookies and files saved on {agent.name}’s computer will be deleted and replaced with
              a clean desktop.
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
                void runComputerAction("reset");
              }}
            >
              Reset computer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Turn off */}
      <Dialog open={confirmTurnOff} onOpenChange={setConfirmTurnOff}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off {agent.name}’s computer?</DialogTitle>
            <DialogDescription>
              This destroys {agent.name}’s computer container and deletes all sign-ins and files stored on it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmTurnOff(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmTurnOff(false);
                void runComputerAction("disable");
              }}
            >
              Turn off
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
