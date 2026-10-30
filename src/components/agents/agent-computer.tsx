"use client";

import * as React from "react";
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
import { ChevronLeft, FileText, Folder, Hand, Maximize2, MoreHorizontal, Upload, X } from "@/components/ui/icons";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ComputerTerminal } from "@/components/agents/computer-terminal";
import { useConversationWork } from "@/components/chat/use-conversation-work";
import { AgentFace } from "@/components/agents/agent-face";
import { AgentPresence } from "@/components/agents/agent-presence";
import { useAgentDetail } from "@/components/agents/use-agents";
import {
  COMPUTER_INBOX_FOLDER,
  COMPUTER_WORK_FOLDER,
  announceAgentsChanged,
  computerAction,
  computerFileDownloadUrl,
  computerHeartbeat,
  fetchComputerFiles,
  readComputerTakeover,
  uploadComputerFile,
  type ClientAgentComputerFolder,
  type ClientAgentComputerLive,
  type ClientComputerTakeover,
} from "@/components/agents/agents-transport";
import { COMPUTER_CHANNEL, type ComputerChannelMessage } from "@/components/agents/computer-viewer";
import {
  COMPUTER_STATE_COPY,
  HAND_BACK_ANSWER,
  computerStateSentence,
  controlSentence,
  handBackQuestion,
  pinTakeover,
  type TakeoverPin,
} from "@/lib/agents/computer-handback";
import type { ClientAgent } from "@/lib/agents/types";
import { freezeFailedLine, takeoverInfoLine } from "@/lib/computer/access-copy";
import { cn } from "@/lib/utils";

const ComputerViewer = nextDynamic(
  () => import("@/components/agents/computer-viewer").then((m) => m.ComputerViewer),
  { ssr: false }
);

/*
 * "Your turn · Take control" on the PiP opens the overlay already in control.
 * The PiP and the overlay are mounted side by side by the chat, which only
 * knows how to open the overlay; this is the note the PiP leaves for it.
 */
const controlRequests = new Set<string>();

/** Asks the overlay that opens next for this agent to open in control. */
export function requestComputerControl(agentId: string): void {
  controlRequests.add(agentId);
}

/** Whether a control request was waiting for this agent; it is spent by reading it. */
export function consumeComputerControlRequest(agentId: string): boolean {
  return controlRequests.delete(agentId);
}

function broadcastHandBack(agentId: string): void {
  try {
    const channel = new BroadcastChannel(COMPUTER_CHANNEL);
    channel.postMessage({ agentId, type: "handed-back" } satisfies ComputerChannelMessage);
    channel.close();
  } catch {
    // No other window to tell.
  }
}

