"use client";

import * as React from "react";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import {
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  Cloud,
  FileText,
  FileUp,
  Folder,
  GitBranch,
  GitPullRequest,
  ImagePlus,
  Library,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ComposerShell } from "@/components/ui/composer-shell";
import { Pressable } from "@/components/ui/pressable";
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
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { ThoughtPanelProvider } from "@/components/chat/thought-panel-context";
import { deviceOffersWorkspace, type DeviceRow } from "@/components/code/device-presence";
import { CodeVoicePanel, useCodeVoice, type CodeVoiceSend } from "@/components/code/code-voice";
import type { CodeVoiceBriefingInput } from "@/components/code/code-voice-briefing";
import { useApp } from "@/components/app/app-provider";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useCodeSession, isLiveId, CODE_SYNC_EVENT, type CodeAgentState, type CodeSessionStatus } from "@/hooks/use-code-session";
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

const PRESENCE_POLL_MS = 30_000;

/** The Mac that owns this session's workspace, and whether it's reachable.
 *  Gentle poll while the tab is visible; refreshes immediately on refocus.
 *
 *  `enabled` is false for a cloud session, which has no Mac in the loop at all:
 *  it used to poll /api/code/devices every 30 seconds forever, and — because a
 *  workspace matches on NAME when it has no key — a user with a synced local
 *  folder named like the repo was told "Mac connected" on a run that never
 *  touches their Mac. */
function useDevicePresence(
  workspaceKey: string | null,
  workspaceName: string | null,
  enabled: boolean,
) {
  const [presence, setPresence] = React.useState<Presence>({ state: "checking", device: null });

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/code/devices");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { devices?: DeviceRow[] };
      const candidates = (Array.isArray(data.devices) ? data.devices : [])
        .filter((d) => deviceOffersWorkspace(d, workspaceKey, workspaceName))
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
  }, [workspaceKey, workspaceName]);

  React.useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, refresh]);

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
      // Throw rather than return: the catch below is what releases `loaded`.
      if (!res.ok) throw new Error();
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
      // Keep the last reading; a device session simply stays non-cloud. But
      // mark it read: now that `loaded` gates the banner and the composer, a
      // failed lookup that left it false would park the session in "getting
      // ready" forever, with the composer disabled and no way out.
      setMeta((prev) => (prev.loaded ? prev : { ...prev, loaded: true }));
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

/*
 * FULL-STRENGTH FILLS, and that is a contrast fix rather than a taste one.
 *
 * The two most-seen states were drawn as opacity-thinned dots — /40 for checking
 * and /50 for offline and none — alphas tuned against the old 9%-lightness
 * ground. That ground is now `0 0% 0%`, where /40 composites to ~2.1:1 and /50
 * to ~2.8:1, both under the 3:1 minimum for a non-text indicator. The dot is the
 * only mark in the banner that says whether this session can run anything, so it
 * has to survive.
 *
 * `offline` takes `bg-warning`, not a grey: a Mac that exists but is asleep is a
 * recoverable blocker, and it should not read the same as `none`, which is a
 * project no Mac has ever synced.
 */
const PRESENCE_META: Record<PresenceState, { label: string; dot: string }> = {
  checking: { label: "Checking your Mac…", dot: "bg-muted-foreground motion-safe:animate-pulse" },
  online: { label: "Mac connected", dot: "bg-success" },
  offline: { label: "Mac offline", dot: "bg-warning" },
  none: { label: "No Mac has synced this project", dot: "bg-muted-foreground" },
  error: { label: "Presence unavailable", dot: "bg-warning" },
};

/*
 * The banner's status chips, one recipe. Four of them can sit on that row at
 * once — the task chip, the resolving chip, the cloud/PR chip and the presence
 * chip — and they had drifted into two families and two sizes (a mono 10px task
 * chip beside three sans 12px siblings with the same pill, border and fill).
 *
 * `bg-card` at full alpha, not `bg-card/70`: 6.5% × 0.7 is ~4.5% lightness on
 * the black ground, which is below the hairline that rings it.
 */
const BANNER_CHIP =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-1 text-xs text-muted-foreground";
/** The chip's leading dot, at the one size all four use. */
const BANNER_DOT = "h-1.5 w-1.5 shrink-0 rounded-full";

/*
 * The composer's separator, one string, both places one is needed. The comment
 * at chat/composer.tsx:2205 records what happens otherwise: two heights
 * (h-5/h-4) behind two breakpoints (min-[420px]/min-[380px]) put two different
 * separators on screen at once between 380 and 420px. This file shipped the
 * losing half of that pair.
 */
