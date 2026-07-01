"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X } from "lucide-react";
import { useChat } from "@/hooks/use-chat";
import { useTts } from "@/hooks/use-tts";
import { useApp } from "@/components/app/app-provider";
import { MessageList } from "@/components/chat/message-list";
import { Composer } from "@/components/chat/composer";
import { EmptyGreeting, SuggestionPills } from "@/components/chat/empty-state";
import { PrivateChatToggle } from "@/components/chat/private-chat-toggle";
import { CanvasPanel } from "@/components/canvas/canvas-panel";
import { VoiceMode } from "@/components/voice/voice-mode";
import { resolveModel, type ModelId, DEFAULT_MODEL } from "@/lib/models";
import { PLANS } from "@/lib/plans";
import { cleanForSpeech } from "@/lib/message-content";
import { cn } from "@/lib/utils";
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
  // Tracks a conversation created on the new-chat page so we can switch to its
  // real /chat/[id] route once the first reply finishes streaming.
  const createdIdRef = React.useRef<string | null>(null);
  const [model, setModel] = React.useState<ModelId>(
    () => resolveModel(initialModel)?.id ?? resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL
  );
  const [openArtifactId, setOpenArtifactId] = React.useState<string | null>(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [memoryFlash, setMemoryFlash] = React.useState(false);
  const [voiceOpen, setVoiceOpen] = React.useState(false);
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
  const [privateMode, setPrivateMode] = React.useState(false);
  // The project this chat belongs to. For a brand-new chat it's the target the
  // first message will be created in; for an existing chat, changes are PATCHed.
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(projectId ?? null);
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
    onArtifactsUpdated: (_all, created) => {
      const latest = created[created.length - 1];
      if (latest) setOpenArtifactId(latest.id);
    },
    onMemoryUpdated: () => {
      setMemoryFlash(true);
      setTimeout(() => setMemoryFlash(false), 4000);
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
      chat.reset();
      setOpenArtifactId(null);
      setFullscreen(false);
      setPrivateMode(false);
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
    setPrivateMode(next);
    chat.reset();
    setOpenArtifactId(null);
    setFullscreen(false);
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

  const openArtifactByIdentifier = (identifier: string) => {
    const a = chat.artifacts.find((x) => x.identifier === identifier);
    if (a) setOpenArtifactId(a.id);
  };

  const handleArtifactUpdated = (updated: ClientArtifact) => {
    chat.setArtifacts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    setOpenArtifactId(updated.id);
  };

  const hasMessages = chat.messages.length > 0;
  const quotaReached = quota.limit != null && quota.remaining != null && quota.remaining <= 0;
  const planAllowsVoice = PLANS[quota.plan].voice;

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
      onOpenVoiceMode={planAllowsVoice ? () => setVoiceOpen(true) : undefined}
      quotaReached={quotaReached}
      canvasEnabled={canvasEnabled}
      onToggleCanvas={setCanvasEnabled}
      webSearchEnabled={webSearchEnabled}
      onToggleWebSearch={setWebSearchEnabled}
      reasoningEffort={reasoningEffort}
      onReasoningChange={setReasoningEffort}
      privateMode={privateMode}
      placeholder={privateMode ? "How can I help you today?" : undefined}
      selectedProjectId={activeProjectId}
      onPickProject={handlePickProject}
      hideDisclaimer={true}
    />
  );

  return (
    <div className="relative flex h-full min-h-0 w-full">
      {/* Ghost toggle on top right in normal mode */}
      <div
        className={cn(
          "absolute right-3 top-3 z-20 md:right-4 md:top-4 transition-all duration-500 ease-out-soft",
          privateMode ? "pointer-events-none scale-90 opacity-0" : "scale-100 opacity-100"
        )}
      >
        <PrivateChatToggle active={privateMode} disabled={chat.isBusy} onToggle={togglePrivateMode} />
      </div>

      {/* Chat column */}
      <div className={cn("flex h-full min-h-0 flex-1 flex-col", openArtifact && "hidden md:flex")}>
        {memoryFlash && (
          <div className="flex justify-center pt-2">
            <span
              role="status"
              className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/80 px-3 py-1 shadow-glass backdrop-blur motion-safe:animate-rise-in"
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
            <div className="inline-flex items-center gap-2 font-medium">
              <PrivateGhostMark className="h-4 w-4 text-foreground/80" />
              Incognito chat
            </div>
            <button
              type="button"
              onClick={togglePrivateMode}
              disabled={chat.isBusy}
              aria-label="Leave private chat"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
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
              ? "m-2 border border-black/25 bg-background text-foreground dark:border-white/30 rounded-[18px] sm:m-3 sm:rounded-[22px] shadow-soft"
              : "m-0 border-transparent bg-transparent rounded-none"
          )}
        >
          {hasMessages ? (
            // Message view
            <div className="flex min-h-0 flex-1 flex-col relative h-full">
              <MessageList
                messages={chat.messages}
                busy={chat.isBusy}
                artifacts={chat.artifacts}
                onOpenArtifact={openArtifactByIdentifier}
                onRegenerate={chat.regenerate}
                onContinue={chat.continueResponse}
                onEdit={chat.editAndResend}
                onFeedback={chat.setFeedback}
                onSpeak={handleSpeak}
                speakingId={speakingId}
                privateMode={privateMode}
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
                {privateMode ? "Incognito chats are not saved or added to memory." : "Juno can be wrong — worth a second look on anything that matters."}
              </p>
            </div>
          ) : (
            // Empty / greeting view
            <div className="min-h-0 flex-1 overflow-y-auto relative h-full flex flex-col justify-center">
              <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-center px-3 py-6 pb-[calc(2rem+env(safe-area-inset-bottom))] sm:px-5 md:py-10">
                <div className="relative w-full flex flex-col items-center justify-center">
                  {/* Headers cross-fade (CSS Grid overlap) */}
                  <div className="grid grid-cols-1 grid-rows-1 w-full justify-items-center mb-5 sm:mb-6">
                    {/* Normal Mode Greeting */}
                    <div
                      className={cn(
                        "col-start-1 row-start-1 w-full flex flex-col items-center justify-center transition-all duration-500 ease-out-soft",
                        privateMode ? "pointer-events-none scale-95 opacity-0" : "scale-100 opacity-100"
                      )}
                    >
                      <EmptyGreeting />
                    </div>

                    {/* Private Mode Header */}
                    <div
                      className={cn(
                        "col-start-1 row-start-1 w-full flex flex-col items-center justify-center transition-all duration-500 ease-out-soft",
                        privateMode ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"
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
                        privateMode ? "pointer-events-none scale-95 opacity-0" : "scale-100 opacity-100"
                      )}
                    >
                      <SuggestionPills onPick={(t) => chat.send(t)} />
                    </div>

                    {/* Private Mode Info */}
                    <div
                      className={cn(
                        "col-start-1 row-start-1 w-full flex flex-col items-center justify-center transition-all duration-500 ease-out-soft",
                        privateMode ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"
                      )}
                    >
                      <p className="max-w-md text-center text-sm leading-6 text-muted-foreground sm:text-base">
                        Incognito chats aren&apos;t saved, added to memory, or used to train models.
                      </p>
                    </div>
                  </div>

                  {/* Normal Mode Disclaimer (moved to bottom, below suggestion pills) */}
                  <div
                    className={cn(
                      "transition-all duration-500 ease-out-soft mt-5 sm:mt-6",
                      privateMode ? "pointer-events-none opacity-0 h-0 overflow-hidden" : "opacity-100 h-auto"
                    )}
                  >
                    <p className="text-center text-caption text-muted-foreground">
                      Juno can be wrong — worth a second look on anything that matters.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Canvas */}
      {openArtifact && (
        <div
          className={cn(
            "z-40 h-full w-full bg-background md:w-[46%] md:min-w-[420px] md:border-l",
            !fullscreen && "md:relative"
          )}
        >
          <CanvasPanel
            artifact={openArtifact}
            onClose={() => {
              setOpenArtifactId(null);
              setFullscreen(false);
            }}
            onArtifactUpdated={handleArtifactUpdated}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((f) => !f)}
          />
        </div>
      )}

      {voiceOpen && (
        <VoiceMode
          model={model}
          conversationId={conversationId}
          voiceId={settings.voiceId}
          onClose={() => setVoiceOpen(false)}
          onExchange={() => {
            /* voice mode persists its own turns via the chat API */
          }}
        />
      )}
    </div>
  );
}
