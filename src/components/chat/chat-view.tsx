"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpRight, Box, GitFork, GripVertical, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/use-chat";
import { useTts } from "@/hooks/use-tts";
import { useApp } from "@/components/app/app-provider";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { EmptyGreeting, SuggestionPills } from "@/components/chat/empty-state";
import { PrivateChatToggle } from "@/components/chat/private-chat-toggle";
import { ModelParamsPanel } from "@/components/chat/model-params-panel";
import { CanvasPanel } from "@/components/canvas/canvas-panel";
import { VoiceMode } from "@/components/voice/voice-mode";
import { RealtimeVoice } from "@/components/voice/realtime-voice";
import { resolveModel, type ModelId, DEFAULT_MODEL } from "@/lib/models";
import { STEP_LAB_DEMO_MESSAGE } from "@/lib/step-lab-fixture";
import { PLANS } from "@/lib/plans";
import { cleanForSpeech } from "@/lib/message-content";
import { cn } from "@/lib/utils";
import type { ComposerQuote } from "@/lib/quote-context";
import type { ClientArtifact, ClientMessage, ClientConversation, ReasoningEffort, TitleSource } from "@/types/chat";

interface ChatViewProps {
  conversationId: string | null;
  initialMessages: ClientMessage[];
  initialArtifacts: ClientArtifact[];
  initialModel: string;
  projectId?: string;
  initialPrompt?: string;
}

type AutoTitlePhase = "first_user" | "thinking" | "writing" | "completed" | "stopped";
const CANVAS_WIDTH_KEY = "juno:canvas-width";
const CANVAS_MIN_WIDTH = 420;
const CHAT_MIN_WIDTH = 320;

function canvasWidthBounds(containerWidth: number) {
  const minWidth = Math.min(CANVAS_MIN_WIDTH, Math.max(320, containerWidth - CHAT_MIN_WIDTH));
  const maxByChat = containerWidth - CHAT_MIN_WIDTH;
  const maxWidth = Math.max(minWidth, Math.min(Math.round(containerWidth * 0.82), maxByChat));
  return { minWidth, maxWidth };
}

function clampCanvasWidth(width: number, containerWidth?: number) {
  if (typeof window === "undefined") return width;
  const availableWidth = containerWidth ?? window.innerWidth;
  const { minWidth, maxWidth } = canvasWidthBounds(availableWidth);
  return Math.min(Math.max(width, minWidth), maxWidth);
}

// A fork carries the transcript up to the fork point into a fresh, unsaved
// branch. It rides the private-mode transport (full history is sent with each
// request) so the model keeps context without any server-side copy.
const FORK_STORAGE_KEY = "juno:fork";
type ForkPayload = { title: string; messages: ClientMessage[] };

function titleMessages(messages: ClientMessage[]): { role: "USER" | "ASSISTANT"; content: string }[] {
  return messages
    .filter((m) => (m.role === "USER" || m.role === "ASSISTANT") && m.content.trim())
    .slice(0, 8)
    .map((m) => ({ role: m.role as "USER" | "ASSISTANT", content: m.content.slice(0, 4000) }));
}

function PrivateGhostMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path
        d="M9.5 39V21C9.5 12 16 6.5 24 6.5S38.5 12 38.5 21v18c0 1.7-1.9 2.6-3.2 1.6l-3.4-2.6-3.4 2.6a2.5 2.5 0 0 1-3.1 0L22 38l-3.4 2.6a2.5 2.5 0 0 1-3.1 0l-3.4-2.6-3.4 2.6C11.4 41.6 9.5 40.7 9.5 39Z"
        fill="currentColor"
      />
      <circle cx="19" cy="22" r="2.4" className="fill-background" />
      <circle cx="29" cy="22" r="2.4" className="fill-background" />
    </svg>
  );
}