const COMPOSER_DIVIDER = "mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block";

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
  const meta = useCodeTaskMeta(conversation.id);
  const isCloud = meta.isCloud;
  /*
   * WHICH KIND OF SESSION THIS IS, IS NOT KNOWN YET.
   *
   * `meta.loaded` was declared, set and never read, so `isCloud` starting false
   * meant every cloud session opened wearing the device UI for one fetch
   * round-trip: a Folder glyph, the repo's "owner/name" printed in the mono slot
   * as if it were a path on disk, a "Checking your Mac…" pill, a composer
   * disabled with "Looking for the Mac that has this project…", and a footer
   * promising it runs on your Mac. Then it all flipped. Guessing device and
   * correcting is worse than saying we are still looking, so everything that
   * differs between the two waits here.
   */
  const resolving = !meta.loaded;
  const { presence } = useDevicePresence(
    workspaceKey,
    conversation.codeWorkspaceName?.trim() || null,
    !(meta.loaded && meta.isCloud),
  );
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
  const [dictating, setDictating] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(
    conversation.id,
  );
  const canAttach = features.storage;
  const { supported: speechSupported } = useSpeechRecognition();

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
  // presence-based gating unchanged. Neither gate can be evaluated before the
  // session's own kind is known, so until then the answer is "not yet".
  const canTarget = resolving ? false : isCloud ? !!cloudRepoFull : presence.device != null;
  const sendBlockedReason = resolving
    ? "Getting this session ready…"
    : isCloud
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

  /** Optional override lets dictate-and-send ship the transcript without
   * waiting a render for draft state.
   *
   * Resolves to whether the words actually landed on a run, which the voice
   * panel's hand-off needs: a refusal has to leave the spoken line on screen
   * rather than swallow it. `session.send` already answers that question and
   * this only forwards the answer. */
  const submit = React.useCallback(
    async (overrideText?: string): Promise<boolean> => {
      const text = (overrideText ?? draft).trim();
      const attachments = readyAttachments;
      if ((!text && attachments.length === 0) || session.isBusy || isUploading) return false;

      if (isCloud) {
        if (!meta.repoOwner || !meta.repoName) return false;
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
        return accepted;
      }

      if (!presence.device) return false;
      // The device's workspace path is authoritative when the conversation only
      // carries a name (sessions created before the path was recorded).
      const path = workspacePath ?? null;
      if (!path) return false;
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
      return accepted;
    },
    [
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
    ],
  );

  // Dictate: drop the transcript into the draft, or merge + send immediately.
  // Same append semantics as chat — existing typed text is preserved. If the
  // session can't run yet (Mac offline / no repo), park the words for edit.
  const closeDictation = React.useCallback(
    (transcript: string, sendNow: boolean) => {
      setDictating(false);
      const merged = [draft.trim(), transcript.trim()].filter(Boolean).join(" ");
      const park = () => {
        setDraft(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
      };
      if (!sendNow) {
        park();
        return;
      }
      if (!merged && readyAttachments.length === 0) {
        setDraft("");
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      const canFire =
        (isCloud ? !!cloudRepoFull : !!presence.device && !!workspacePath) &&
        !session.isBusy &&
        !isUploading;
      if (!canFire) {
        park();
        return;
      }
      void submit(merged);
    },
    [
      autoresize,
      cloudRepoFull,
      draft,
      isCloud,
      isUploading,
      presence.device,
      readyAttachments.length,
      session.isBusy,
      submit,
      workspacePath,
    ],
  );

  const composerDisabled = resolving || (isCloud ? !cloudRepoFull : !canTarget || !workspacePath);
  const hasPayload = !!draft.trim() || readyAttachments.length > 0;
  const canSend =
    hasPayload &&
    canTarget &&
    (isCloud || !!workspacePath) &&
    !session.isBusy &&
    !isUploading;

  /*
   * Voice mode, which this surface has never had — the comment that used to sit
   * on the composer said "no voice mode here, only dictate", and dictation is a
   * different thing: it types for you, where this is a conversation about the
   * run.
   *
   * Deliberately NOT gated on `composerDisabled`. That flag means the runner
   * cannot be reached — an asleep Mac, a repo still resolving — which is
   * precisely the moment somebody wants to talk through what happened, and the
   * call needs no runner at all. What it IS gated on is `resolving`: until the
   * session's own kind is known the briefing would name the wrong machine, and
   * a voice session can never be re-briefed properly (the relay seeds history
   * exactly once).
   */
  const codeVoice = useCodeVoice({ disabled: dictating || resolving });

  const voiceBriefing = React.useMemo<CodeVoiceBriefingInput>(
    () => ({
      stage: "session",
      target: resolving ? null : isCloud ? "cloud" : "device",
      place: isCloud ? cloudRepoFull : workspaceName,
      baseRef: isCloud ? meta.baseRef : null,
      // Only what a person said and what Juno Code answered. The activity
      // stream — every tool call and file write — is deliberately left out: it
      // is the bulk of a code transcript, it would eat the whole history
      // budget, and the bounding passes drop from the FRONT, so paying for it
      // would cost the section that says which repo this is.
      //
      // Walked only while a call is open. `session.messages` is a new array on
      // every streamed token, and this memo's dependency on it would otherwise
      // pay for a full transcript walk on each one, for a briefing nobody has
      // asked for.
      turns: codeVoice.open
        ? session.messages
            .filter((m) => (m.role === "USER" || m.role === "ASSISTANT") && m.content.trim())
            .map((m) => ({ role: m.role === "ASSISTANT" ? ("assistant" as const) : ("user" as const), text: m.content }))
        : [],
      blocked: sendBlockedReason,
    }),
    [cloudRepoFull, codeVoice.open, isCloud, meta.baseRef, resolving, sendBlockedReason, session.messages, workspaceName],
  );

  const voiceSend = React.useMemo<CodeVoiceSend>(
    () => ({
      intent: "send",
      // The composer's own gate sentences, in the composer's own words — a
      // second wording for the same refusal reads as a second rule.
      blockedReason: sendBlockedReason
        ? sendBlockedReason
        : session.isBusy
          ? "Juno Code is working on this. Wait for it to finish, or stop it first."
          : isUploading
            ? "Still uploading the attached files."
            : null,
      sending: session.status === "submitting",
      // Merge, never replace. `submit(overrideText)` sends the override and
      // then clears `draft` regardless — so handing it the spoken text alone
      // sent the sentence you said and DESTROYED the one you had typed, with no
      // undo and nothing on screen to say it had happened. Same rule the
      // dictation path already follows: what you typed survives, the spoken
      // words are appended to it.
      onSend: (text: string) => submit([draft.trim(), text.trim()].filter(Boolean).join(" ")),
    }),
    [draft, isUploading, sendBlockedReason, session.isBusy, session.status, submit],
  );

  // Nothing written → the primary action opens the conversation instead of
  // sitting there disabled. Keyed on the payload, not on `canSend`: with words
  // in the field and an unreachable Mac, `canSend` is false too, and swapping
  // Send for a phone call there would hide the control whose disabled state is
  // the only thing pointing at the problem.
  const showVoiceButton = !session.isBusy && !hasPayload && !!codeVoice.onOpenVoiceMode;

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
  // Neither promise is safe to make before the session's kind is known — see
  // `resolving`. What both halves say is the half that is always true.
  const footerNote = resolving
    ? "Review the changes before you ship them."
    : isCloud
      ? "Runs in the cloud and opens a pull request — review the changes before you merge them."
      : "Runs with Juno Code on your Mac — review the changes before you ship them.";

  /*
   * THE RUN TRACE HAD NO WAY TO OPEN.
   *
   * MessageItem → ActivityTimeline renders a full pressable row — hover fill,
   * sliding chevron, aria-expanded, "Open run details" — whose click calls
   * `panel.setOpenId`, where `panel` is `useThoughtPanel()`. Only chat-view
   * mounted the provider, so on this surface `panel` was null and the most
   * clicked control in a coding transcript was a guaranteed no-op. Everything
   * Juno Code actually did — every tool call, every file change, every approval
   * — is folded into that trace and was unreachable.
   *
   * The dock is a column, so its DOM must be a sibling of the transcript
   * column; ActivityTimeline portals the panel into `container`. Same contract
   * as chat-view, minus the drag-to-resize: the width that matters here is the
   * one chat-view uses undragged.
   */
  const [thoughtOpenId, setThoughtOpenId] = React.useState<string | null>(null);
  const [thoughtContainer, setThoughtContainer] = React.useState<HTMLDivElement | null>(null);
  const thoughtPanel = React.useMemo(
    () => ({ openId: thoughtOpenId, setOpenId: setThoughtOpenId, container: thoughtContainer }),
    [thoughtOpenId, thoughtContainer],
  );
  // Self-heal, for the reason chat-view reconciles too: the dock is raw state
  // naming a message, and this surface swaps ids under it routinely — the live
  // streaming bubble is REPLACED by its persisted row when a run settles, which
  // unmounts the ActivityTimeline holding the panel and its only close button.
  // What would be left is an empty card column covering the whole screen below lg.
  React.useEffect(() => {
    if (!thoughtOpenId) return;
    if (!session.messages.some((m) => m.id === thoughtOpenId)) setThoughtOpenId(null);
  }, [session.messages, thoughtOpenId]);
  // Esc closes it — a docked, non-modal panel gets none of a dialog's dismissal
  // for free. Only if a nearer layer hasn't already claimed the key.
  React.useEffect(() => {
    if (!thoughtOpenId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setThoughtOpenId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [thoughtOpenId]);

  /*
   * WHAT THE RUN CHANGED, which the footer promises you can review and the
   * surface offered nowhere to do.
   *
   * Read back out of the transcript's activity rather than from the task
   * stream, because `useCodeSession` folds `file_change` events straight into
   * display strings ("edit src/foo.ts", "+3 −1") and keeps no structured list.
   * That is why the path is recovered with a split: the producer composes
   * `${changeKind} ${path}`, and a path cannot contain the first space. Latest
   * write per path wins, so a file touched four times is one row with its
   * final churn — this is a summary of the result, not a log.
   */
  const fileChanges = React.useMemo(() => {
    const byPath = new Map<string, { path: string; changeKind: string; churn: string | null }>();
    for (const message of session.messages) {
      for (const event of message.activity ?? []) {
        if (event.kind !== "write") continue;
        const space = event.title.indexOf(" ");
        const changeKind = space === -1 ? "edit" : event.title.slice(0, space);
        const path = space === -1 ? event.title : event.title.slice(space + 1);
        byPath.set(path, { path, changeKind, churn: event.detail ?? null });
      }
    }
    return [...byPath.values()];
  }, [session.messages]);

  /*
   * A FAILED RUN WAS A DEAD END. MessageItem offers its "Try again" only when
   * `onRegenerate` is supplied, and this surface supplied neither that nor
   * `onEdit` — so the only way back from a failure was retyping the prompt,
   * which the composer cleared on send. One screen earlier, /code/new's own
   * dispatch failure has exactly this button.
   *
   * Re-dispatch when the session can run, and otherwise put the words back in
   * the composer — a Mac that went offline mid-run is the common case, and the
   * prompt waiting in the field is the honest outcome there.
   */
  const retryLastPrompt = React.useCallback(() => {
    const lastUser = [...session.messages].reverse().find((m) => m.role === "USER");
    const text = lastUser?.content.trim();
    if (!text) return;
    const canFire = canTarget && (isCloud || !!workspacePath) && !session.isBusy && !isUploading;
    if (canFire) {
      void submit(text);
      return;
    }
    setDraft(text);
    requestAnimationFrame(() => {
      autoresize();
      textareaRef.current?.focus();
    });
  }, [autoresize, canTarget, isCloud, isUploading, session.isBusy, session.messages, submit, workspacePath]);

  // Queue copy, and the same sentence the live region reads out below.
  const queuedNote =
    session.status !== "queued"
      ? null
      : isCloud
        ? "Queued — starting a cloud machine (this can take a moment)…"
        : presence.state === "offline"
          ? "Queued — runs when your Mac reconnects."
          : "Queued — waiting for your Mac to pick this up.";

  const composer = (
    <div className="mx-auto w-full max-w-[calc(100vw-1.5rem)] px-0 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-[48rem] sm:px-4">
      {/* ALWAYS MOUNTED. A live region inserted at the same moment its text
          appears is frequently never announced at all (chat/approval-card makes
          the same argument), and the approval card's own sr-only span did
          exactly that — so the one moment Juno Code blocks and needs an answer
          was likely to pass in silence. This region outlives every state it
          reports on, including the queue banner, which had the same shape. */}
      <p role="status" aria-live="polite" className="sr-only">
        {session.pendingApproval
          ? `Juno Code needs your approval to: ${session.pendingApproval.summary}.${
              session.pendingApproval.risk === "destructive"
                ? " This is a destructive action."
                : session.pendingApproval.risk === "outside"
                  ? " This affects files outside the workspace."
                  : ""
            } Deny or Allow below.`
          : (queuedNote ?? "")}
      </p>
      {fileChanges.length > 0 && <ChangedFiles files={fileChanges} />}
      {session.agents.length > 0 && <AgentCards agents={session.agents} />}
      {session.pendingApproval && (
        <ApprovalCard
          summary={session.pendingApproval.summary}
          risk={session.pendingApproval.risk}
          detail={session.pendingApproval.detail}
          responding={session.responding}
          onRespond={(approve) => void session.respond(session.pendingApproval!.requestId, approve)}
        />
      )}
      {queuedNote && (
        // `bg-muted` at full alpha, `px-3 py-2.5` — the one fill and the one
        // inset every card stacked above the composer now shares. The three of
        // them used to be 3.8%, 3.8% and 4.3% lightness: three fills for one
        // elevation rung, all of them BELOW the `bg-card` composer they sit on.
        <p className="mx-1 mb-2 flex items-center gap-2 rounded-field border border-border/70 bg-muted px-3 py-2.5 text-xs text-muted-foreground motion-safe:animate-rise-in">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground motion-safe:animate-pulse" aria-hidden="true" />
          {queuedNote}
        </p>
      )}
      {/*
        THE SECOND TIER — on the one surface <ComposerShell>'s own header names
        as the one that omits it ("the Code session composer, where the run
        target is fixed the moment the session exists").

        That reads the tier as being about what can be CHANGED. It is about what
        SURVIVES THE SEND, and this composer had the other half of the same
        mistake: the run target sat in the inline row's LEFT CLUSTER, one gap
        away from the [+], as `flex-1` — so "this session runs against
        acme/web" and "attach a file to this message" were drawn at identical
        weight, and a long repo name squeezed the attach button rather than the
        row admitting it was carrying two different kinds of thing. Read-only is
        not a reason to omit the tier; read-only facts are exactly what a tier
        this quiet is for.
      */}
      <div className="composer-aura-host relative isolate w-full">
        {/* Sibling of the composer, never a wrapper: the voice field paints at
            `z-index: -1`, and the `isolate` above is the floor it is allowed to
            fall to. No idle bloom on this surface — a transcript sits above the
            composer, so the only light here is a live call. */}
        {codeVoice.open && (
          <CodeVoicePanel briefing={voiceBriefing} send={voiceSend} onClose={codeVoice.close} />
        )}

        {/* Composer ⇄ Dictation share one grid cell and cross-fade. */}
        <div
          className={cn(
            "relative grid w-full grid-cols-1 grid-rows-1 items-center justify-items-center transition-[min-height] duration-slow ease-spring motion-reduce:transition-none",
            dictating ? "min-h-[170px]" : "min-h-[68px]",
          )}
        >
          <div
            // `inert` is what actually takes this half of the cross-fade out of the
            // page. `opacity-0 pointer-events-none` hides it from the eye and the
            // mouse and leaves it in the tab order and the accessibility tree, so a
            // keyboard or screen-reader user could reach a composer that is not on
            // screen — and, mid-dictation, type into it. Same defect the chat
            // transcript's jump-to-latest button had.
            inert={!dictating}
            className={cn(
              "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-spring motion-reduce:transition-none",
              dictating ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-1 scale-95 opacity-0",
            )}
          >
            {dictating && (
              <ComposerDictation
                onCancel={() => setDictating(false)}
                onStop={(t) => closeDictation(t, false)}
                onSend={(t) => closeDictation(t, true)}
              />
            )}
          </div>

          {/*
            The cross-fade and the drop target sit on this wrapper, not on the
            shell. <ComposerShell> owns a `transition-[border-color,box-shadow]`
            already, and a second `transition-[opacity,transform,…]` on the same
            element is two `transition-property` declarations at equal
            specificity — which one survives would be decided by Tailwind's emit
            order rather than by anything written here. It also lets the drop
            overlay cover both tiers: `absolute inset-0` inside the shell reaches
            only one slot, and the shell cannot clip.
          */}
          <div
            onDragOver={(e) => {
              if (!canAttach || composerDisabled || dictating) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (canAttach && !composerDisabled && !dictating && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
            }}
            // `inert` is what actually takes this half of the cross-fade out of the
            // page. `opacity-0 pointer-events-none` hides it from the eye and the
            // mouse and leaves it in the tab order and the accessibility tree, so a
            // keyboard or screen-reader user could reach a composer that is not on
            // screen — and, mid-dictation, type into it. Same defect the chat
            // transcript's jump-to-latest button had.
            inert={dictating}
            className={cn(
              "col-start-1 row-start-1 relative w-full origin-center",
              "transition-[opacity,transform] duration-base ease-spring motion-reduce:transition-none",
              dictating ? "pointer-events-none -translate-y-1 scale-[0.97] opacity-0" : "translate-y-0 scale-100 opacity-100",
            )}
          >
            <ComposerShell
              className={cn("max-h-[600px]", dragging && "border-primary/55 ring-2 ring-primary/20")}
              utilityLabel="Where this session runs"
              above={
                canAttach && (
                  <div
                    // `motion-reduce:transition-none`, which the identical
                    // grid-rows collapse in ChangedFiles below already carries.
                    // Without it the one collapse a user sees on every attach
                    // was the only one in the file that ignored the setting.
                    className={cn(
                      "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
                      uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                    )}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="flex flex-wrap gap-2 p-3 pb-0">
                        {uploads.map((u) => (
                          <div
                            key={u.localId}
                            className={cn(
                              // `bg-muted`, not `bg-background`: this chip sits
                              // INSIDE ComposerShell's `bg-card`, and on true
                              // black a background-filled chip punches a
                              // 0%-lightness hole into a 6.5% panel. It also
                              // takes the shell's own seated-control radius
                              // rather than a stray `rounded-md`. `shadow-soft`
                              // is gone — it is black ink on black here.
                              "group relative flex items-center gap-2 rounded-composer-control border border-border/60 bg-muted px-2.5 py-2 text-xs",
                              removingIds.includes(u.localId)
                                ? "pointer-events-none motion-safe:animate-pop-out"
                                : "motion-safe:animate-rise-in",
                            )}
                          >
                            {u.attachment?.kind === "IMAGE" ? (
                              <Image src={u.attachment.url} unoptimized={requiresViewerCredentials(u.attachment.url)} alt={u.fileName} width={32} height={32} className="h-8 w-8 rounded-sm object-cover" />
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
                            {/* `bg-secondary`, not `bg-foreground`. A
                                94%-lightness disc on a 0% ground made a 20px
                                micro-control the single brightest object on the
                                screen; the hairline is what shapes it now, and
                                `shadow-soft` — black on black here — is gone. */}
                            <button
                              type="button"
                              onClick={() => removeUpload(u.localId)}
                              className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-secondary p-0.5 text-foreground opacity-0 transition-[opacity,background-color,border-color,color] duration-fast ease-out-soft group-hover:opacity-100 hover:border-destructive hover:bg-destructive hover:text-destructive-foreground focus-visible:opacity-100 coarse:-right-2.5 coarse:-top-2.5 coarse:p-1.5 coarse:opacity-100"
                              aria-label="Remove attachment"
                            >
                              <X className="h-3 w-3 coarse:h-4 coarse:w-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              }
              field={
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
                  // The height eased here is real layout movement — the whole
                  // composer, and everything stacked on it, rises as you type —
                  // so it needs the same reduced-motion escape every other
                  // transition on this surface carries.
                  //
                  // PLACEHOLDER AT FULL --muted-foreground, and on this surface
                  // that is not a nicety. input.tsx, textarea.tsx and select.tsx
                  // each removed `/70` with a note recording it as a 2.91:1
                  // contrast failure against a token tuned to 5.3:1. Here the
                  // placeholder is also the error channel — `sendBlockedReason`
                  // renders through it ("Open this project in the Juno app on
                  // your Mac…") — and `disabled:opacity-70` is live at exactly
                  // that moment, so the one sentence explaining why the session
                  // cannot run was being drawn at ~0.49 of the token.
                  className="max-h-[200px] min-h-[64px] w-full resize-none bg-transparent px-4 pb-3 pt-4 text-[1rem] leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 motion-reduce:transition-none sm:px-[18px] sm:pt-[17px]"
                />
              }
              controls={
                <>
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
                              "composer-add-button group shrink-0 rounded-composer-control coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9",
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
                          <DropdownMenuLabel className="font-mono text-label">Add</DropdownMenuLabel>
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
                  </div>

                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {speechSupported && (
                      <>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setDictating(true)}
                              // A live call already holds the microphone — the
                              // same interlock every other composer keeps
                              // between dictation and voice.
                              disabled={composerDisabled || session.isBusy || dictating || codeVoice.open}
                              aria-label="Dictate"
                              aria-pressed={dictating}
                              className="composer-mic-button rounded-composer-control coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9"
                            >
                              <Mic className="composer-mic-icon h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Dictate</TooltipContent>
                        </Tooltip>
                        <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                      </>
                    )}

                    {/* One button, three jobs: stop the run, send the next
                        instruction, or — with nothing written — open a
                        conversation about what the run did. Same morph as chat
                        and the Work thread, so the gesture is one gesture
                        across the product. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          onClick={
                            session.isBusy
                              ? () => void session.cancel()
                              : showVoiceButton && codeVoice.onOpenVoiceMode
                                ? codeVoice.onOpenVoiceMode
                                : () => void submit()
                          }
                          disabled={
                            session.isBusy
                              ? session.status === "stopping" || session.status === "submitting"
                              : showVoiceButton
                                ? false
                                : !canSend
                          }
                          aria-label={
                            session.isBusy
                              ? session.status === "stopping"
                                ? "Stopping task"
                                : "Stop this task"
                              : showVoiceButton
                                ? "Talk this session through with Juno"
                                : isCloud
                                  ? "Start a cloud run"
                                  : "Send to your Mac"
                          }
                          className={cn(
                            "composer-primary-action h-9 w-9 rounded-composer-action coarse:h-11 coarse:w-11 max-[359px]:coarse:!w-9 transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-spring",
                            // ring-primary/30, not /15: the halo that says "this
                            // is now a stop button" was ~2% lightness against
                            // the black ground and did not read at all.
                            session.isBusy && session.status !== "submitting"
                              ? "w-11 rounded-composer-control ring-2 ring-primary/30"
                              : "rounded-composer-action",
                          )}
                        >
                          {session.status === "submitting" ? (
                            <Loader2 key="submitting" className="h-4 w-4 animate-spin motion-safe:animate-fade-in" />
                          ) : session.isBusy ? (
                            <Square key="stop" className="composer-stop-icon h-3.5 w-3.5 fill-current motion-safe:animate-fade-in" />
                          ) : showVoiceButton ? (
                            <span key="voice" className="composer-voice-wave motion-safe:animate-fade-in" aria-hidden="true">
                              <span />
                              <span />
                              <span />
                              <span />
                              <span />
                            </span>
                          ) : (
                            <ArrowUp key="send" className="composer-send-icon h-4 w-4 motion-safe:animate-fade-in" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {session.isBusy ? "Stop" : showVoiceButton ? "Voice conversation" : "Send"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </>
              }
              utility={
                <>
                  {/* Identity is the workspace NAME (device) or the repo
                      (cloud); the device-local path stays honest secondary
                      metadata, on hover. While `resolving` neither can be
                      claimed, so the strip says only that. */}
                  <span
                    title={isCloud ? cloudRepoFull ?? undefined : workspacePath ?? undefined}
                    className="flex min-w-0 items-center gap-1.5 font-mono"
                  >
                    {resolving ? (
                      <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
                    ) : isCloud ? (
                      <Cloud className="size-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <Folder className="size-3 shrink-0" aria-hidden="true" />
                    )}
                    {/* The glyph carries "device or cloud" for everyone who can
                        see it; this is the same fact for everyone who cannot.
                        Suppressed while resolving, where the following text is
                        a sentence and "Runs in Getting this session ready" is
                        not one. */}
                    {!resolving && <span className="sr-only">Runs in </span>}
                    <span className="min-w-0 truncate">
                      {resolving ? "Getting this session ready…" : isCloud ? cloudRepoFull ?? workspaceName : workspaceName}
                    </span>
                  </span>
                  {!resolving && isCloud && meta.baseRef && (
                    <>
                      <span className={COMPOSER_DIVIDER} aria-hidden="true" />
                      <span className="flex min-w-0 items-center gap-1 font-mono">
                        <GitBranch className="size-3 shrink-0" aria-hidden="true" />
                        <span className="sr-only">Base branch </span>
                        <span className="min-w-0 truncate">{meta.baseRef}</span>
                      </span>
                    </>
                  )}
                </>
              }
            />

            {dragging && (
              // `rounded-composer` alone. The `sm:rounded-lg` override restated
              // the shell's corner in a second file (and a third, on /code/new),
              // so the overlay stopped tracing the shell the moment the token
              // moved — which it just did, to 26px.
              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-composer border-2 border-dashed border-primary/45 bg-primary/15 backdrop-blur-sm motion-safe:animate-fade-in">
                <FileUp className="h-6 w-6 text-primary" />
                <span className="font-mono text-label text-primary">Drop to attach</span>
              </div>
            )}

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
      </div>
    </div>
  );

  return (
    <ThoughtPanelProvider value={thoughtPanel}>
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* Session banner. Device: which project, on which Mac, reachable or not.
          Cloud: the repo + a calm "runs in the cloud, opens a PR" note (no
          device-offline/queue copy), plus the PR link once the run opens one.
          While `resolving`, it says only what is true of both. */}
      {/* `bg-background` flat: the translucency bought nothing — this row is
          `shrink-0` in a flex column, so nothing scrolls beneath it, and on a
          0%-lightness ground a 5% bleed is unobservable. The bottom hairline is
          `border-border` at full strength for the same reason; at /60 it was
          9.6% lightness, the faintest edge on the surface doing the most work. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2 md:px-4">
        {/* `bg-primary/20 border-primary/45` — at /10 and /25 the fill was ~2%
            lightness and the border ~4%, so the badge vanished and only the 12px
            glyph inside it survived. Same recipe as the PR chip below, so the
            banner's two coral elements are one object. */}
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-primary/45 bg-primary/20">
          {resolving ? (
            <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden="true" />
          ) : isCloud ? (
            <Cloud className="h-3 w-3 text-primary" aria-hidden="true" />
          ) : (
            <Folder className="h-3 w-3 text-primary" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {isCloud ? cloudRepoFull ?? workspaceName : workspaceName}
        </span>
        {/* The mono slot is a LOCAL PATH on the device side. A cloud session's
            codeWorkspacePath is "owner/name", so printing it before the kind is
            known dressed a repo up as a folder on your disk. */}
        {resolving
          ? null
          : isCloud
          ? meta.baseRef && (
              <span className="hidden min-w-0 truncate font-mono text-caption text-muted-foreground sm:inline">
                on {meta.baseRef}
              </span>
            )
          : workspacePath && (
              <span className="hidden min-w-0 truncate font-mono text-caption text-muted-foreground sm:inline">
                {workspacePath}
              </span>
            )}
        <span className="flex-1" />
        {taskChip && (
          <span className={cn(BANNER_CHIP, "motion-safe:animate-fade-in")}>
            <span
              className={cn(
                BANNER_DOT,
                session.status === "running"
                  ? "bg-success motion-safe:animate-pulse"
                  : session.status === "awaiting_approval"
                    ? "bg-warning"
                    : "bg-muted-foreground",
              )}
              aria-hidden="true"
            />
            {taskChip}
          </span>
        )}
        {resolving ? (
          <span role="status" className={BANNER_CHIP}>
            <span className={cn(BANNER_DOT, "bg-muted-foreground motion-safe:animate-pulse")} aria-hidden="true" />
            <span className="min-w-0 truncate">Getting this session ready…</span>
          </span>
        ) : isCloud ? (
          meta.prUrl ? (
            // The banner's only call to action, and at `bg-primary/10` its fill
            // composited to roughly 2% lightness on black — the chip collapsed
            // into bare coral text inside a faint outline. /20 makes it a chip
            // again, and hover has to step UP from there, not down to /15.
            <a
              href={meta.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pressable inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/45 bg-primary/20 px-2.5 py-1 text-xs font-medium text-primary hover:border-primary/60 hover:bg-primary/30 motion-safe:animate-fade-in"
            >
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
              View pull request
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : (
            <span role="status" className={BANNER_CHIP}>
              <Cloud className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">Runs in the cloud · opens a pull request</span>
            </span>
          )
        ) : (
          <span role="status" title={presence.device?.name} className={BANNER_CHIP}>
            <span className={cn(BANNER_DOT, presenceMeta.dot)} aria-hidden="true" />
            <span className="min-w-0 truncate">{presenceMeta.label}</span>
          </span>
        )}
      </div>

      {/* Transcript column ⇄ thought dock. Below lg the dock replaces the
          transcript entirely, the precedent chat-view sets for both of its
          docked columns: a split there leaves the transcript narrower than a
          phone. */}
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "relative flex h-full min-h-0 min-w-0 flex-1 flex-col",
            thoughtOpenId && "hidden lg:flex",
          )}
        >
          {hasMessages ? (
            <>
              <MessageList
                messages={session.messages}
                busy={session.isBusy}
                status={listStatus}
                artifacts={[]}
                onOpenArtifact={() => {}}
                onFeedback={session.setFeedback}
                // Live bubbles are client-side until the run's row comes back.
                canFeedback={(m) => !isLiveId(m.id)}
                // The transcript's only <h1>. Omitted, it fell back to the
                // literal "Conversation" — on a surface where the workspace or
                // repo IS what a reader is orienting by, and where the prop
                // exists precisely to stop that.
                conversationTitle={isCloud ? cloudRepoFull ?? workspaceName : workspaceName}
                onRegenerate={retryLastPrompt}
              />
              <div className="w-full px-0 pb-1">{composer}</div>
              <p className="shrink-0 select-none pb-2 text-center text-caption text-muted-foreground">
                {footerNote}
              </p>
            </>
          ) : (
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-3 py-6 sm:px-5 md:py-10">
                <div className="mb-5 flex w-full flex-col items-center text-center sm:mb-6">
                  {/* text-display alone: `text-3xl` is a raw Tailwind default
                      that is not on the product type scale, and pinning it
                      below sm defeated the token, whose clamp already does the
                      responsive work — the breakpoint made small viewports
                      smaller than the scale intends. */}
                  <h1 className="font-serif text-display font-normal tracking-tight text-foreground">
                    {isCloud ? cloudRepoFull ?? workspaceName : workspaceName}
                  </h1>
                  <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground sm:text-base">
                    {resolving
                      ? "Describe what to build or fix — Juno Code streams the work here."
                      : isCloud
                        ? "Describe what to build or fix — the run happens in the cloud and opens a pull request you can review."
                        : "Describe what to build or fix — Juno Code runs it on your Mac and streams the work here."}
                  </p>
                </div>
                <div className="z-10 w-full max-w-[44rem]">{composer}</div>
              </div>
              <p className="shrink-0 select-none pb-2 text-center text-caption text-muted-foreground">
                {footerNote}
              </p>
            </div>
          )}
        </div>

        {/* The dock itself — a real column, not an overlay: the transcript
            narrows beside it and stays readable and typeable. ActivityTimeline
            portals the panel in here (see thought-panel-context). */}
        {thoughtOpenId && (
          <div
            ref={setThoughtContainer}
            // No z-index. `z-40` was a number picked outside the
            // z-popper/modal/toolbar/toast scale, and it bought nothing: this is
            // an in-flow flex sibling that already paints after the transcript
            // column. Naming a layer here would instead put the dock over the
            // composer's own portalled dropdowns, which sit at z-popper.
            className="relative h-full w-full shrink-0 border-border bg-card duration-base ease-out-expo motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 lg:w-[30rem] lg:min-w-0 lg:border-l"
          />
        )}
      </div>
    </div>
    </ThoughtPanelProvider>
  );
}

/**
 * WHAT THE RUN CHANGED.
 *
 * Both footers on this surface promise you can "review the changes", and until
 * now the surface offered nowhere to do it: file changes arrive as real events
 * with a path, a change kind and +added/−removed, and their only destination
 * was a run trace with no way to open (see the dock above). A path-and-churn
 * list is not a diff, but it is the run's actual output, and it makes the
 * promise in the footer true.
 *
 * Collapsed by default: it sits directly above the composer, and a fifty-file
 * run must not push the prompt off screen.
 */
function ChangedFiles({ files }: { files: { path: string; changeKind: string; churn: string | null }[] }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  return (
    <section
      aria-label="Files this session changed"
      // p-0.5 is what makes the row's own rounded-control (9px) concentric
      // inside this rounded-field (10px) shell: outer = inner + padding.
      //
      // `bg-muted` at full alpha. At /40 this panel was ~3.8% lightness on the
      // black ground while the ComposerShell it sits directly on top of is
      // `bg-card` at 6.5% — the run summary rendered DARKER than the input
      // below it. The stack now lifts: background 0% → composer 6.5% → run
      // cards 9.5%.
      className="mx-1 mb-2 rounded-field border border-border/70 bg-muted p-0.5 motion-safe:animate-rise-in"
    >
      <Pressable
        kind="row"
        size="sm"
        aria-expanded={open}
        // The list is now always in the document (it collapses rather than
        // unmounting), so this can point at it unconditionally — previously it
        // had to be dropped while closed to avoid naming an absent id.
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        // ~30px otherwise, on the only disclosure above a composer whose every
        // other control carries `coarse:h-11`.
        className="coarse:min-h-11"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast ease-out-soft motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        <span className="font-mono text-label text-muted-foreground">
          {files.length === 1 ? "1 file changed" : `${files.length} files changed`}
        </span>
      </Pressable>
      {/*
        The same grid/`grid-template-rows` collapse the attachment tray in this
        component already uses. As `{open && <ul>}` the list snapped in
        instantly while its own chevron rotated over `duration-fast` — the
        disclosure and the thing it disclosed were animating to two different
        rules.

        `aria-hidden` while closed because the rows stay in the document for the
        transition to have something to animate; without it a screen reader
        would read out a file list the disclosure says is collapsed.
      */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <ul id={listId} aria-hidden={!open} className="space-y-1 px-2.5 pb-2 pt-1">
            {files.map((file) => (
              <li key={file.path} className="flex items-baseline gap-2 text-caption">
                <span className="shrink-0 font-mono text-muted-foreground">{file.changeKind}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={file.path}>
                  {file.path}
                </span>
                {file.churn && (
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{file.churn}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** An agent follow-up question: approve or deny the proposed action. The Mac
 *  waits up to five minutes, then denies on its own (native host behavior). */
/** Live cards for delegated child agents (multi-agent cloud runs): role,
 *  task, real state, current activity, files, and conflict warnings. No fake
 *  progress — only what the runner actually reported. */
function AgentCards({ agents }: { agents: CodeAgentState[] }) {
  const STATUS_TONE: Record<string, string> = {
    completed: "text-success",
    failed: "text-destructive",
    cancelled: "text-muted-foreground",
    interrupted: "text-muted-foreground",
    waiting_approval: "text-warning",
  };
  const active = agents.some((a) => !["completed", "failed", "cancelled", "interrupted"].includes(a.status));
  return (
    <section
      aria-label="Helper agents"
      // `bg-muted` + `px-3 py-2.5`, matching ChangedFiles and the queued note —
      // see the fill note there. This card repeated the same recessed /40.
      className="mx-1 mb-2 rounded-field border border-border/70 bg-muted px-3 py-2.5 motion-safe:animate-rise-in"
    >
      <p className="mb-1.5 flex items-center gap-2 font-mono text-label text-muted-foreground">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            active ? "bg-primary motion-safe:animate-pulse" : "bg-muted-foreground",
          )}
          aria-hidden="true"
        />
        Agents
      </p>
      <ul className="flex flex-col gap-1.5">
        {agents.map((agent) => {
          const status = typeof agent.status === "string" ? agent.status : "unknown";
          const tone = STATUS_TONE[status] ?? "text-foreground/80";
          const tokens =
            agent.usage && Number.isFinite(agent.usage.inputTokens + agent.usage.outputTokens)
              ? agent.usage.inputTokens + agent.usage.outputTokens
              : 0;
          return (
            <li key={agent.id} className="flex flex-col gap-0.5 text-xs">
              <span className="flex items-baseline gap-2">
                <span className="font-medium capitalize text-foreground">{agent.role}</span>
                <span className="truncate text-foreground/80">{agent.title}</span>
                <span className={cn("ml-auto shrink-0 font-mono text-caption", tone)}>
                  {status.replace("_", " ")}
                </span>
              </span>
              <span className="flex items-baseline gap-2 text-caption text-muted-foreground">
                <span className="truncate">
                  {agent.status === "failed" && agent.error ? agent.error : agent.currentActivity ?? ""}
                </span>
                {tokens > 0 && (
                  // tabular-nums: this counter ticks up in place while the agent
                  // runs, and proportional digits make the row jitter sideways.
                  <span className="ml-auto shrink-0 font-mono tabular-nums">
                    {tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tok
                  </span>
                )}
              </span>
              {agent.filesChanged && agent.filesChanged.length > 0 && (
                <span className="text-caption text-muted-foreground">
                  {agent.applied ? "applied" : "proposed"}: {agent.filesChanged.join(", ")}
                </span>
              )}
              {agent.conflictedFiles && agent.conflictedFiles.length > 0 && (
                <span className="text-caption text-warning">
                  conflicts with your checkout: {agent.conflictedFiles.join(", ")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
      // `bg-warning/10` — the alpha globals.css names as the product's warning
      // chip. At /5 the highest-stakes surface in Juno Code was a ~1%-lightness
      // tint on the black ground, leaving `border-warning/40` to carry the whole
      // alarm on its own. Inset matches the sibling cards above the composer.
      className="mx-1 mb-2 space-y-2.5 rounded-field border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm motion-safe:animate-rise-in"
    >
      {/* The announcement lives in the composer wrapper, permanently mounted —
          a live region that appears with its text is frequently not announced. */}
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground">
            <span className="text-muted-foreground">Juno Code wants to: </span>
            <span className="font-medium">{summary}</span>
          </p>
          {detail && (
            // rounded-xs, not rounded-lg: `lg` is the legacy alias for 24px, so
            // this block's corner was twice the 12px card holding it, inside
            // ~6px of inset. Concentric wants inner = outer − padding.
            //
            // `bg-muted/60` RAISES the well instead of darkening it: recessing
            // by darkening has no headroom left on a 0%-lightness ground, so the
            // old `bg-background/60` read as a hole punched in the card rather
            // than an inset. `tabIndex={0}` because this region scrolls, and a
            // scrollable region no keyboard can reach is a scrollable region a
            // keyboard user cannot read the end of.
            <pre
              tabIndex={0}
              className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-xs border border-border/60 bg-muted/60 px-2.5 py-2 font-mono text-caption leading-5 text-muted-foreground"
            >
              {detail}
            </pre>
          )}
        </div>
        {(risk === "destructive" || risk === "outside") && (
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 font-mono text-caption",
              risk === "destructive"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-warning/40 bg-warning/10 text-warning-foreground"
            )}
          >
            {risk === "destructive" ? "Destructive" : "Outside workspace"}
          </span>
        )}
      </div>
      {/* REFUSE FIRST, AT EQUAL WEIGHT — the rule the shared approval card
          states and this one inverted. Leading with a primary Allow answers for
          a reader who is here precisely to stop and think, and colouring that
          Allow `destructive` on the highest-risk prompt on the surface made red
          mean "go ahead" here and "refuse" one screen over. The risk badge
          above already carries the danger; the buttons carry the choice. Both
          at h-11, matching chat/approval-card — `size="sm"` gave a 40px target
          to the one control in Juno Code that must not be mis-tapped. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="destructive-outline"
          disabled={responding}
          onClick={() => onRespond(false)}
          className="h-11 px-4"
        >
          Deny
        </Button>
        <Button type="button" disabled={responding} onClick={() => onRespond(true)} className="h-11 gap-1.5 px-4">
          {responding && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Allow
        </Button>
        <span className="text-caption text-muted-foreground">Your Mac denies automatically after 5 minutes.</span>
      </div>
    </div>
  );
}
