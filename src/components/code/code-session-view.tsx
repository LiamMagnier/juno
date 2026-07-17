"use client";

import * as React from "react";
import { ArrowUp, ArrowUpRight, Cloud, Folder, GitPullRequest, Loader2, ShieldAlert, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageList } from "@/components/chat/message-list";
import { useApp } from "@/components/app/app-provider";
import { useCodeSession, isLiveId, CODE_SYNC_EVENT, type CodeSessionStatus } from "@/hooks/use-code-session";
import { isDefaultCodeSessionTitle } from "@/lib/title-ownership";
import { takePendingCodePrompt } from "@/lib/code-session-handoff";
import { cn } from "@/lib/utils";
import type { ClientConversation, ClientMessage, GenerationStatus } from "@/types/chat";

/*
 * The chat surface for a kind:"code" conversation. Same rendering language as
 * ChatView (MessageList/MessageItem are reused verbatim), but the composer
 * submits remote tasks that run with Juno Code on the user's Mac:
 * POST /api/code/tasks → SSE /api/code/tasks/[id]/events → /respond | /cancel.
 */

interface CodeSessionViewProps {
  conversation: ClientConversation;
  initialMessages: ClientMessage[];
}

type PresenceState = "checking" | "online" | "offline" | "none" | "error";
type Presence = { state: PresenceState; device: { id: string; name: string } | null };

type DeviceRow = {
  id: string;
  name: string;
  online?: boolean;
  lastSeenAt: string;
  workspaces: unknown;
};

const PRESENCE_POLL_MS = 30_000;

function deviceOffersWorkspace(device: DeviceRow, key: string | null, path: string | null, name: string | null): boolean {
  if (!Array.isArray(device.workspaces)) return false;
  return (device.workspaces as { name?: unknown; path?: unknown; key?: unknown }[]).some((w) => {
    // Stable identity first — a host that re-registered the folder from a new
    // location still owns this session's workspace.
    if (key != null && w?.key === key) return true;
    return path ? w?.path === path : name != null && w?.name === name;
  });
}

/** The Mac that owns this session's workspace, and whether it's reachable.
 *  Gentle poll while the tab is visible; refreshes immediately on refocus. */