export function ChatView({ conversationId, initialMessages, initialArtifacts, initialModel, projectId, initialPrompt }: ChatViewProps) {
  const {
    settings,
    quota,
    setQuota,
    conversations,
    upsertConversation,
    updateConversation,
    activeConversationId,
    setActiveConversationId,
    composerPrefs,
    setComposerPrefs,
  } = useApp();
  const router = useRouter();
  const tts = useTts();
  const layoutRef = React.useRef<HTMLDivElement>(null);
  const canvasResizeRef = React.useRef<{ pointerId: number; previousCursor: string; previousUserSelect: string } | null>(null);
  // Tracks a conversation created on the new-chat page so we can switch to its
  // real /chat/[id] route once the first reply finishes streaming.
  const createdIdRef = React.useRef<string | null>(null);
  const [model, setModel] = React.useState<ModelId>(
    () => resolveModel(initialModel)?.id ?? resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL
  );
  const [openArtifactId, setOpenArtifactId] = React.useState<string | null>(null);
  // Quoted canvas selection waiting in the composer ("select → modify/ask").
  const [composerQuote, setComposerQuote] = React.useState<ComposerQuote | null>(null);
  // Holds the last artifact while the canvas plays its slide-out exit.
  const [closingArtifact, setClosingArtifact] = React.useState<ClientArtifact | null>(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [canvasWidth, setCanvasWidth] = React.useState(() => {
    if (typeof window === "undefined") return 560;
    const saved = Number(window.localStorage.getItem(CANVAS_WIDTH_KEY));
    return clampCanvasWidth(Number.isFinite(saved) && saved > 0 ? saved : Math.round(window.innerWidth * 0.46));
  });
  const [resizingCanvas, setResizingCanvas] = React.useState(false);
  const [memoryFlash, setMemoryFlash] = React.useState(false);
  const [memoryLeaving, setMemoryLeaving] = React.useState(false);
  const [voiceOpen, setVoiceOpen] = React.useState(false);
  const [dictating, setDictating] = React.useState(false);
  // Sticky composer toggles live in AppProvider so they survive ChatView remounts
  // (e.g. the new-chat → /chat/[id] navigation after the first reply) and refreshes.
  const canvasEnabled = composerPrefs.canvas;
  const webSearchEnabled = composerPrefs.webSearch;
  const reasoningEffort = composerPrefs.reasoningEffort;
  const setCanvasEnabled = React.useCallback((v: boolean) => setComposerPrefs({ canvas: v }), [setComposerPrefs]);
  const setWebSearchEnabled = React.useCallback((v: boolean) => setComposerPrefs({ webSearch: v }), [setComposerPrefs]);
  const setReasoningEffort = React.useCallback(
    (e: ReasoningEffort | null) => setComposerPrefs({ reasoningEffort: e }),
    [setComposerPrefs]
  );
  // Tool connectors (GitHub/Figma…) enabled for the next message.
  const [enabledConnectors, setEnabledConnectors] = React.useState<string[]>([]);
  const toggleConnector = React.useCallback(
    (id: string) => setEnabledConnectors((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    []
  );
  const [privateMode, setPrivateMode] = React.useState(false);
  // Set when this view is an unsaved branch forked from another conversation.
  const [forkedFrom, setForkedFrom] = React.useState<{ title: string; count: number } | null>(null);
  // The project this chat belongs to. For a brand-new chat it's the target the
  // first message will be created in; for an existing chat, changes are PATCHed.
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(projectId ?? null);
  // Resolved name for the scope indicator (ChatView only holds the id).
  const [projectMeta, setProjectMeta] = React.useState<{ id: string; name: string } | null>(null);
  const localGenerationSeenRef = React.useRef(false);
  const scheduleAutoTitleRef = React.useRef<(phase: AutoTitlePhase, delay?: number) => void>(() => {});

  React.useEffect(() => {
    setActiveConversationId(conversationId);
  }, [conversationId, setActiveConversationId]);

  const chat = useChat({
    conversationId,
    initialMessages,
    initialArtifacts,
    model,
    projectId: activeProjectId ?? undefined,
    canvasEnabled: privateMode ? false : canvasEnabled,
    webSearch: webSearchEnabled,
    reasoningEffort: reasoningEffort ?? undefined,
    connectors: enabledConnectors,
    privateMode,
    onQuota: setQuota,
    onTitle: (id, title, titleSource) => updateConversation(id, { title, titleSource: titleSource ?? "ai" }),
    onMeta: ({ conversationId: id, title, titleSource, isNew }) => {
      localGenerationSeenRef.current = true;
      if (isNew) {
        // Don't navigate mid-stream (it would remount and drop the stream).
        // Remember the id; we switch to /chat/[id] once the reply completes.
        createdIdRef.current = id;
        setActiveConversationId(id);
        const convo: ClientConversation = {
          id,
          title,
          titleSource,
          model,
          pinned: false,
          folderId: null,
          projectId: activeProjectId ?? null,
          lastMessageAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        upsertConversation(convo);
      } else {
        updateConversation(id, { title, titleSource, lastMessageAt: new Date().toISOString() });
      }
    },
    onDone: (_assistant, meta) => {
      const id = createdIdRef.current ?? conversationId;
      if (!privateMode && id && meta?.title) {
        updateConversation(id, { title: meta.title, lastMessageAt: new Date().toISOString() });
      }
      if (!privateMode && id) {
        scheduleAutoTitleRef.current(meta?.finishReason === "user_stopped" ? "stopped" : "completed", 80);
      }
      if (meta?.projectId && meta.projectName) {
        window.dispatchEvent(new CustomEvent("projects:sync"));
      }
      // First reply of a brand-new chat finished and is persisted — move to the
      // real route so the URL/router are in sync and the conversation is linkable.
      if (privateMode) return;
      if (conversationId === null && createdIdRef.current) {
        const id = createdIdRef.current;
        createdIdRef.current = null;
        router.replace(`/chat/${id}`);
      }
    },
    onArtifactsUpdated: () => {},
    onMemoryUpdated: () => {
      setMemoryFlash(true);
      setMemoryLeaving(false);
      // Fade the pill out (title-out, 180ms) before unmounting it.
      setTimeout(() => setMemoryLeaving(true), 3800);
      setTimeout(() => {
        setMemoryFlash(false);
        setMemoryLeaving(false);
      }, 4000);
    },
  });

  const currentConversationId = activeConversationId ?? createdIdRef.current ?? conversationId;
  const latestConversationsRef = React.useRef(conversations);
  const latestMessagesRef = React.useRef(chat.messages);
  const titleDebounceRef = React.useRef<number | null>(null);
  const titleRequestSeqRef = React.useRef(0);
  const titlePhaseMapRef = React.useRef<Map<string, Set<AutoTitlePhase>>>(new Map());

  React.useEffect(() => {
    latestConversationsRef.current = conversations;
  }, [conversations]);

  React.useEffect(() => {
    latestMessagesRef.current = chat.messages;
  }, [chat.messages]);

  const runAutoTitle = React.useCallback(
    async (phase: AutoTitlePhase) => {
      const id = currentConversationId;
      if (!id || privateMode) return;
      const latest = latestConversationsRef.current.find((c) => c.id === id);
      if (latest?.titleSource === "manual") return;
      const messages = titleMessages(latestMessagesRef.current);
      if (!messages.some((m) => m.role === "USER")) return;

      const requestId = ++titleRequestSeqRef.current;
      try {
        const res = await fetch(`/api/conversations/${id}/title`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phase, messages }),
        });
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as
          | { title?: unknown; titleSource?: unknown; projectId?: unknown; projectName?: unknown }
          | null;
        if (requestId !== titleRequestSeqRef.current || !data || typeof data.title !== "string") return;

        const current = latestConversationsRef.current.find((c) => c.id === id);
        if (!current || current.titleSource === "manual") return;
        const titleSource: TitleSource =
          data.titleSource === "default" || data.titleSource === "manual" || data.titleSource === "ai" ? data.titleSource : "ai";
        if (data.title && (data.title !== current.title || titleSource !== current.titleSource)) {
          updateConversation(id, { title: data.title, titleSource });
        }
        if (typeof data.projectId === "string" && typeof data.projectName === "string" && data.projectName) {
          window.dispatchEvent(new CustomEvent("projects:sync"));
        } else if (typeof data.projectId === "string") {
          window.setTimeout(() => window.dispatchEvent(new CustomEvent("projects:sync")), 1800);
        }
      } catch {
        // Title generation is best-effort and must never affect the active stream.
      }
    },
    [currentConversationId, privateMode, updateConversation]
  );

  const scheduleAutoTitle = React.useCallback(
    (phase: AutoTitlePhase, delay = 240) => {
      const id = currentConversationId;
      if (!id || privateMode) return;
      const latest = latestConversationsRef.current.find((c) => c.id === id);
      if (latest?.titleSource === "manual") return;
      if (!localGenerationSeenRef.current && latest?.titleSource !== "default") return;
      const phases = titlePhaseMapRef.current.get(id) ?? new Set<AutoTitlePhase>();
      if (phases.has(phase)) return;
      phases.add(phase);
      titlePhaseMapRef.current.set(id, phases);
      if (titleDebounceRef.current != null) window.clearTimeout(titleDebounceRef.current);
      titleDebounceRef.current = window.setTimeout(() => {
        titleDebounceRef.current = null;
        void runAutoTitle(phase);
      }, delay);
    },
    [currentConversationId, privateMode, runAutoTitle]
  );

  React.useEffect(() => {
    scheduleAutoTitleRef.current = scheduleAutoTitle;
  }, [scheduleAutoTitle]);

  React.useEffect(() => {
    if (!currentConversationId || privateMode) return;
    if (chat.messages.some((m) => m.role === "USER" && m.content.trim())) scheduleAutoTitle("first_user", 160);
  }, [chat.messages.length, currentConversationId, privateMode, scheduleAutoTitle]);

  React.useEffect(() => {
    if (!currentConversationId || privateMode) return;
    if (chat.status === "thinking") scheduleAutoTitle("thinking", 240);
    if (chat.status === "writing") {
      const latestAssistant = [...chat.messages].reverse().find((m) => m.role === "ASSISTANT");
      if ((latestAssistant?.content.length ?? 0) >= 24) scheduleAutoTitle("writing", 360);
    }
    if (chat.status === "idle") {
      const latestAssistant = [...chat.messages].reverse().find((m) => m.role === "ASSISTANT");
      if (latestAssistant && !latestAssistant.streaming && (latestAssistant.content || latestAssistant.reasoning)) {
        scheduleAutoTitle(latestAssistant.finishReason === "user_stopped" ? "stopped" : "completed", 420);
      }
    }
  }, [chat.status, chat.messages.length, currentConversationId, privateMode, scheduleAutoTitle]);

  React.useEffect(() => {
    return () => {
      if (titleDebounceRef.current != null) window.clearTimeout(titleDebounceRef.current);
      titleRequestSeqRef.current += 1;
    };
  }, []);

  // When the sidebar (or any other UI) fires "juno:new-chat", reset the
  // ChatView even if the URL didn't change (Next.js ignores push to the
  // same route, so the component won't remount on its own).
  React.useEffect(() => {
    const handler = () => {
      createdIdRef.current = null;
      localGenerationSeenRef.current = false;
      forkPayloadRef.current = null;
      chat.reset();
      setOpenArtifactId(null);
      setComposerQuote(null);
      setFullscreen(false);
      setPrivateMode(false);
      setForkedFrom(null);
      setEnabledConnectors([]);
      setActiveConversationId(null);
    };
    window.addEventListener("juno:new-chat", handler);
    return () => window.removeEventListener("juno:new-chat", handler);
    // chat.reset is stable (useCallback with no deps); safe to omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setActiveConversationId]);

  const togglePrivateMode = React.useCallback(() => {
    if (chat.isBusy) return;
    const next = !privateMode;
    createdIdRef.current = null;
    forkPayloadRef.current = null;
    setPrivateMode(next);
    setForkedFrom(null);
    chat.reset();
    setOpenArtifactId(null);
    setComposerQuote(null);
    setFullscreen(false);
    // Connectors reach third-party servers, so never carry them into incognito.
    if (next) setEnabledConnectors([]);
    if (next && conversationId) router.push("/chat");
  }, [chat, conversationId, privateMode, router]);

  // Pick (or clear) the project for this chat. Existing chat → PATCH immediately;
  // brand-new chat → remember it so the first message is created in that project.
  const handlePickProject = React.useCallback(
    async (pid: string | null) => {
      if (conversationId) {
        const prev = activeProjectId;
        setActiveProjectId(pid);
        try {
          const res = await fetch(`/api/conversations/${conversationId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: pid }),
          });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not update project.");
          toast.success(pid ? "Added to project." : "Removed from project.");
        } catch (err) {
          setActiveProjectId(prev);
          toast.error(err instanceof Error ? err.message : "Could not update project.");
        }
      } else {
        setActiveProjectId(pid);
        if (pid) toast.success("This chat will be saved to the project.");
      }
    },
    [conversationId, activeProjectId]
  );

  // Resolve the project name for the scope indicator whenever the id changes.
  React.useEffect(() => {
    if (!activeProjectId) {
      setProjectMeta(null);
      return;
    }
    if (projectMeta?.id === activeProjectId) return;
    let cancelled = false;
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        const p = ((d?.projects ?? []) as { id: string; name: string }[]).find((x) => x.id === activeProjectId);
        setProjectMeta(p ? { id: p.id, name: p.name } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, projectMeta?.id]);

  // Seed a forked branch: private-mode transport + the sliced transcript.
  const applyFork = React.useCallback(
    (payload: ForkPayload) => {
      createdIdRef.current = null;
      setPrivateMode(true);
      setEnabledConnectors([]);
      setOpenArtifactId(null);
      setComposerQuote(null);
      setFullscreen(false);
      chat.setMessages(
        payload.messages.map((m) => ({ ...m, streaming: false, pending: false }))
      );
      setForkedFrom({ title: payload.title, count: payload.messages.length });
    },
    // chat.setMessages is a stable state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const handleFork = React.useCallback(
    (messageId: string) => {
      if (chat.isBusy) return;
      const idx = chat.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return;
      const sliced = chat.messages
        .slice(0, idx + 1)
        .filter((m) => !m.error && (m.role === "USER" || m.role === "ASSISTANT") && m.content.trim())
        .map(({ streaming: _s, pending: _p, error: _e, ...m }) => m as ClientMessage);
      if (sliced.length === 0) return;
      const title = conversations.find((c) => c.id === currentConversationId)?.title ?? "this chat";
      const payload: ForkPayload = { title, messages: sliced };
      if (conversationId) {
        try {
          sessionStorage.setItem(FORK_STORAGE_KEY, JSON.stringify(payload));
        } catch {
          toast.error("Couldn't fork — the transcript is too large to carry over.");
          return;
        }
        router.push("/chat");
      } else {
        applyFork(payload);
      }
      toast.success(`Forked from message ${idx + 1}`);
    },
    [applyFork, chat.isBusy, chat.messages, conversationId, conversations, currentConversationId, router]
  );

  // Pick up a pending fork after navigating to the new-chat route. The payload
  // is kept in a ref and re-applied on every pass because useChat's own reset
  // effect (registered earlier, same deps) clears messages on each run — in
  // dev, StrictMode's double-invoke would otherwise wipe the seeded branch.
  const forkPayloadRef = React.useRef<ForkPayload | null>(null);
  React.useEffect(() => {
    if (conversationId !== null) return;
    if (!forkPayloadRef.current) {
      try {
        const raw = sessionStorage.getItem(FORK_STORAGE_KEY);
        if (!raw) return;
        sessionStorage.removeItem(FORK_STORAGE_KEY);
        const parsed = JSON.parse(raw) as ForkPayload;
        if (!parsed || !Array.isArray(parsed.messages) || parsed.messages.length === 0) return;
        forkPayloadRef.current = parsed;
      } catch {
        // A malformed stash should never block the new-chat page.
        return;
      }
    }
    applyFork(forkPayloadRef.current);
  }, [conversationId, applyFork]);

  // "/learn-demo" appends the visual-learning fixture as a local assistant
  // message — renders every block type without an API call.
  React.useEffect(() => {
    const handler = () => {
      chat.setMessages((prev) => [
        ...prev,
        {
          id: `learn-demo-${prev.length}`,
          role: "ASSISTANT",
          content: STEP_LAB_DEMO_MESSAGE,
          createdAt: new Date().toISOString(),
          attachments: [],
        },
      ]);
    };
    window.addEventListener("juno:learning-demo", handler);
    return () => window.removeEventListener("juno:learning-demo", handler);
    // chat.setMessages is a stable state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-send a prompt passed via the URL (used when starting a chat from a project).
  const autoSentRef = React.useRef(false);
  React.useEffect(() => {
    if (initialPrompt && !autoSentRef.current) {
      autoSentRef.current = true;
      chat.send(initialPrompt);
      // Clear ?q= so a refresh doesn't resend.
      window.history.replaceState({}, "", "/chat");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const openArtifact = React.useMemo(
    () => chat.artifacts.find((a) => a.id === openArtifactId) ?? null,
    [chat.artifacts, openArtifactId]
  );

  // Keep the panel mounted through its slide-out; reopening cancels the exit.
  const closeArtifact = React.useCallback(() => {
    setClosingArtifact(openArtifact);
    setOpenArtifactId(null);
    setFullscreen(false);
  }, [openArtifact]);

  React.useEffect(() => {
    if (openArtifact) {
      setClosingArtifact(null);
      return;
    }
    if (!closingArtifact) return;
    const t = window.setTimeout(() => setClosingArtifact(null), 400);
    return () => window.clearTimeout(t);
  }, [openArtifact, closingArtifact]);

  const openArtifactByIdentifier = (identifier: string, opts?: { fullscreen?: boolean }) => {
    const a = chat.artifacts.find((x) => x.identifier === identifier);
    if (a) {
      setOpenArtifactId(a.id);
      setFullscreen(!!opts?.fullscreen);
    }
  };

  React.useEffect(() => {
    window.localStorage.setItem(CANVAS_WIDTH_KEY, String(canvasWidth));
  }, [canvasWidth]);

  React.useEffect(() => {
    const onResize = () => {
      const width = layoutRef.current?.getBoundingClientRect().width;
      setCanvasWidth((w) => clampCanvasWidth(w, width));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  React.useEffect(() => {
    if (!openArtifact || fullscreen) return;
    const availableWidth = layoutRef.current?.getBoundingClientRect().width;
    if (!availableWidth || availableWidth >= CANVAS_MIN_WIDTH + CHAT_MIN_WIDTH + 32) return;
    window.dispatchEvent(new CustomEvent("juno:collapse-sidebar"));
    window.requestAnimationFrame(() => {
      const nextWidth = layoutRef.current?.getBoundingClientRect().width;
      setCanvasWidth((w) => clampCanvasWidth(w, nextWidth));
    });
  }, [fullscreen, openArtifact]);

  const updateCanvasWidthFromPointer = React.useCallback((clientX: number) => {
    const rect = layoutRef.current?.getBoundingClientRect();
    const requestedWidth = rect ? rect.right - clientX : window.innerWidth - clientX;
    if (rect && requestedWidth > canvasWidthBounds(rect.width).maxWidth) {
      window.dispatchEvent(new CustomEvent("juno:collapse-sidebar"));
      window.requestAnimationFrame(() => {
        const nextRect = layoutRef.current?.getBoundingClientRect();
        setCanvasWidth((w) => clampCanvasWidth(Math.max(w, requestedWidth), nextRect?.width));
      });
      return;
    }
    setCanvasWidth(clampCanvasWidth(requestedWidth, rect?.width));
  }, []);

  const stopCanvasResize = React.useCallback((target?: HTMLButtonElement, pointerId?: number) => {
    const session = canvasResizeRef.current;
    if (!session) return;
    canvasResizeRef.current = null;
    setResizingCanvas(false);
    document.body.style.cursor = session.previousCursor;
    document.body.style.userSelect = session.previousUserSelect;
    if (target && pointerId != null && target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  }, []);

  const startCanvasResize = React.useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      canvasResizeRef.current = {
        pointerId: e.pointerId,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      setResizingCanvas(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      updateCanvasWidthFromPointer(e.clientX);
    },
    [updateCanvasWidthFromPointer]
  );

  const continueCanvasResize = React.useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (canvasResizeRef.current?.pointerId !== e.pointerId) return;
      e.preventDefault();
      updateCanvasWidthFromPointer(e.clientX);
    },
    [updateCanvasWidthFromPointer]
  );

  const resetCanvasWidth = React.useCallback(() => {
    if (typeof window !== "undefined") {
      const width = layoutRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      setCanvasWidth(clampCanvasWidth(Math.round(width * 0.46), width));
    }
  }, []);

  // A canvas selection lands in the composer as a quote chip. Below lg the
  // canvas covers the chat, so close it to bring the composer back into view.
  const handleQuote = React.useCallback(
    (quote: ComposerQuote) => {
      setComposerQuote(quote);
      if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
        closeArtifact();
      }
    },
    [closeArtifact]
  );

  const handleArtifactUpdated = (updated: ClientArtifact) => {
    chat.setArtifacts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    setOpenArtifactId(updated.id);
  };

  const hasMessages = chat.messages.length > 0;
  const quotaReached = quota.limit != null && quota.remaining != null && quota.remaining <= 0;
  const planAllowsVoice = PLANS[quota.plan].voice;
  // Model-parameters live beside the incognito ghost (top-right) so the composer
  // stays uncluttered. Only meaningful for chat models.
  const resolvedModelInfo = resolveModel(model);
  const paramsIsChat = (resolvedModelInfo?.modality ?? "chat") === "chat";
  const paramsCanWebSearch =
    PLANS[quota.plan].webSearch && paramsIsChat && (resolvedModelInfo?.webSearch ?? false);

  // Read-aloud: clicking the active message again stops playback.
  const [speakingId, setSpeakingId] = React.useState<string | null>(null);
  const handleSpeak = (id: string, text: string) => {
    if (speakingId === id) {
      tts.stop();
      setSpeakingId(null);
      return;
    }
    setSpeakingId(id);
    tts.speak(cleanForSpeech(text), settings.voiceId).finally(() => setSpeakingId((cur) => (cur === id ? null : cur)));
  };

  const composer = (
    <Composer
      conversationId={conversationId}
      model={model}
      onModelChange={setModel}
      onSend={(text, attachments) => chat.send(text, attachments)}
      isBusy={chat.isBusy}
      status={chat.status}
      onStop={chat.stop}
      pendingClarification={chat.pendingClarification}
      onSubmitClarification={(answers) => chat.resolvePendingClarification(answers)}
      onSkipClarification={() => chat.resolvePendingClarification([], true)}
      onCancelClarification={chat.cancelPendingClarification}
      onOpenVoiceMode={planAllowsVoice ? () => setVoiceOpen(true) : undefined}
      quotaReached={quotaReached}
      canvasEnabled={canvasEnabled}
      onToggleCanvas={setCanvasEnabled}
      webSearchEnabled={webSearchEnabled}
      onToggleWebSearch={setWebSearchEnabled}
      reasoningEffort={reasoningEffort}
      onReasoningChange={setReasoningEffort}
      connectorsEnabled={enabledConnectors}
      onToggleConnector={toggleConnector}
      quote={composerQuote}
      onClearQuote={() => setComposerQuote(null)}
      privateMode={privateMode}
      placeholder={privateMode ? "How can I help you today?" : undefined}
      selectedProjectId={activeProjectId}
      onPickProject={handlePickProject}
      hideDisclaimer={true}
      onDictatingChange={setDictating}
    />
  );

  return (
    <div ref={layoutRef} data-juno-chat-root className="relative flex h-full min-h-0 w-full overflow-hidden">
      {/* Model parameters + incognito ghost, top-right in normal mode. */}
      <div
        className={cn(
          "absolute right-3 top-3 z-20 flex items-center gap-0.5 md:right-4 md:top-4 transition-all duration-500 ease-out-soft",
          privateMode ? "pointer-events-none scale-90 opacity-0" : "scale-100 opacity-100"
        )}
      >
        {paramsIsChat && (
          <ModelParamsPanel
            model={resolvedModelInfo}
            reasoningEffort={reasoningEffort}
            canvasEnabled={canvasEnabled}
            webSearchEnabled={webSearchEnabled}
            canWebSearch={paramsCanWebSearch}
            privateMode={privateMode}
            disabled={chat.isBusy}
          />
        )}
        <PrivateChatToggle active={privateMode} disabled={chat.isBusy} onToggle={togglePrivateMode} />
      </div>

      {/* Chat column */}
      {/* Below lg the canvas replaces the chat entirely — a split there leaves the
          chat column narrower than a phone. */}
      <div className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col", openArtifact && "hidden lg:flex")}>
        {/* Project scope indicator — persistent while this chat is filed in a
            project. Brand-new chats use the composer chip until they exist. */}
        {activeProjectId && !privateMode && currentConversationId && (
          <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border/60 bg-card/45 px-4 backdrop-blur-md motion-safe:animate-fade-in sm:px-5">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border border-primary/25 bg-primary/10">
              <Box className="h-3.5 w-3.5 text-primary" />
            </span>
            <span className="hidden font-mono text-label uppercase text-muted-foreground sm:inline">
              Project
            </span>
            {projectMeta ? (
              <button
                type="button"
                onClick={() => router.push(`/projects/${activeProjectId}`)}
                className="min-w-0 truncate text-sm font-medium text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
              >
                {projectMeta.name}
              </button>
            ) : (
              <span className="skeleton h-3.5 w-28 rounded-full" aria-hidden />
            )}
            <div className="ml-auto mr-11 flex items-center gap-0.5 coarse:gap-1.5 md:mr-12">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => router.push(`/projects/${activeProjectId}`)}
                    aria-label="Open project"
                    className="pressable inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground coarse:h-10 coarse:w-10"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Open project</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => handlePickProject(null)}
                    disabled={chat.isBusy}
                    aria-label="Remove from project"
                    className="pressable inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 coarse:h-10 coarse:w-10"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Remove from project</TooltipContent>
              </Tooltip>
            </div>
          </div>
        )}

        {memoryFlash && (
          <div className="flex justify-center pt-2">
            <span
              role="status"
              className={cn(
                "inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/80 px-3 py-1 shadow-glass backdrop-blur",
                memoryLeaving ? "motion-safe:animate-title-out motion-safe:[animation-fill-mode:forwards]" : "motion-safe:animate-rise-in"
              )}
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-70 motion-safe:animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              <span className="font-mono text-label uppercase text-muted-foreground">Memory updated</span>
            </span>
          </div>
        )}

        {/* Incognito Header Bar */}
        <div
          className={cn(
            "overflow-hidden transition-all duration-500 ease-out-soft",
            privateMode ? "h-12 opacity-100 border-b bg-background/95" : "h-0 opacity-0 border-b-transparent pointer-events-none"
          )}
        >
          <div className="flex h-12 shrink-0 items-center justify-between px-4 text-sm text-foreground/80 sm:px-5">
            {forkedFrom ? (
              <div className="inline-flex min-w-0 items-center gap-2 font-medium">
                <GitFork className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 truncate">
                  Branched from <span className="font-serif italic">&ldquo;{forkedFrom.title}&rdquo;</span>
                </span>
                <span className="shrink-0 font-mono text-label uppercase text-muted-foreground">
                  {forkedFrom.count} {forkedFrom.count === 1 ? "message" : "messages"}
                </span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 font-medium">
                <PrivateGhostMark className="h-4 w-4 text-foreground/80" />
                Incognito chat
              </div>
            )}
            <button
              type="button"
              onClick={togglePrivateMode}
              disabled={chat.isBusy}
              aria-label={forkedFrom ? "Discard branch" : "Leave private chat"}
              className="pressable inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 coarse:h-10 coarse:w-10"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Main Content Area Container (morphs into rounded card in incognito mode) */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-hidden transition-all duration-500 ease-out-soft",
            privateMode
              ? "m-2 border border-dashed border-foreground/25 bg-background text-foreground rounded-[18px] sm:m-3 sm:rounded-[22px] shadow-soft"
              : "m-0 border-transparent bg-transparent rounded-none"
          )}
        >
          {hasMessages ? (
            // Message view
            <div className="flex min-h-0 flex-1 flex-col relative h-full">
              <MessageList
                messages={chat.messages}
                busy={chat.isBusy}
                status={chat.status}
                artifacts={chat.artifacts}
                onOpenArtifact={openArtifactByIdentifier}
                onRegenerate={chat.regenerate}
                onContinue={chat.continueResponse}
                onEdit={chat.editAndResend}
                onFeedback={chat.setFeedback}
                onFork={handleFork}
                onSpeak={handleSpeak}
                speakingId={speakingId}
                privateMode={privateMode}
                onImageEdit={chat.sendImageEdit}
                currentModelId={model}
              />
              <div
                className={cn(
                  "w-full transition-all duration-500 ease-out-soft",
                  privateMode ? "px-2 sm:px-4 pb-1" : "px-0 pb-1"
                )}
              >
                {composer}
              </div>
              <p className="pb-2 text-center text-caption text-muted-foreground select-none shrink-0">
                {forkedFrom
                  ? "This branch isn't saved — it continues from the fork point with full context."
                  : privateMode
                    ? "Incognito chats are not saved or added to memory."
                    : "Juno can be wrong — worth a second look on anything that matters."}
              </p>
            </div>
          ) : (
            // Empty / greeting view
            <div className="min-h-0 flex-1 overflow-y-auto relative h-full flex flex-col">
              <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-3 py-6 sm:px-5 md:py-10">
                <div className="relative w-full flex flex-col items-center justify-center">
                  {/* Headers cross-fade (CSS Grid overlap) */}
                  <div className="grid grid-cols-1 grid-rows-1 w-full justify-items-center mb-5 sm:mb-6">
                    {/* Normal Mode Greeting */}
                    <div
                      className={cn(
                        "col-start-1 row-start-1 w-full flex flex-col items-center justify-center transition-all duration-500 ease-out-soft",
                        (privateMode || chat.pendingClarification) ? "pointer-events-none scale-95 opacity-0" : "scale-100 opacity-100"
                      )}
                    >
                      <EmptyGreeting />
                    </div>

                    {/* Private Mode Header */}
                    <div
                      className={cn(
                        "col-start-1 row-start-1 w-full flex flex-col items-center justify-center transition-all duration-500 ease-out-soft",
                        (privateMode && !chat.pendingClarification) ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"
                      )}
                    >
                      <h1 className="flex items-center gap-3 font-serif text-3xl font-normal tracking-tight text-foreground sm:text-display">
                        <span className="text-primary">✳</span>
                        You&apos;re incognito
                      </h1>
                    </div>
                  </div>

                  {/* Composer */}
                  <div
                    className={cn(
                      "w-full transition-all duration-500 ease-out-soft z-10",
                      privateMode ? "max-w-[46rem]" : "max-w-[48rem]"
                    )}
                  >
                    {composer}
                  </div>

                  {/* Footer options/pills cross-fade (CSS Grid overlap) */}
                  <div className="grid grid-cols-1 grid-rows-1 w-full justify-items-center mt-3 sm:mt-4">
                    {/* Normal Mode Suggestion Pills */}
                    <div
                      className={cn(
                        "col-start-1 row-start-1 w-full flex flex-col items-center justify-center transition-all duration-500 ease-out-soft",
                        (privateMode || chat.pendingClarification) ? "pointer-events-none scale-95 opacity-0" : "scale-100 opacity-100"
                      )}
                    >
                      <SuggestionPills onPick={(t) => chat.send(t)} />
                    </div>

                    {/* Private Mode Info */}
                    <div
                      className={cn(
                        "col-start-1 row-start-1 w-full flex flex-col items-center justify-center transition-all duration-500 ease-out-soft",
                        (privateMode && !chat.pendingClarification) ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"
                      )}
                    >
                      <p className="max-w-md text-center text-sm leading-6 text-muted-foreground sm:text-base">
                        Incognito chats aren&apos;t saved, added to memory, or used to train models.
                      </p>
                    </div>
                  </div>

                </div>
              </div>

              {/* Disclaimer — pinned to the bottom of the page, not centered with the greeting. */}
              <p
                className={cn(
                  "shrink-0 pb-2 text-center text-caption text-muted-foreground select-none transition-opacity duration-500 ease-out-soft",
                  privateMode ? "pointer-events-none opacity-0" : "opacity-100"
                )}
              >
                Juno can be wrong — worth a second look on anything that matters.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Canvas — slides in from the right; on close it lingers (absolute, so the
          chat reflows underneath) while the slide-out plays, then unmounts. */}
      {(openArtifact ?? closingArtifact) && (
        <div
          style={{ "--juno-canvas-width": `${canvasWidth}px` } as React.CSSProperties}
          className={cn(
            "relative z-40 h-full w-full bg-background lg:w-[var(--juno-canvas-width)] lg:min-w-[420px] lg:shrink-0 lg:border-l",
            resizingCanvas ? "select-none transition-none" : "duration-slow ease-out-expo",
            openArtifact
              ? !resizingCanvas && "animate-in slide-in-from-right"
              : "pointer-events-none absolute inset-y-0 right-0 animate-out slide-out-to-right fill-mode-forwards",
            openArtifact && !fullscreen && "lg:relative"
          )}
        >
          {openArtifact && !fullscreen && (
            <button
              type="button"
              onPointerDown={startCanvasResize}
              onPointerMove={continueCanvasResize}
              onPointerUp={(event) => stopCanvasResize(event.currentTarget, event.pointerId)}
              onPointerCancel={(event) => stopCanvasResize(event.currentTarget, event.pointerId)}
              onLostPointerCapture={() => stopCanvasResize()}
              onDoubleClick={resetCanvasWidth}
              aria-label="Resize canvas"
              title="Drag to resize canvas. Double-click to reset."
              className="group absolute inset-y-0 left-0 z-50 hidden w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center lg:flex"
            >
              <span className="flex h-12 w-1.5 items-center justify-center rounded-full border border-border/70 bg-background/90 text-muted-foreground opacity-0 shadow-soft backdrop-blur transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <GripVertical className="h-3.5 w-3.5" />
              </span>
            </button>
          )}
          <CanvasPanel
            artifact={(openArtifact ?? closingArtifact)!}
            onClose={closeArtifact}
            onArtifactUpdated={handleArtifactUpdated}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((f) => !f)}
            onQuote={handleQuote}
          />
        </div>
      )}

      {voiceOpen &&
        // With a voice relay deployed, the voice button opens the realtime
        // speech-to-speech experience; otherwise the legacy STT->chat->TTS mode.
        (process.env.NEXT_PUBLIC_VOICE_RELAY_URL ? (
          <RealtimeVoice onClose={() => setVoiceOpen(false)} />
        ) : (
          <VoiceMode
            model={model}
            conversationId={conversationId}
            voiceId={settings.voiceId}
            onClose={() => setVoiceOpen(false)}
            onExchange={() => {
              /* voice mode persists its own turns via the chat API */
            }}
          />
        ))}
    </div>
  );
}
