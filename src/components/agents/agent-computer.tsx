"use client";

import "@/components/agents/computer.css";
import * as React from "react";
import { flushSync } from "react-dom";
import nextDynamic from "next/dynamic";
import { toast } from "sonner";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
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
import { ChevronRight, Download, Folder, Hand, Maximize2, MoreHorizontal, X } from "@/components/ui/icons";
import { useConversationWork } from "@/components/chat/use-conversation-work";
import { AgentPresence } from "@/components/agents/agent-presence";
import { useAgentDetail } from "@/components/agents/use-agents";
import {
  announceAgentsChanged,
  computerAction,
  computerFileDownloadUrl,
  computerFolderCrumbs,
  endComputerControlOnLeave,
  fetchComputerFiles,
  openComputerHandoff,
  sendComputerHeartbeat,
  type ClientAgentComputerFolder,
} from "@/components/agents/agents-transport";
import { requestComputerControl, takeComputerControlIntent } from "@/components/agents/computer-control-intent";
import {
  COMPUTER_TAKEOVER_CONTRACT,
  HAND_BACK_ANSWER,
  computerIsWaking,
  computerStateSentence,
  handBackQuestion,
  isTakeoverQuestion,
  pinTakeover,
  takeoverHolderSentence,
  takeoverMineSentence,
  type TakeoverPin,
} from "@/lib/agents/computer-handback";
import { usePhrase } from "@/lib/i18n-phrase";
import type { ClientAgent, ClientAgentComputer } from "@/lib/agents/types";
import { cn } from "@/lib/utils";

const ComputerViewer = nextDynamic(
  () => import("@/components/agents/computer-viewer").then((m) => m.ComputerViewer),
  { ssr: false }
);

/** The name both ends of the PiP-to-overlay view transition share. */
const FRAME_TRANSITION = "agent-computer-frame";

/** Same-origin windows ("Open in a new window") say here when they hand back. */
const HANDBACK_CHANNEL = "alevr-computer";

