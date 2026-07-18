"use client";

import * as React from "react";
import Image from "next/image";
import {
  ArrowUp,
  ArrowUpRight,
  Cloud,
  FileText,
  FileUp,
  Folder,
  GitPullRequest,
  ImagePlus,
  Library,
  Loader2,
  Paperclip,
  Plus,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageList } from "@/components/chat/message-list";
import { LibraryPicker } from "@/components/chat/library-picker";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useCodeSession, isLiveId, CODE_SYNC_EVENT, type CodeSessionStatus } from "@/hooks/use-code-session";
import { isDefaultCodeSessionTitle } from "@/lib/title-ownership";
import { takePendingCodePrompt } from "@/lib/code-session-handoff";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/utils";
import type { ClientAttachment, ClientConversation, ClientMessage, GenerationStatus } from "@/types/chat";

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
  const { setActiveConversationId, updateConversation, conversations, features } = useApp();
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
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [removingIds, setRemovingIds] = React.useState<string[]>([]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(
    conversation.id,
  );
  const canAttach = features.storage;

  const autoresize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);
  React.useEffect(() => {
    autoresize();
  }, [draft, autoresize]);

  // First prompt handed off from the New session screen (device sessions only —
  // cloud sessions dispatch their task up front). Pre-fill the draft + staged
  // attachments and arm a one-shot auto-dispatch that fires the moment the Mac
  // is reachable; if it's offline the prompt simply waits, ready to send.
  const [autoSendArmed, setAutoSendArmed] = React.useState(false);
  const handoffDoneRef = React.useRef(false);
  React.useEffect(() => {
    if (handoffDoneRef.current) return;
    handoffDoneRef.current = true;
    const pending = takePendingCodePrompt(conversation.id);
    if (pending) {
      setDraft(pending.text);
      if (pending.attachments.length) addAttachments(pending.attachments);
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
    (text: string, attachments: ClientAttachment[]) => {
      const current = conversations.find((c) => c.id === conversation.id);
      if (current && current.titleSource === "default" && isDefaultCodeSessionTitle(current.title)) {
        const title =
          text.slice(0, 48) ||
          (attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`);
        updateConversation(conversation.id, { title });
      }
    },
    [conversation.id, conversations, updateConversation],
  );

  const removeUpload = React.useCallback(
    (localId: string) => {
      setRemovingIds((prev) => [...prev, localId]);
      window.setTimeout(() => {
        remove(localId);
        setRemovingIds((prev) => prev.filter((id) => id !== localId));
      }, 180);
    },
    [remove],
  );

  const submit = React.useCallback(async () => {
    const text = draft.trim();
    const attachments = readyAttachments;
    if ((!text && attachments.length === 0) || session.isBusy || isUploading) return;

    if (isCloud) {
      if (!meta.repoOwner || !meta.repoName) return;
      const { accepted } = await session.send(
        text,
        {
          mode: "cloud",
          repo: { owner: meta.repoOwner, name: meta.repoName },
          baseRef: meta.baseRef,
          workspaceName: conversation.codeWorkspaceName,
        },
        attachments,
      );
      if (accepted) {
        setDraft("");
        clear();
        nameSessionFromFirstPrompt(text, attachments);
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
    const { accepted } = await session.send(
      text,
      {
        deviceId: presence.device.id,
        workspacePath: path,
        workspaceName: conversation.codeWorkspaceName,
        workspaceKey,
      },
      attachments,
    );
    if (accepted) {
      setDraft("");
      clear();
      // First prompt of a fresh session names it (server does the same — this
      // mirrors POST /api/code/tasks so the sidebar updates without a refetch).
      nameSessionFromFirstPrompt(text, attachments);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [
    clear,
    conversation.codeWorkspaceName,
    draft,
    isCloud,
    isUploading,
    meta,
    nameSessionFromFirstPrompt,
    presence.device,
    readyAttachments,
    session,
    workspaceKey,
    workspacePath,
  ]);

  const composerDisabled = isCloud ? !cloudRepoFull : !canTarget || !workspacePath;
  const hasPayload = !!draft.trim() || readyAttachments.length > 0;
  const canSend =
    hasPayload &&
    canTarget &&
    (isCloud || !!workspacePath) &&
    !session.isBusy &&
    !isUploading;

  // Fire the handed-off first prompt as soon as the session can send. Cloud
  // sessions were already dispatched on the New session screen, so this only
  // covers device — it waits out presence resolution, then sends exactly once.
  // Also wait out any staged-attachment uploads from the New session screen.
  React.useEffect(() => {
    if (!autoSendArmed) return;
    if (isCloud) {
      setAutoSendArmed(false);
      return;
    }
    if (!canSend || isUploading) return;
    setAutoSendArmed(false);
    void submit();
  }, [autoSendArmed, canSend, isCloud, isUploading, submit]);

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
      <div
        onDragOver={(e) => {
          if (!canAttach || composerDisabled) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (canAttach && !composerDisabled && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "composer-surface relative flex max-h-[600px] w-full origin-center flex-col rounded-[22px] border bg-card/95 backdrop-blur sm:rounded-[24px]",
          "transition-[border-color,box-shadow] duration-base ease-spring motion-reduce:transition-none",
          "border-border/65 focus-within:border-foreground/15",
          dragging && "border-primary/55 ring-2 ring-primary/20",
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-[inherit] border-2 border-dashed border-primary/45 bg-primary/10 backdrop-blur-sm motion-safe:animate-fade-in">
            <FileUp className="h-6 w-6 text-primary" />
            <span className="font-mono text-label uppercase text-primary">Drop to attach</span>
          </div>
        )}

        {canAttach && (
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-base ease-out-soft",
              uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex flex-wrap gap-2 p-3 pb-0">
                {uploads.map((u) => (
                  <div
                    key={u.localId}
                    className={cn(
                      "group relative flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-xs shadow-soft",
                      removingIds.includes(u.localId)
                        ? "pointer-events-none motion-safe:animate-pop-out"
                        : "motion-safe:animate-rise-in",
                    )}
                  >
                    {u.attachment?.kind === "IMAGE" ? (
                      <Image src={u.attachment.url} alt={u.fileName} width={32} height={32} className="h-8 w-8 rounded object-cover" />
                    ) : (
                      <FileText className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div className="max-w-[140px]">
                      <p className="truncate font-medium">{u.fileName}</p>
                      <p className="text-muted-foreground">
                        {u.status === "uploading" ? `${u.progress}%` : u.status === "error" ? "Failed" : formatBytes(u.size)}
                      </p>
                    </div>
                    {u.status === "uploading" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    <button
                      type="button"
                      onClick={() => removeUpload(u.localId)}
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background opacity-0 shadow-soft transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 coarse:-right-2.5 coarse:-top-2.5 coarse:p-1.5 coarse:opacity-100"
                      aria-label="Remove attachment"
                    >
                      <X className="h-3 w-3 coarse:h-4 coarse:w-4" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) void submit();
            }
          }}
          rows={1}
          disabled={composerDisabled || session.isBusy}
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
          className="max-h-[200px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground/70 disabled:opacity-70 sm:px-[18px] sm:pt-[17px]"
        />

        <div className="flex flex-nowrap items-center gap-1.5 px-2 pb-2 pt-0.5 sm:px-2.5 sm:pb-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {canAttach && (
              <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add"
                    disabled={composerDisabled || session.isBusy}
                    className={cn(
                      "composer-add-button group shrink-0 rounded-[11px] coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9",
                      plusOpen && "bg-accent",
                    )}
                  >
                    <Plus
                      aria-hidden="true"
                      strokeWidth={1.75}
                      className="composer-add-icon size-4 transition-transform duration-base ease-spring group-hover:rotate-90 motion-reduce:transform-none motion-reduce:transition-none"
                    />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-56">
                  <DropdownMenuLabel className="font-mono text-label uppercase">Add</DropdownMenuLabel>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Paperclip className="text-muted-foreground" />
                      <span className="flex-1">Attach</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-52">
                      <DropdownMenuItem onSelect={() => imageInputRef.current?.click()}>
                        <ImagePlus className="text-muted-foreground" />
                        <span className="flex-1">Photos</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                        <FileUp className="text-muted-foreground" />
                        <span className="flex-1">Files</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setLibraryOpen(true)}>
                        <Library className="text-muted-foreground" />
                        <span className="flex-1">From your library</span>
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Identity is the workspace NAME (device) or the repo (cloud); the
                device-local path is honest secondary metadata, on hover. */}
            <span
              title={isCloud ? cloudRepoFull ?? undefined : workspacePath ?? undefined}
              className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-label uppercase text-muted-foreground"
            >
              {isCloud && <Cloud className="h-3 w-3 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 truncate">{isCloud ? cloudRepoFull ?? workspaceName : workspaceName}</span>
            </span>
          </div>

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
                  "composer-primary-action h-9 w-9 rounded-[13px] coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9 transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-spring",
                  session.isBusy && session.status !== "submitting"
                    ? "w-11 rounded-[11px] ring-2 ring-primary/15"
                    : "rounded-[13px]",
                )}
              >
                {session.status === "submitting" ? (
                  <Loader2 key="submitting" className="h-4 w-4 animate-spin motion-safe:animate-fade-in" />
                ) : session.isBusy ? (
                  <Square key="stop" className="composer-stop-icon h-3.5 w-3.5 fill-current motion-safe:animate-fade-in" />
                ) : (
                  <ArrowUp key="send" className="composer-send-icon h-4 w-4 motion-safe:animate-fade-in" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{session.isBusy ? "Stop" : "Send"}</TooltipContent>
          </Tooltip>
        </div>

        <input
          ref={imageInputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {canAttach && (
          <LibraryPicker
            open={libraryOpen}
            onOpenChange={setLibraryOpen}
            onAttach={addAttachments}
            existingCount={uploads.length}
          />
        )}
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