function useDevicePresence(workspaceKey: string | null, workspacePath: string | null, workspaceName: string | null) {
  const [presence, setPresence] = React.useState<Presence>({ state: "checking", device: null });

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/code/devices");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { devices?: DeviceRow[] };
      const candidates = (Array.isArray(data.devices) ? data.devices : [])
        .filter((d) => deviceOffersWorkspace(d, workspaceKey, workspacePath, workspaceName))
        .sort((a, b) => {
          if (!!a.online !== !!b.online) return a.online ? -1 : 1;
          return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
        });
      const device = candidates[0];
      setPresence(
        device
          ? { state: device.online ? "online" : "offline", device: { id: device.id, name: device.name } }
          : { state: "none", device: null }
      );
    } catch {
      // Keep the last honest reading if we had one; otherwise say we don't know.
      setPresence((prev) => (prev.state === "checking" ? { state: "error", device: null } : prev));
    }
  }, [workspaceKey, workspacePath, workspaceName]);

  React.useEffect(() => {
    void refresh();
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const interval = window.setInterval(tick, PRESENCE_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  return { presence, refresh };
}

type CodeTaskMeta = {
  loaded: boolean;
  isCloud: boolean;
  repoOwner: string | null;
  repoName: string | null;
  baseRef: string | null;
  prUrl: string | null;
};

type TaskMetaRow = {
  target?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  baseRef?: string | null;
  prUrl?: string | null;
};

/** Whether this session runs in the cloud, and its repo / PR — read from the
 *  session's tasks (serializeTask carries target/repo/prUrl). The latest task
 *  defines the surface; the PR link is the newest task that has one. Refreshes
 *  on the code-sync signal so a completed run's PR appears without a reload. */
function useCodeTaskMeta(conversationId: string): CodeTaskMeta & { refresh: () => void } {
  const [meta, setMeta] = React.useState<CodeTaskMeta>({
    loaded: false,
    isCloud: false,
    repoOwner: null,
    repoName: null,
    baseRef: null,
    prUrl: null,
  });

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/code/tasks?conversationId=${encodeURIComponent(conversationId)}&limit=20`);
      if (!res.ok) return;
      const data = (await res.json()) as { tasks?: TaskMetaRow[] };
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const latest = tasks[0];
      const withRepo = tasks.find((t) => t.repoOwner && t.repoName);
      const prUrl = tasks.find((t) => typeof t.prUrl === "string" && t.prUrl)?.prUrl ?? null;
      setMeta({
        loaded: true,
        isCloud: latest?.target === "cloud",
        repoOwner: latest?.repoOwner ?? withRepo?.repoOwner ?? null,
        repoName: latest?.repoName ?? withRepo?.repoName ?? null,
        baseRef: latest?.baseRef ?? withRepo?.baseRef ?? null,
        prUrl,
      });
    } catch {
      // Keep the last reading; a device session simply stays non-cloud.
    }
  }, [conversationId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  React.useEffect(() => {
    const on = () => void refresh();
    window.addEventListener(CODE_SYNC_EVENT, on);
    return () => window.removeEventListener(CODE_SYNC_EVENT, on);
  }, [refresh]);

  return { ...meta, refresh };
}

const PRESENCE_META: Record<PresenceState, { label: string; dot: string }> = {
  checking: { label: "Checking your Mac…", dot: "bg-muted-foreground/40 motion-safe:animate-pulse" },
  online: { label: "Mac connected", dot: "bg-success" },
  offline: { label: "Mac offline", dot: "bg-muted-foreground/50" },
  none: { label: "No Mac has synced this project", dot: "bg-muted-foreground/50" },
  error: { label: "Presence unavailable", dot: "bg-warning" },
};

const TASK_CHIP: Partial<Record<CodeSessionStatus, string>> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Needs approval",
  stopping: "Stopping…",
};

export function CodeSessionView({ conversation, initialMessages }: CodeSessionViewProps) {
  const { setActiveConversationId, updateConversation, conversations } = useApp();
  const workspaceName = conversation.codeWorkspaceName?.trim() || "Code session";
  const workspacePath = conversation.codeWorkspacePath ?? null;
  const workspaceKey = conversation.codeWorkspaceKey ?? null;
  const { presence } = useDevicePresence(workspaceKey, workspacePath, conversation.codeWorkspaceName?.trim() || null);
  const meta = useCodeTaskMeta(conversation.id);
  const isCloud = meta.isCloud;
  const cloudRepoFull = meta.repoOwner && meta.repoName ? `${meta.repoOwner}/${meta.repoName}` : null;

  const session = useCodeSession({
    conversationId: conversation.id,
    initialMessages,
    onActivity: () => updateConversation(conversation.id, { lastMessageAt: new Date().toISOString() }),
  });

  React.useEffect(() => {
    setActiveConversationId(conversation.id);
  }, [conversation.id, setActiveConversationId]);

  // Re-attach to a run that was live when the page loaded (reload mid-task).
  const resumedRef = React.useRef(false);
  React.useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    void (async () => {
      try {
        const res = await fetch(`/api/code/tasks?conversationId=${encodeURIComponent(conversation.id)}&limit=10`);
        if (!res.ok) return;
        const data = (await res.json()) as { tasks?: { id: string; status: string }[] };
        const active = (data.tasks ?? []).find((t) => !["done", "failed", "cancelled"].includes(t.status));
        if (active) session.resume(active);
      } catch {
        // History still renders; the next send re-establishes the live path.
      }
    })();
    // session.resume is stable for the lifetime of this conversation id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  const [draft, setDraft] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // First prompt handed off from the New session screen (device sessions only —
  // cloud sessions dispatch their task up front). Pre-fill the draft and arm a
  // one-shot auto-dispatch that fires the moment the Mac is reachable; if it's
  // offline the prompt simply waits, ready to send, nothing lost.
  const [autoSendArmed, setAutoSendArmed] = React.useState(false);
  React.useEffect(() => {
    const pending = takePendingCodePrompt(conversation.id);
    if (pending) {
      setDraft(pending);
      setAutoSendArmed(true);
    }
    // Once, on mount for this conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);

  // Cloud sessions ignore device presence entirely — they run on a dispatched
  // machine, so the only gate is knowing the repo. Device sessions keep their
  // presence-based gating unchanged.
  const canTarget = isCloud ? !!cloudRepoFull : presence.device != null;
  const sendBlockedReason = isCloud
    ? !cloudRepoFull
      ? "Preparing this cloud session…"
      : null
    : presence.state === "none"
      ? "Open this project in the Juno app on your Mac so it can run sessions here."
      : presence.state === "error"
        ? "Can't reach the server to find your Mac — retrying."
        : presence.state === "checking"
          ? "Looking for the Mac that has this project…"
          : !workspacePath
            ? "This session isn't linked to a synced project folder."
            : null;

  const nameSessionFromFirstPrompt = React.useCallback(
    (text: string) => {
      const current = conversations.find((c) => c.id === conversation.id);
      if (current && current.titleSource === "default" && isDefaultCodeSessionTitle(current.title)) {
        updateConversation(conversation.id, { title: text.slice(0, 48) });
      }
    },
    [conversation.id, conversations, updateConversation],
  );

  const submit = React.useCallback(async () => {
    const text = draft.trim();
    if (!text || session.isBusy) return;

    if (isCloud) {
      if (!meta.repoOwner || !meta.repoName) return;
      const { accepted } = await session.send(text, {
        mode: "cloud",
        repo: { owner: meta.repoOwner, name: meta.repoName },
        baseRef: meta.baseRef,
        workspaceName: conversation.codeWorkspaceName,
      });
      if (accepted) {
        setDraft("");
        nameSessionFromFirstPrompt(text);
        meta.refresh(); // a follow-up run may open a new PR — pick it up
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
      return;
    }

    if (!presence.device) return;
    // The device's workspace path is authoritative when the conversation only
    // carries a name (sessions created before the path was recorded).
    const path = workspacePath ?? null;
    if (!path) return;
    const { accepted } = await session.send(text, {
      deviceId: presence.device.id,
      workspacePath: path,
      workspaceName: conversation.codeWorkspaceName,
      workspaceKey,
    });
    if (accepted) {
      setDraft("");
      // First prompt of a fresh session names it (server does the same — this
      // mirrors POST /api/code/tasks so the sidebar updates without a refetch).
      nameSessionFromFirstPrompt(text);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [conversation.codeWorkspaceName, draft, isCloud, meta, nameSessionFromFirstPrompt, presence.device, session, workspaceKey, workspacePath]);

  const composerDisabled = isCloud ? !cloudRepoFull : !canTarget || !workspacePath;
  const canSend = !!draft.trim() && canTarget && (isCloud || !!workspacePath) && !session.isBusy;

  // Fire the handed-off first prompt as soon as the session can send. Cloud
  // sessions were already dispatched on the New session screen, so this only
  // covers device — it waits out presence resolution, then sends exactly once.
  React.useEffect(() => {
    if (!autoSendArmed) return;
    if (isCloud) {
      setAutoSendArmed(false);
      return;
    }
    if (!canSend) return;
    setAutoSendArmed(false);
    void submit();
  }, [autoSendArmed, canSend, isCloud, submit]);

  // MessageList's streaming label: "Writing" once prose lands, "Thinking" before.
  const listStatus: GenerationStatus =
    session.status === "running" || session.status === "awaiting_approval"
      ? session.messages[session.messages.length - 1]?.streaming && session.messages[session.messages.length - 1]?.content
        ? "writing"
        : "thinking"
      : session.status === "stopping"
        ? "stopping"
        : "idle";

  const hasMessages = session.messages.length > 0;
  const presenceMeta = PRESENCE_META[presence.state];
  const taskChip = TASK_CHIP[session.status];

  const composer = (
    <div className="mx-auto w-full max-w-[calc(100vw-1.5rem)] px-0 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-[48rem] sm:px-4">
      {session.pendingApproval && (
        <ApprovalCard
          summary={session.pendingApproval.summary}
          risk={session.pendingApproval.risk}
          detail={session.pendingApproval.detail}
          responding={session.responding}
          onRespond={(approve) => void session.respond(session.pendingApproval!.requestId, approve)}
        />
      )}
      {session.status === "queued" && (
        <p role="status" className="mx-1 mb-2 flex items-center gap-2 rounded-xl border border-border/70 bg-muted/45 px-3 py-2 text-xs text-muted-foreground motion-safe:animate-rise-in">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50 motion-safe:animate-pulse" aria-hidden="true" />
          {isCloud
            ? "Queued — starting a cloud machine (this can take a moment)…"
            : presence.state === "offline"
              ? "Queued — runs when your Mac reconnects."
              : "Queued — waiting for your Mac to pick this up."}
        </p>
      )}
      <div className="relative flex w-full flex-col rounded-panel border border-border/70 bg-card/90 shadow-float backdrop-blur transition-[border-color,box-shadow] duration-base ease-out-soft focus-within:border-primary/30 focus-within:shadow-glass">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          disabled={composerDisabled}
          placeholder={
            composerDisabled
              ? sendBlockedReason ?? "This session can't run tasks right now."
              : isCloud
                ? `Describe the change to make in ${cloudRepoFull ?? "the repo"}…`
                : presence.state === "offline"
                  ? "Describe the change — it queues until your Mac reconnects…"
                  : "Describe what to build or fix…"
          }
          aria-label="Prompt for this code session"
          className="max-h-[200px] min-h-[74px] w-full resize-none bg-transparent px-3.5 py-3.5 text-body-lg leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 sm:px-4"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-0.5">
          {/* Identity is the workspace NAME (device) or the repo (cloud); the
              device-local path is honest secondary metadata, on hover. */}
          <span
            title={isCloud ? cloudRepoFull ?? undefined : workspacePath ?? undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-label uppercase text-muted-foreground"
          >
            {isCloud && <Cloud className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 truncate">{isCloud ? cloudRepoFull ?? workspaceName : workspaceName}</span>
          </span>
          {/* Send morphs into Stop while a task runs — same morph as chat. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                onClick={session.isBusy ? () => void session.cancel() : () => void submit()}
                disabled={session.isBusy ? session.status === "stopping" || session.status === "submitting" : !canSend}
                aria-label={
                  session.isBusy
                    ? session.status === "stopping"
                      ? "Stopping task"
                      : "Stop this task"
                    : isCloud
                      ? "Start a cloud run"
                      : "Send to your Mac"
                }
                className={cn(
                  "coarse:h-11 coarse:w-11 transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-spring",
                  session.isBusy && session.status !== "submitting" ? "w-12 rounded-md shadow-soft ring-2 ring-primary/20" : "rounded-lg"
                )}
              >
                {session.status === "submitting" ? (
                  <Loader2 key="submitting" className="h-4 w-4 animate-spin motion-safe:animate-fade-in" />
                ) : session.isBusy ? (
                  <Square key="stop" className="h-3.5 w-3.5 fill-current motion-safe:animate-fade-in" />
                ) : (
                  <ArrowUp key="send" className="h-4 w-4 motion-safe:animate-fade-in" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{session.isBusy ? "Stop" : "Send"}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* Session banner. Device: which project, on which Mac, reachable or not.
          Cloud: the repo + a calm "runs in the cloud, opens a PR" note (no
          device-offline/queue copy), plus the PR link once the run opens one. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-2 md:px-4">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10">
          {isCloud ? (
            <Cloud className="h-3 w-3 text-primary" aria-hidden="true" />
          ) : (
            <Folder className="h-3 w-3 text-primary" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {isCloud ? cloudRepoFull ?? workspaceName : workspaceName}
        </span>
        {isCloud
          ? meta.baseRef && (
              <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">
                on {meta.baseRef}
              </span>
            )
          : workspacePath && (
              <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">
                {workspacePath}
              </span>
            )}
        <span className="flex-1" />
        {taskChip && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground motion-safe:animate-fade-in">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                session.status === "running" ? "bg-success motion-safe:animate-pulse" : session.status === "awaiting_approval" ? "bg-warning" : "bg-muted-foreground/50"
              )}
              aria-hidden="true"
            />
            {taskChip}
          </span>
        )}
        {isCloud ? (
          meta.prUrl ? (
            <a
              href={meta.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pressable inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors duration-fast hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-safe:animate-fade-in"
            >
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
              View pull request
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : (
            <span
              role="status"
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 text-xs text-muted-foreground"
            >
              <Cloud className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">Runs in the cloud · opens a pull request</span>
            </span>
          )
        ) : (
          <span
            role="status"
            title={presence.device?.name}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 text-xs text-muted-foreground"
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", presenceMeta.dot)} aria-hidden="true" />
            <span className="min-w-0 truncate">{presenceMeta.label}</span>
          </span>
        )}
      </div>

      {hasMessages ? (
        <div className="relative flex h-full min-h-0 flex-1 flex-col">
          <MessageList
            messages={session.messages}
            busy={session.isBusy}
            status={listStatus}
            artifacts={[]}
            onOpenArtifact={() => {}}
            onFeedback={session.setFeedback}
            // Live bubbles are client-side until the run's row comes back.
            canFeedback={(m) => !isLiveId(m.id)}
          />
          <div className="w-full px-0 pb-1">{composer}</div>
          <p className="shrink-0 select-none pb-2 text-center text-caption text-muted-foreground">
            {isCloud
              ? "Runs in the cloud and opens a pull request — review the changes before you merge them."
              : "Runs with Juno Code on your Mac — review the changes before you ship them."}
          </p>
        </div>
      ) : (
        <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-3 py-6 sm:px-5 md:py-10">
            <div className="mb-5 flex w-full flex-col items-center text-center sm:mb-6">
              <h1 className="font-serif text-3xl font-normal tracking-tight text-foreground sm:text-display">
                {isCloud ? cloudRepoFull ?? workspaceName : workspaceName}
              </h1>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground sm:text-base">
                {isCloud
                  ? "Describe what to build or fix — the run happens in the cloud and opens a pull request you can review."
                  : "Describe what to build or fix — Juno Code runs it on your Mac and streams the work here."}
              </p>
            </div>
            <div className="z-10 w-full max-w-[44rem]">{composer}</div>
          </div>
          <p className="shrink-0 select-none pb-2 text-center text-caption text-muted-foreground">
            {isCloud
              ? "Runs in the cloud and opens a pull request — review the changes before you merge them."
              : "Runs with Juno Code on your Mac — review the changes before you ship them."}
          </p>
        </div>
      )}
    </div>
  );
}

/** An agent follow-up question: approve or deny the proposed action. The Mac
 *  waits up to five minutes, then denies on its own (native host behavior). */
function ApprovalCard({
  summary,
  risk,
  detail,
  responding,
  onRespond,
}: {
  summary: string;
  risk: string;
  detail: string | null;
  responding: boolean;
  onRespond: (approve: boolean) => void;
}) {
  return (
    // Not a dialog: this card appears inline in the transcript, never takes
    // focus and traps nothing, so role="alertdialog" promised modal behavior no
    // AT could act on. A labelled group is what it actually is — paired with a
    // polite live announcement so the request isn't silent for screen readers.
    <div
      role="group"
      aria-label="Juno Code approval request"
      className="mx-1 mb-2 space-y-2.5 rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-3 text-sm motion-safe:animate-rise-in"
    >
      <span role="status" className="sr-only">
        {`Juno Code needs your approval to: ${summary}.${
          risk === "destructive"
            ? " This is a destructive action."
            : risk === "outside"
              ? " This affects files outside the workspace."
              : ""
        } Allow or Deny below.`}
      </span>
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground">
            <span className="text-muted-foreground">Juno Code wants to: </span>
            <span className="font-medium">{summary}</span>
          </p>
          {detail && (
            <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 font-mono text-[11px] leading-5 text-muted-foreground">
              {detail}
            </pre>
          )}
        </div>
        {(risk === "destructive" || risk === "outside") && (
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
              risk === "destructive"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-warning/40 bg-warning/10 text-warning-foreground"
            )}
          >
            {risk === "destructive" ? "Destructive" : "Outside workspace"}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={risk === "destructive" ? "destructive" : "default"}
          disabled={responding}
          onClick={() => onRespond(true)}
          className="gap-1.5"
        >
          {responding && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Allow
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={responding} onClick={() => onRespond(false)}>
          Deny
        </Button>
        <span className="text-caption text-muted-foreground">Your Mac denies automatically after 5 minutes.</span>
      </div>
    </div>
  );
}