/** Who holds control when it is not this overlay, as a sentence, or null. */
function holderSentence(takeover: ClientComputerTakeover | null): string | null {
  if (!takeover?.active) return null;
  return takeover.holderKind === "app" ? COMPUTER_STATE_COPY.heldByApp : COMPUTER_STATE_COPY.heldByWeb;
}

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
  const workRef = React.useRef(work);
  workRef.current = work;
  const [mode, setMode] = React.useState<"watch" | "control">(initialMode);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [confirmClose, setConfirmClose] = React.useState(false);
  const [live, setLive] = React.useState<ClientAgentComputerLive | null>(null);
  // Control is real once the control stream is up, not when it was asked for.
  const [controlConnected, setControlConnected] = React.useState(false);
  // "Open in a new window" moved control to a browser window this overlay opened.
  const [controlInWindow, setControlInWindow] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  // Whether the agent's processes were paused for this take over (the view
  // route says so for a new one). Only "ok" earns the line that says so.
  const [freeze, setFreeze] = React.useState<"ok" | "failed" | "unavailable" | null>(null);

  const [filesOpen, setFilesOpen] = React.useState(false);
  const [folder, setFolder] = React.useState<ClientAgentComputerFolder | null>(null);
  const [filesError, setFilesError] = React.useState<string | null>(null);
  const [filesLoading, setFilesLoading] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  // Narrow screens show the screen or the terminal, one at a time.
  const [pane, setPane] = React.useState<"screen" | "terminal">("screen");
  const addFile = async (file: File) => {
    setUploading(true);
    const outcome = await uploadComputerFile(agent.id, file);
    setUploading(false);
    if (outcome.kind !== "ok") {
      toast.error(outcome.message);
      return;
    }
    toast.success(
      outcome.value.name === file.name
        ? `Added ${outcome.value.name} to ${agent.name}’s inbox.`
        : `Added ${file.name} to ${agent.name}’s inbox as ${outcome.value.name}.`
    );
    void loadFolder(COMPUTER_INBOX_FOLDER);
  };
  const loadFolder = async (path?: string) => {
    setFilesLoading(true);
    setFilesError(null);
    const outcome = await fetchComputerFiles(agent.id, path);
    setFilesLoading(false);
    if (outcome.kind === "ok") setFolder(outcome.value);
    else setFilesError(outcome.message);
  };
  const openFiles = () => {
    setFilesOpen(true);
    setFolder(null);
    void loadFolder();
  };

  React.useEffect(() => {
    if (detail?.computer) setLive(detail.computer as ClientAgentComputerLive);
  }, [detail?.computer]);
  const computer: ClientAgentComputerLive | null = live ?? (detail?.computer as ClientAgentComputerLive | undefined) ?? null;
  const status = computer?.status ?? "asleep";
  const takeoverState = readComputerTakeover(computer);
  // The question this takeover is for, pinned when control is taken, so Hand
  // back answers that one and never whichever question happens to be first.
  const takeover = React.useRef<TakeoverPin | null>(null);

  React.useEffect(() => {
    if (!open) return;
    // The PiP's "Your turn · Take control" opens straight into control.
    const requested = consumeComputerControlRequest(agent.id);
    takeover.current = requested ? pinTakeover(workRef.current.questions) : null;
    setMode(requested ? "control" : initialMode);
    setControlConnected(false);
    setControlInWindow(false);
    setNotice(null);
    setPane("screen");
  }, [open, initialMode, agent.id]);

  const inControl = mode === "control" || controlInWindow;
  const requestClose = React.useCallback(() => {
    // One rule everywhere: closing while in control asks first, so the agent
    // is never left blocked behind a view nobody is looking at.
    if (inControl) setConfirmClose(true);
    else onClose();
  }, [inControl, onClose]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirmClose || confirmReset || filesOpen) return;
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose, confirmClose, confirmReset, filesOpen]);

  // A resting computer opens instantly; waking it is the point of opening the view.
  React.useEffect(() => {
    if (!open || status !== "resting") return;
    void computerAction(agent.id, "wake").then(() => refresh());
  }, [open, status, agent.id, refresh]);

  const announce = (text: string) => {
    // Cleared first so the same words twice in a row are announced twice.
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(text), 30);
  };

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
    setFreeze(null);
    setControlConnected(false);
    setMode("control");
  };

  /** Answers the pinned takeover question, and nothing when unsure. */
  const answerPinned = async () => {
    const question = handBackQuestion(work.questions, takeover.current);
    takeover.current = null;
    if (question) await work.answer(question.id, HAND_BACK_ANSWER).catch(() => false);
  };

  // Hand back rotates the computer's VNC passwords, which drops the control
  // stream. The viewer's reconnect then finds the takeover closed and reports
  // control as lost; while this overlay is handing back that is its own doing,
  // not "{agent} took the computer back", and must not drop the pinned question.
  const handingBack = React.useRef(false);

  const handBack = async (): Promise<boolean> => {
    setBusy("handback");
    handingBack.current = true;
    const outcome = await computerHeartbeat(agent.id, "control", true);
    if (outcome.kind === "failed" && outcome.status !== 409) {
      handingBack.current = false;
      setBusy(null);
      toast.error(outcome.message);
      return false;
    }
    broadcastHandBack(agent.id);
    // Watching from here on, before the answer goes out: the viewer swaps to
    // a watch stream instead of retrying control.
    setControlConnected(false);
    setControlInWindow(false);
    setMode("watch");
    if (outcome.kind === "ok") {
      if (outcome.value) setLive(outcome.value);
      setNotice(null);
      // Only the question that asked for the computer, and nothing when it has
      // gone: anything else is still the person's to answer in the composer.
      await answerPinned();
      announce(COMPUTER_STATE_COPY.handedBack);
    } else {
      // Someone else holds control: this overlay had nothing to hand back.
      takeover.current = null;
      setNotice(outcome.message);
      announce(outcome.message);
    }
    handingBack.current = false;
    setBusy(null);
    announceAgentsChanged();
    return true;
  };

  // A browser window this overlay opened handed back: the pinned question is
  // answered here, where the conversation is.
  React.useEffect(() => {
    if (!open || !controlInWindow || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(COMPUTER_CHANNEL);
    channel.onmessage = (event: MessageEvent<ComputerChannelMessage>) => {
      if (event.data?.agentId !== agent.id || event.data.type !== "handed-back") return;
      const question = handBackQuestion(workRef.current.questions, takeover.current);
      takeover.current = null;
      if (question) void workRef.current.answer(question.id, HAND_BACK_ANSWER).catch(() => false);
      setControlInWindow(false);
      announce(COMPUTER_STATE_COPY.handedBack);
      announceAgentsChanged();
    };
    return () => channel.close();
  }, [open, controlInWindow, agent.id]);

  const openInWindow = () => {
    // The window opens now, inside the click: opened after the link comes
    // back it is a popup Safari and Firefox block, and this view would drop
    // to watching while control sat in a window that never appeared. A
    // window opened with `noopener` cannot even say whether it opened.
    const opened = window.open("about:blank", "_blank");
    if (!opened) {
      toast.error("Your browser blocked the new window. Allow pop-ups for this site, then try again.");
      return;
    }
    try {
      opened.opener = null;
    } catch {
      // Already detached.
    }
    void fetch(`/api/agents/${encodeURIComponent(agent.id)}/computer/view`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, handoff: true }),
    })
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as { url?: string; message?: string };
        if (!r.ok || !data.url) throw new Error(data.message || "Couldn’t open a new window.");
        const url = new URL(data.url, window.location.origin);
        // The window has this browser's session: it shows Hand back itself.
        url.searchParams.set("w", "1");
        opened.location.replace(url.toString());
        if (mode === "control") {
          // Control moves to the window; this view watches. Nothing is handed
          // back, and the pinned question waits for the window's Hand back.
          setControlInWindow(true);
          setControlConnected(false);
          setMode("watch");
        }
      })
      .catch((error: unknown) => {
        try {
          opened.close();
        } catch {
          // Already gone.
        }
        toast.error(error instanceof Error ? error.message : "Couldn’t open a new window.");
      });
  };

  if (!open) return null;

  const usingNow = computer?.usingNow?.summary ?? null;
  const heldElsewhere = !inControl ? holderSentence(takeoverState) : null;
  const caption = inControl
    ? null
    : status === "awake" && heldElsewhere
      ? heldElsewhere
      : computerStateSentence({ status, agentName: agent.name, restMinutes: computer?.restMinutes, usingNow, opened: true });
  const waking = status === "starting" || status === "resting";
  const posterUrl = computer?.hasPoster ? `/api/agents/${encodeURIComponent(agent.id)}/computer/poster` : null;
  // The newest task's shell output, read-only, beside the screen (S5.1).
  const terminalRunId = work.run?.id ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${agent.name}’s computer`}
      className="fixed inset-0 z-modal flex flex-col bg-background/85 backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in duration-base"
    >
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <div className="flex shrink-0 items-center gap-3 px-5 py-4">
        <AgentPresence avatar={agent.avatar} state={agent.state} size={28} haloScale={1.8} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium text-foreground">{agent.name}’s computer</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon-sm" variant="ghost" aria-label="Computer options" className="text-muted-foreground coarse:size-11">
              <MoreHorizontal className="size-[1.125rem]" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {status === "awake" ? <DropdownMenuItem onSelect={openInWindow}>Open in a new window</DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={openFiles}>Files</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setConfirmReset(true)}>
              Reset computer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close" onClick={requestClose} className="text-muted-foreground coarse:size-11">
          <X className="size-[1.125rem]" aria-hidden="true" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-5 pb-5">
        <div
          className={cn(
            "w-full",
            // Beside the screen on a wide window, the terminal takes 22rem and
            // a 1rem gap; the screen keeps its height inside the viewport.
            terminalRunId
              ? "max-w-[min(100%,calc((100dvh-14rem)*1.6))] lg:max-w-[min(100%,calc((100dvh-11rem)*1.6+23rem))]"
              : "max-w-[min(100%,calc((100dvh-11rem)*1.6))]"
          )}
        >
          {terminalRunId ? (
            <SegmentedControl
              value={pane}
              onChange={setPane}
              options={[
                { value: "screen", label: "Screen" },
                { value: "terminal", label: "Terminal" },
              ]}
              ariaLabel={`Show ${agent.name}’s screen or terminal`}
              size="sm"
              className="mb-3 w-full max-w-[16rem] lg:hidden"
            />
          ) : null}
          <div className="flex gap-4">
            <div
              className={cn(
                "min-w-0 flex-1 overflow-hidden rounded-panel bg-muted shadow-[0_30px_80px_-20px_hsl(var(--foreground)/0.35)]",
                // On a narrow screen the terminal tab hides the screen without
                // unmounting it, so the live view stays connected.
                terminalRunId && pane === "terminal" && "max-lg:hidden",
                // The ring is the one sign of who drives: it eases between
                // watching and control on the motion tokens, and snaps when
                // motion is reduced.
                "transition-shadow duration-base ease-out-soft motion-reduce:transition-none",
                mode === "control" ? "ring-2 ring-primary" : "ring-1 ring-border/60"
              )}
            >
              {status === "awake" ? (
                // One viewer for watching and control: switching swaps the
                // stream under the last frame instead of remounting it.
                <ComputerViewer
                  agentId={agent.id}
                  agentName={agent.name}
                  initialMode={mode}
                  mode={mode}
                  inputTools
                  posterUrl={posterUrl}
                  onModeChange={setMode}
                  onConnected={(connected) => {
                    if (connected === "control") {
                      setControlConnected(true);
                      announce("You have control");
                    } else {
                      setControlConnected(false);
                    }
                  }}
                  onComputer={(next) => {
                    if (next) setLive(next);
                  }}
                  onControlLost={(message) => {
                    if (handingBack.current) return;
                    takeover.current = null;
                    setControlConnected(false);
                    setNotice(message);
                    announce(message);
                  }}
                  onFreeze={(next) => {
                    setFreeze(next);
                    if (next === "failed") announce(freezeFailedLine(agent.name));
                  }}
                />
              ) : (
                <Poster agent={agent} computer={computer} status={status} />
              )}
            </div>
            {terminalRunId ? (
              // The pane fills a box the layout sizes (the screen's row on a wide
              // window, a fixed height in the narrow tab), and never grows it: a
              // long output scrolls inside the pane instead of stretching the screen.
              <div
                className={cn(
                  "relative min-w-0 lg:w-[22rem] lg:shrink-0",
                  // Taller than the screen's 16:10 in the narrow tab: output is read in lines.
                  pane === "terminal" ? "max-lg:h-[min(60dvh,34rem)] max-lg:flex-1" : "max-lg:hidden"
                )}
              >
                <ComputerTerminal agentId={agent.id} agentName={agent.name} runId={terminalRunId} className="absolute inset-0" />
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex min-h-10 flex-wrap items-center justify-between gap-3">
            {mode === "control" ? (
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-ui font-medium text-primary">
                  <Hand className="size-4 shrink-0" aria-hidden="true" />
                  {controlConnected ? controlSentence(agent.name) : "Taking control…"}
                </p>
                {/* Said only when it is true: the pause worked, or it did not. */}
                {controlConnected && freeze === "ok" ? (
                  <p className="mt-1 text-ui text-muted-foreground">{takeoverInfoLine(agent.name)}</p>
                ) : null}
                {freeze === "failed" ? (
                  <p className="mt-1 text-ui text-destructive-ink">{freezeFailedLine(agent.name)}</p>
                ) : null}
              </div>
            ) : controlInWindow ? (
              <p className="flex items-center gap-2 text-ui font-medium text-primary">
                <Hand className="size-4 shrink-0" aria-hidden="true" />
                You have control in another window.
              </p>
            ) : (
              <p className="flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
                {waking ? <GalaxyMark phase="working" size={16} /> : null}
                <span className="truncate">{notice ?? caption}</span>
              </p>
            )}
            <div className="flex items-center gap-2">
              {status === "awake" ? (
                inControl ? (
                  <Button type="button" className="rounded-full px-5 coarse:min-h-11" loading={busy === "handback"} onClick={() => void handBack()}>
                    Hand back
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full px-5 coarse:min-h-11"
                    disabled={takeoverState?.active === true && takeoverState.holderKind === "app"}
                    onClick={takeControl}
                  >
                    Take control
                  </Button>
                )
              ) : status === "error" || status === "asleep" ? (
                <Button type="button" variant="outline" className="rounded-full px-5 coarse:min-h-11" loading={busy === "wake"} onClick={() => void run("wake")}>
                  {status === "error" ? "Try again" : "Wake"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Files on {agent.name}’s computer</DialogTitle>
            <DialogDescription>What it saved in its work folder. Open a folder, download anything you need, or add a file for it to use.</DialogDescription>
          </DialogHeader>
          <FilesBrowser
            agentId={agent.id}
            folder={folder}
            loading={filesLoading}
            error={filesError}
            onOpenFolder={(path) => void loadFolder(path)}
          />
          <DialogFooter className="items-center sm:justify-between">
            <p className="text-caption text-muted-foreground">Files you add go to its inbox folder.</p>
            <AddFileButton busy={uploading} disabled={status !== "awake" && status !== "resting"} onFile={(file) => void addFile(file)} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hand back to {agent.name}?</DialogTitle>
            <DialogDescription>
              You have control of {agent.name}’s computer. It waits until you hand back.
            </DialogDescription>
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

/**
 * "Add a file": a native file picker behind a button. The file goes to the
 * computer's ~/work/inbox (the server checks the size, the name and the
 * plan, and works while the person has control).
 */
function AddFileButton({ busy, disabled, onFile }: { busy: boolean; disabled: boolean; onFile: (file: File) => void }) {
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onFile(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5 coarse:min-h-11"
        loading={busy}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Upload className="size-4" aria-hidden="true" />
        Add a file
      </Button>
    </>
  );
}

/** The parent folder, never above the agent's home (the files route refuses anything outside it). */
function parentFolder(path: string): string | null {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === COMPUTER_WORK_FOLDER || trimmed === "/home/agent" || !trimmed.startsWith("/home/agent/")) return null;
  return trimmed.slice(0, trimmed.lastIndexOf("/")) || null;
}

function FilesBrowser({
  agentId,
  folder,
  loading,
  error,
  onOpenFolder,
}: {
  agentId: string;
  folder: ClientAgentComputerFolder | null;
  loading: boolean;
  error: string | null;
  onOpenFolder: (path: string) => void;
}) {
  const parent = folder ? parentFolder(folder.path) : null;
  const where = folder ? folder.path.replace(/^\/home\/agent\/?/, "") || "home" : null;
  return (
    <div className="min-h-24">
      {folder && parent ? (
        <div className="mb-2 flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 coarse:min-h-11" onClick={() => onOpenFolder(parent)}>
            <ChevronLeft className="size-4" aria-hidden="true" />
            Back
          </Button>
          <span className="min-w-0 truncate text-caption text-muted-foreground" translate="no">
            {where}
          </span>
        </div>
      ) : null}
      {loading ? (
        <p role="status" className="py-4 text-ui text-muted-foreground">
          Loading…
        </p>
      ) : error ? (
        <div role="alert" className="flex flex-col items-start gap-2 py-4">
          <p className="text-ui text-foreground">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenFolder(folder?.path ?? COMPUTER_WORK_FOLDER)}>
            Try again
          </Button>
        </div>
      ) : !folder ? null : folder.entries.length === 0 ? (
        <p className="py-4 text-ui text-muted-foreground">{parent ? "This folder is empty." : "Nothing saved yet."}</p>
      ) : (
        <ul className="max-h-80 overflow-y-auto">
          {folder.entries.map((entry) => (
            <li key={entry.path}>
              {entry.type === "directory" ? (
                <button
                  type="button"
                  onClick={() => onOpenFolder(entry.path)}
                  className="flex w-full items-center gap-3 rounded-control px-2 py-2 text-left text-body text-foreground hover:bg-accent coarse:min-h-11"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate" translate="no">
                    {entry.name}
                  </span>
                </button>
              ) : (
                <a
                  href={computerFileDownloadUrl(agentId, entry.path)}
                  download={entry.name}
                  className="flex items-center gap-3 rounded-control px-2 py-2 text-body text-foreground hover:bg-accent coarse:min-h-11"
                >
                  <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
    </div>
  );
}

function Poster({
  agent,
  computer,
  status,
}: {
  agent: ClientAgent;
  computer: ClientAgentComputerLive | null;
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
      {/* A still: the header above already carries the live face, and only
          one copy moves. Resting, never "sleeping": a computer that is
          asleep is not a paused agent, and the dormant grey would say so. */}
      <div className="absolute inset-0 grid place-items-center">
        <AgentFace avatar={agent.avatar} state={status === "error" ? "blocked" : agent.status === "paused" ? "sleeping" : "idle"} size={64} still />
      </div>
    </div>
  );
}

/**
 * The live picture-in-picture: while the agent works on its computer, or waits
 * for the person, a small view of the screen docks above the composer.
 * Clicking it opens the full view. It stays mounted through approvals, so a
 * run that asks to type five times opens one view session, not five; when the
 * agent waits, it rises with the signal edge and offers Take control.
 */
export function AgentComputerPip({ agent, onOpen }: { agent: ClientAgent; onOpen: () => void }) {
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);
  const [takeoverState, setTakeoverState] = React.useState<ClientComputerTakeover | null>(null);
  const awake = agent.computer?.status === "awake";
  const waiting = agent.state === "waiting";
  const active = awake && (agent.state === "working" || waiting);
  const key = agent.task?.sessionId ?? "live";
  if (!active || dismissedFor === key) return null;
  const holder = takeoverState?.active
    ? takeoverState.holderKind === "app"
      ? "Your app has control"
      : "You have control"
    : null;
  return (
    <div className="pointer-events-auto relative w-[17.5rem] motion-safe:animate-rise-in">
      <div
        className={cn(
          "overflow-hidden rounded-card bg-card",
          "transition-[box-shadow,transform] duration-base ease-out-soft motion-reduce:transition-none",
          waiting
            ? "shadow-[0_24px_60px_-18px_hsl(var(--foreground)/0.55)] ring-2 ring-[hsl(var(--signal))] motion-safe:-translate-y-1"
            : "shadow-[0_18px_50px_-18px_hsl(var(--foreground)/0.45)] ring-1 ring-border/60"
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${agent.name}’s computer`}
          className="group block w-full text-left"
        >
          <div className="pointer-events-none">
            <ComputerViewer
              agentId={agent.id}
              agentName={agent.name}
              initialMode="watch"
              onComputer={(computer) => setTakeoverState(readComputerTakeover(computer))}
            />
          </div>
          {waiting ? null : (
            <span className="flex items-center gap-2 bg-card px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{holder ?? "Using its computer"}</span>
              <Maximize2 className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
            </span>
          )}
        </button>
        {waiting ? (
          holder ? (
            <p className="bg-card px-3 py-2 text-caption text-muted-foreground">{holder}</p>
          ) : (
            <button
              type="button"
              onClick={() => {
                requestComputerControl(agent.id);
                onOpen();
              }}
              className="flex w-full items-center justify-center gap-2 bg-card px-3 py-2 text-caption font-medium text-[hsl(var(--signal-ink))] transition-colors hover:bg-accent coarse:min-h-11"
            >
              <Hand className="size-3.5 shrink-0" aria-hidden="true" />
              Your turn · Take control
            </button>
          )
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => setDismissedFor(key)}
        aria-label="Hide"
        className="group/hide absolute -right-2 -top-2 grid size-6 place-items-center rounded-full coarse:-right-4 coarse:-top-4 coarse:size-11"
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