function posterUrl(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/computer/poster`;
}

/**
 * The agent's computer, full screen over its thread (docs/design/agents-rework/
 * DIRECTION.md, "a place you can look into"). Watching is view-only on the server;
 * Take control mints a control session, Hand back ends it and tells the waiting
 * task to continue.
 *
 * Watch and control are one viewer that reconnects in place, so taking control
 * never flashes black: the last frame stays under the new session and the two
 * crossfade, with a presence edge around the screen while the person drives.
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
  const [confirmClose, setConfirmClose] = React.useState(false);
  /** Control moved to a window opened from here; this overlay watches meanwhile. */
  const [handedToWindow, setHandedToWindow] = React.useState(false);
  /** "Alevr took the computer back", or who has it, after control was lost. */
  const [notice, setNotice] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const [filesOpen, setFilesOpen] = React.useState(false);
  const [folder, setFolder] = React.useState<ClientAgentComputerFolder | null>(null);
  const [filesError, setFilesError] = React.useState<string | null>(null);
  const [filesLoading, setFilesLoading] = React.useState(false);
  const youHaveControl = usePhrase(COMPUTER_TAKEOVER_CONTRACT.takeoverSentences.youHaveControl);
  const handedBack = usePhrase(COMPUTER_TAKEOVER_CONTRACT.takeoverSentences.handedBack);

  const openFolder = async (path?: string) => {
    setFilesOpen(true);
    setFilesLoading(true);
    setFilesError(null);
    const outcome = await fetchComputerFiles(agent.id, path);
    setFilesLoading(false);
    if (outcome.kind === "ok") {
      setFolder(outcome.value);
    } else {
      // The route's own sentence ("Wake the computer first…"), never an empty folder.
      setFilesError(outcome.kind === "failed" ? outcome.message : "Couldn’t read the files.");
    }
  };

  const computer: ClientAgentComputer | null = detail?.computer ?? null;
  const status = computer?.status ?? "asleep";
  const heldElsewhere = Boolean(computer?.takeover?.active && !computer.takeover.mine);
  // The question this takeover is for, pinned when control is taken, so Hand
  // back answers that one and never whichever question happens to be first.
  const takeover = React.useRef<TakeoverPin | null>(null);
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  const handedToWindowRef = React.useRef(handedToWindow);
  handedToWindowRef.current = handedToWindow;
  const questionsRef = React.useRef(work.questions);
  questionsRef.current = work.questions;
  const answerRef = React.useRef(work.answer);
  answerRef.current = work.answer;

  // Opening: straight into control when the PiP's "Your turn" asked for it,
  // with the question that asked pinned. Taken once per opening.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    const intent = takeComputerControlIntent(agent.id);
    if (intent) {
      setMode("control");
      takeover.current = intent.questionId ? { questionId: intent.questionId, openAtStart: [] } : null;
    } else {
      setMode(initialMode);
      takeover.current = null;
    }
    setHandedToWindow(false);
    setNotice(null);
  }, [open, initialMode, agent.id]);

  // Closing (or leaving the page) while still in control ends the control
  // session, so the agent is not left stopped for a minute. It answers
  // nothing: only Hand back says "done".
  React.useEffect(() => {
    if (!open) return;
    return () => {
      if (modeRef.current === "control" && !handedToWindowRef.current) endComputerControlOnLeave(agent.id);
    };
  }, [open, agent.id]);

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

  // The window control moved to says when it hands back; the question pinned
  // here is answered then, exactly as a hand back from here would.
  React.useEffect(() => {
    if (!open || !handedToWindow || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(HANDBACK_CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type?: string; agentId?: string }>) => {
      if (event.data?.type !== "handed-back" || event.data.agentId !== agent.id) return;
      const question = handBackQuestion(questionsRef.current, takeover.current);
      takeover.current = null;
      setHandedToWindow(false);
      setAnnouncement(handedBack);
      if (question) void answerRef.current(question.id, HAND_BACK_ANSWER).catch(() => false);
      announceAgentsChanged();
    };
    return () => channel.close();
  }, [open, handedToWindow, agent.id, handedBack]);

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

  const takeControl = () => {
    takeover.current = pinTakeover(work.questions);
    setNotice(null);
    setHandedToWindow(false);
    setMode("control");
  };

  const handBack = async (): Promise<boolean> => {
    setBusy("handback");
    const outcome = await sendComputerHeartbeat(agent.id, { mode: "control", ended: true });
    if (outcome.kind === "failed") {
      setBusy(null);
      if (outcome.error === "takeover_held") {
        // It was not this browser's to give back: say whose it is.
        setNotice(outcome.message);
        takeover.current = null;
        setMode("watch");
        return true;
      }
      toast.error(outcome.message);
      return false;
    }
    // Only the question that asked for the computer, and nothing when it has
    // gone: anything else is still the person's to answer in the composer.
    const question = handBackQuestion(work.questions, takeover.current);
    takeover.current = null;
    if (question) await work.answer(question.id, HAND_BACK_ANSWER).catch(() => false);
    setBusy(null);
    setMode("watch");
    setAnnouncement(handedBack);
    announceAgentsChanged();
    refresh();
    return true;
  };

  const requestClose = () => {
    if (mode === "control" && !handedToWindow) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const openInNewWindow = async () => {
    const outcome = await openComputerHandoff(agent.id, mode);
    if (outcome.kind !== "ok" || !outcome.value) {
      toast.error(outcome.kind === "failed" ? outcome.message : "Couldn’t open a new window.");
      return;
    }
    const opened = window.open(outcome.value, "_blank");
    if (!opened) {
      toast.error("Allow pop-ups for this site to open the computer in a new window.");
      return;
    }
    try {
      opened.opener = null;
    } catch {
      // Cross-origin already; nothing to cut.
    }
    if (mode === "control") {
      // The window takes control over (same browser, same holder); this
      // overlay watches without handing back, and answers the pinned
      // question when the window says it handed back.
      setHandedToWindow(true);
      setMode("watch");
    }
  };

  const onControlLost = React.useCallback((message: string) => {
    takeover.current = null;
    setNotice(message);
    setMode("watch");
    setAnnouncement(message);
  }, []);

  React.useEffect(() => {
    if (mode === "control") setAnnouncement(youHaveControl);
  }, [mode, youHaveControl]);

  if (!open) return null;

  const caption =
    notice ??
    (handedToWindow
      ? "You have control in another window."
      : heldElsewhere
        ? takeoverHolderSentence(computer?.takeover?.holder ?? null)
        : computerStateSentence({
            status,
            agent: agent.name,
            restMinutes: computer?.restMinutes,
            usingNow: computer?.usingNow?.summary ?? null,
          }));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${agent.name}’s computer`}
      className="computer-overlay fixed inset-0 z-modal flex flex-col bg-background/85 backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in duration-base"
    >
      <div className="flex shrink-0 items-center gap-3 px-4 py-3 sm:px-5 sm:py-4">
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
              <DropdownMenuItem onSelect={() => void openInNewWindow()}>Open in a new window</DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={() => {
                setFolder(null);
                void openFolder();
              }}
            >
              Files
            </DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirmReset(true)}>
              Reset computer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={mode === "control" ? `Hand back to ${agent.name} and close` : "Close"}
          onClick={requestClose}
          className="text-muted-foreground"
        >
          <X className="size-[1.125rem]" aria-hidden="true" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-3 pb-4 sm:px-5 sm:pb-5">
        <div className="w-full max-w-[min(100%,calc((100dvh-13rem)*1.6))]">
          <div
            className="computer-overlay__frame overflow-hidden rounded-panel shadow-[0_30px_80px_-20px_hsl(var(--foreground)/0.35)] ring-1 ring-border/60"
            // The far end of the PiP's view transition. Only one of the two is
            // ever on screen: the chat view hides the PiP while this is open.
            style={{ viewTransitionName: FRAME_TRANSITION }}
          >
            {status === "awake" ? (
              <ComputerViewer
                agentId={agent.id}
                agentName={agent.name}
                initialMode={mode}
                mode={mode}
                posterUrl={computer?.hasPoster ? posterUrl(agent.id) : null}
                onControlLost={onControlLost}
              />
            ) : (
              <Poster agent={agent} computer={computer} status={status} />
            )}
          </div>

          <div className="mt-4 flex min-h-10 flex-wrap items-center justify-between gap-3">
            {mode === "control" ? (
              <p role="status" className="computer-viewer__status-control flex items-center gap-2 text-ui font-medium">
                <Hand className="size-4 shrink-0" aria-hidden="true" />
                {takeoverMineSentence(agent.name)}
              </p>
            ) : (
              <p className="flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
                {computerIsWaking(status) ? <GalaxyMark phase="working" size={18} /> : null}
                <span className="truncate">{caption}</span>
              </p>
            )}
            <div className="flex items-center gap-2">
              {status === "awake" ? (
                mode === "control" ? (
                  <Button type="button" className="rounded-full px-5" loading={busy === "handback"} onClick={() => void handBack()}>
                    Hand back
                  </Button>
                ) : handedToWindow ? null : (
                  <Button type="button" variant="outline" className="rounded-full px-5" onClick={takeControl}>
                    Take control
                  </Button>
                )
              ) : status === "error" || status === "asleep" ? (
                <Button type="button" variant="outline" className="rounded-full px-5" loading={busy === "wake"} onClick={() => void run("wake")}>
                  {status === "error" ? "Try again" : "Wake"}
                </Button>
              ) : null}
            </div>
          </div>
          {/* "You have control" and "Handed back", announced once each. */}
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>
      </div>

      <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Files on {agent.name}’s computer</DialogTitle>
            <DialogDescription>What it saved in its work folder. Download anything you need.</DialogDescription>
          </DialogHeader>
          {folder ? (
            <nav aria-label="Folder" className="-mt-1 flex min-w-0 flex-wrap items-center gap-0.5 text-caption text-muted-foreground">
              {computerFolderCrumbs(folder.path).map((crumb, index, all) => (
                <React.Fragment key={crumb.path}>
                  {index > 0 ? <ChevronRight className="size-3 shrink-0" aria-hidden="true" /> : null}
                  {index === all.length - 1 ? (
                    <span aria-current="page" className="truncate px-1 text-foreground" translate="no">
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void openFolder(crumb.path)}
                      className="truncate rounded-control px-1 py-0.5 hover:bg-accent hover:text-foreground coarse:min-h-11"
                      translate="no"
                    >
                      {crumb.label}
                    </button>
                  )}
                </React.Fragment>
              ))}
            </nav>
          ) : null}
          {filesLoading ? (
            <p role="status" className="flex items-center gap-2 py-4 text-ui text-muted-foreground">
              <GalaxyMark phase="working" size={16} />
              Loading…
            </p>
          ) : filesError ? (
            <p role="alert" className="py-4 text-ui text-muted-foreground">
              {filesError}
            </p>
          ) : !folder || folder.entries.length === 0 ? (
            <p className="py-4 text-ui text-muted-foreground">Nothing saved here yet.</p>
          ) : (
            <ul className="-mx-2 max-h-80 overflow-y-auto">
              {folder.entries.map((entry) => (
                <li key={entry.path}>
                  {entry.type === "directory" ? (
                    <button
                      type="button"
                      onClick={() => void openFolder(entry.path)}
                      className="flex w-full items-center gap-3 rounded-control px-2 py-2 text-left text-body text-foreground hover:bg-accent coarse:min-h-11"
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate" translate="no">
                        {entry.name}
                      </span>
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  ) : (
                    <a
                      href={computerFileDownloadUrl(agent.id, entry.path)}
                      download={entry.name}
                      className="flex items-center gap-3 rounded-control px-2 py-2 text-body text-foreground hover:bg-accent coarse:min-h-11"
                    >
                      <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate" translate="no">
                        {entry.name}
                      </span>
                      <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{formatSize(entry.sizeBytes)}</span>
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hand back to {agent.name}?</DialogTitle>
            <DialogDescription>{agent.name} carries on from the screen as you leave it.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmClose(false)}>
              Keep control
            </Button>
            <Button
              type="button"
              loading={busy === "handback"}
              onClick={() => {
                void handBack().then((done) => {
                  setConfirmClose(false);
                  if (done) onClose();
                });
              }}
            >
              Hand back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
          src={posterUrl(agent.id)}
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
 * The live picture-in-picture: while the agent's computer is awake and its
 * task is working or waiting on the person, a small view of the screen docks
 * above the composer. Clicking it opens the full view.
 *
 * It stays mounted through approvals (a task waiting on one is still the same
 * task on the same screen), so the viewer underneath is not torn down and
 * reopened for every typing approval. When the agent is waiting for the
 * person to take over, the coral edge lifts it and "Your turn: take control"
 * opens the overlay straight into control.
 */
export function AgentComputerPip({ agent, onOpen }: { agent: ClientAgent; onOpen: () => void }) {
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);
  const cardRef = React.useRef<HTMLButtonElement | null>(null);
  const awake = agent.computer?.status === "awake";
  const live = agent.state === "working" || agent.state === "waiting";
  // Read-only: which open question, if any, asks the person to take over.
  const work = useConversationWork(awake && agent.state === "waiting" ? agent.conversationId : null);
  const takeoverQuestion = work.questions.find(isTakeoverQuestion) ?? null;
  const yourTurn = Boolean(takeoverQuestion);
  const key = agent.task?.sessionId ?? "live";
  if (!awake || !live || (dismissedFor === key && !yourTurn)) return null;

  /** Opens the overlay, morphing the frame where the browser can. */
  const openOverlay = () => {
    const doc = document as Document & { startViewTransition?: (update: () => void) => unknown };
    if (typeof doc.startViewTransition !== "function" || !cardRef.current) {
      onOpen();
      return;
    }
    cardRef.current.style.viewTransitionName = FRAME_TRANSITION;
    try {
      doc.startViewTransition(() => {
        flushSync(onOpen);
      });
    } catch {
      onOpen();
    }
  };

  const takeTurn = () => {
    requestComputerControl(agent.id, takeoverQuestion?.id ?? null);
    openOverlay();
  };

  return (
    <div className="computer-pip pointer-events-auto relative w-[17.5rem] motion-safe:animate-rise-in" data-attention={yourTurn ? "true" : "false"}>
      <button
        ref={cardRef}
        type="button"
        onClick={openOverlay}
        aria-label={`Open ${agent.name}’s computer`}
        className="computer-pip__card group block w-full overflow-hidden rounded-card text-left shadow-[0_18px_50px_-18px_hsl(var(--foreground)/0.45)] ring-1 ring-border/60 transition-transform duration-base ease-out-soft hover:-translate-y-0.5 active:scale-[0.99] motion-reduce:transform-none"
      >
        <div className="pointer-events-none">
          <ComputerViewer
            agentId={agent.id}
            agentName={agent.name}
            initialMode="watch"
            controls={false}
            posterUrl={posterUrl(agent.id)}
          />
        </div>
        <span className="flex items-center gap-2 bg-card px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
            {yourTurn ? `${agent.name} is waiting for you` : "Using its computer"}
          </span>
          <Maximize2 className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
        </span>
      </button>
      {yourTurn ? (
        <button
          type="button"
          onClick={takeTurn}
          className="computer-pip__turn pressable mt-2 flex w-full items-center justify-center gap-2 rounded-full px-4 py-2 text-ui font-medium motion-reduce:transition-none coarse:min-h-11"
        >
          <Hand className="size-4 shrink-0" aria-hidden="true" />
          Your turn: take control
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setDismissedFor(key)}
        aria-label="Hide"
        className="group/hide absolute -right-2 -top-2 grid size-6 place-items-center coarse:-right-4 coarse:-top-4 coarse:size-11"
      >
        <span className="grid size-6 place-items-center rounded-full bg-card text-muted-foreground shadow-soft ring-1 ring-border/70 group-hover/hide:text-foreground">
          <X className="size-3" aria-hidden="true" />
        </span>
      </button>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
