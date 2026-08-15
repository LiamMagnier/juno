"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GitFork, GripVertical, Loader2 } from "lucide-react";
import { ActionIcons, AppIcons, StatusIcons } from "@/lib/app-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChat, type ChatMessage } from "@/hooks/use-chat";
import { splitBounds, useSplitPane } from "@/hooks/use-split-pane";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { useTts } from "@/hooks/use-tts";
import { useApp } from "@/components/app/app-provider";
import { MessageList } from "@/components/chat/message-list";
import { ConversationFind } from "@/components/chat/conversation-find";
import { Composer } from "@/components/chat/composer";
import { EmptyGreeting, PrivateGreeting } from "@/components/chat/empty-state";
import { FollowUpSuggestions } from "@/components/chat/follow-up-suggestions";
import { PrivateChatToggle } from "@/components/chat/private-chat-toggle";
import { ModelParamsPanel } from "@/components/chat/model-params-panel";
import { CanvasPanel } from "@/components/canvas/canvas-panel";
import { ThoughtPanelProvider } from "@/components/chat/thought-panel-context";
import { ResearchRunPanel } from "@/components/chat/research-run-panel";
import { useConversationResearch } from "@/components/research/use-conversation-run";
import { ShareDialog } from "@/components/share/share-dialog";
import { RealtimeVoice } from "@/components/voice/realtime-voice";
import { VoiceAura, voiceAuraStatus } from "@/components/voice/voice-aura";
import { resolveModel, type ModelId, DEFAULT_MODEL } from "@/lib/models";
import { STEP_LAB_DEMO_MESSAGE } from "@/lib/step-lab-fixture";
import { PLANS } from "@/lib/plans";
import { providerGlow } from "@/lib/provider-colors";
import { clampReasoningEffort, reasoningGlow, reasoningOptions } from "@/lib/model-metrics";
import { isAutoModelId } from "@/lib/auto-model";
import { cleanForSpeech } from "@/lib/message-content";
import { cn } from "@/lib/utils";
import type { ComposerQuote } from "@/lib/quote-context";
import type { ClientArtifact, ClientMessage, ClientConversation, ReasoningEffort, TitleSource } from "@/types/chat";
import { Pressable } from "@/components/ui/pressable";

interface ChatViewProps {
  conversationId: string | null;
  initialMessages: ClientMessage[];
  initialArtifacts: ClientArtifact[];
  initialModel: string;
  projectId?: string;
  initialPrompt?: string;
  /** Auto-send the initial prompt as a deep-research turn (?research=1). */
  initialPromptResearch?: boolean;
  /** Seed the reasoning slider when starting a chat from a deep-link (e.g. project page). */
  initialReasoningEffort?: ReasoningEffort | null;
  initialConnectors?: string[];
  /** Open this artifact's canvas on arrival (?artifact= deep link from the library). */
  initialArtifactIdentifier?: string;
  /** Scroll to and briefly mark this message on arrival (?m= deep link from search). */
  initialFocusMessageId?: string;
}

type AutoTitlePhase = "first_user" | "thinking" | "writing" | "completed" | "stopped";
/* The shell's header row (app-shell.tsx) reserves this node for the chat's own
 * top actions. Named here and there, and nowhere else. */
const TOP_ACTIONS_SLOT_ID = "juno-top-actions-slot";
const CANVAS_WIDTH_KEY = "juno:canvas-width";
const CANVAS_MIN_WIDTH = 420;
const CHAT_MIN_WIDTH = 320;

/**
 * Whether the system keyboard conventions are Apple's. Only used to decide
 * whether Ctrl+F belongs to the OS (macOS binds it to "move caret forward" in
 * any text field) rather than to us.
 */
function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/* The width the SERVER renders. Unreachable in practice — the canvas is opened
 * by a click, so it is never in the first HTML — but the column's whole width is
 * an inline custom property, and a property with no value is not a narrow panel,
 * it is a full-bleed one. */
const CANVAS_SSR_WIDTH = 560;

function canvasWidthBounds(containerWidth: number) {
  return splitBounds({
    containerWidth,
    paneMin: CANVAS_MIN_WIDTH,
    // 320 in its own right, not CHAT_MIN_WIDTH reused: this is how far the
    // canvas itself may be squeezed on a container that cannot give both
    // columns what they want, and the two numbers coinciding is arithmetic
    // rather than a shared rule.
    paneFloor: 320,
    primaryMin: CHAT_MIN_WIDTH,
    fraction: 0.82,
  });
}

/* ─── Thought dock width ──────────────────────────────────────────────────────
 * The dock shipped as a fixed column on the reasoning that it "holds one
 * fixed-measure column of receipts" and so had not earned a handle. Overruled:
 * the user wants the control, in both directions, at any time.
 *
 * Deliberately its own key and its own bounds, but the SAME mechanism as the
 * canvas — pointer capture, cursor/user-select save-restore, clamp-on-restore.
 *
 * THE DEFAULT DOES NOT MOVE. `null` means "never dragged", and null renders the
 * original `lg:w-[30rem]` class untouched. Only a width the user chose and we
 * persisted is ever applied as an inline override — which also keeps 30rem
 * honest if the root font size is not 16px, where a hardcoded 480 would not be.
 */
const THOUGHT_WIDTH_KEY = "juno:thought-width";
/* The FLOOR, not a new default. The panel's own widest fixed element is the
 * 5rem (80px) label column of its `LEDGER` grid, shared by the ELAPSED, COST,
 * SETUP and TOOLS rows, plus the scroller's px-5 padding (40px both sides) and
 * two 12px gaps. (This comment previously said 4.5rem, which was never true of
 * any version of the panel — a rewrite that reads it as spec inherits a number
 * that was always wrong. It is 5rem; check `LEDGER` in
 * thought-process-panel.tsx before trusting this line again.)
 *
 * 400, not 320. The panel's largest surface is now the model's own reasoning
 * prose in Newsreader, and below roughly 400px that column drops under ~45
 * characters — the point at which continuous reading starts costing more in
 * return sweeps than the narrow dock saves in chat width. The ledger was legible
 * at 320; a reading column is not. */
const THOUGHT_MIN_WIDTH = 400;
/* 30rem at the default 16px root — the width the dock already has. Used ONLY as
 * the starting point for a keyboard nudge (which needs a number to add to) and
 * for the handle's aria-valuenow. It is never applied as a width: an undragged
 * dock keeps rendering the `lg:w-[30rem]` class itself. */
const THOUGHT_DEFAULT_WIDTH = 480;

function thoughtWidthBounds(containerWidth: number) {
  return splitBounds({
    containerWidth,
    paneMin: THOUGHT_MIN_WIDTH,
    paneFloor: 280,
    // Reserves CHAT_MIN_WIDTH exactly as canvasWidthBounds does, so dragging the
    // dock can never squeeze the chat below phone width. The 0.6 cap (vs the
    // canvas's 0.82) is the one honest difference: the canvas holds documents the
    // user edits, this holds receipts read beside the chat.
    primaryMin: CHAT_MIN_WIDTH,
    fraction: 0.6,
    // THE DEFAULT MUST ALWAYS BE REACHABLE. `lg:w-[30rem]` is rendered by CSS for
    // an undragged dock no matter what these bounds say, so a max below 480 does
    // not make the panel narrower — it only makes the HANDLE lie: pointer-down
    // (which reads the live edge, i.e. 480) would clamp and snap the dock ~56px
    // narrower before the user moved, and the "grow" arrow would shrink it. That
    // happens on any lg container under 800px — a 1024 tablet or a half-screen
    // window with the sidebar out. `splitBounds` caps it by the container so the
    // dock can still never exceed the layout it lives in.
    cssWidth: THOUGHT_DEFAULT_WIDTH,
  });
}

/* Below lg BOTH docked columns are full-bleed `w-full` — no
 * `lg:w-[var(--juno-thought-width)]`, no `lg:w-[var(--juno-canvas-width)]` — so
 * there is no width to constrain, and clamping there would destroy a width
 * chosen on a wide monitor to satisfy a constraint that does not exist.
 *
 * The dock has always said so; the canvas did not, and clamped at every
 * breakpoint. That was not harmless: `resize` fires continuously on a phone (the
 * URL bar sliding away is enough), so one scroll rewrote a canvas width chosen on
 * a monitor down to the phone bounds and persisted it — for a column that was
 * rendering `w-full` and never read the number. One gate now, used by both. */
const splitResizeApplies = () =>
  typeof window !== "undefined" && !window.matchMedia("(max-width: 1023px)").matches;

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

export function ChatView({ conversationId, initialMessages, initialArtifacts, initialModel, projectId, initialPrompt, initialPromptResearch, initialReasoningEffort, initialConnectors, initialArtifactIdentifier, initialFocusMessageId }: ChatViewProps) {
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
  // Tracks a conversation created on the new-chat page so we can switch to its
  // real /chat/[id] route once the first reply finishes streaming.
  const createdIdRef = React.useRef<string | null>(null);
  const [model, setModel] = React.useState<ModelId>(
    () => resolveModel(initialModel)?.id ?? resolveModel(settings.defaultModel)?.id ?? DEFAULT_MODEL
  );
  // Deep-link reasoning (project page → /chat?reasoning=…) must win on the first
  // render so the auto-sent prompt uses it. After the user moves the slider we
  // hand control back to sticky composer prefs.
  const [deepLinkReasoningActive, setDeepLinkReasoningActive] = React.useState(
    () => initialReasoningEffort !== undefined
  );
  const [openArtifactId, setOpenArtifactId] = React.useState<string | null>(null);
  // Quoted canvas selection waiting in the composer ("select → modify/ask").
  const [composerQuote, setComposerQuote] = React.useState<ComposerQuote | null>(null);
  // Holds the last artifact while the canvas plays its slide-out exit.
  const [closingArtifact, setClosingArtifact] = React.useState<ClientArtifact | null>(null);
  const [fullscreen, setFullscreen] = React.useState(false);
  // The docked thought panel: which message's run is open, and the column its
  // panel is portalled into. Only the ID is lifted — the run model and its one
  // clock stay in ActivityTimeline. See thought-panel-context.
  const [thoughtOpenId, setThoughtOpenId] = React.useState<string | null>(null);
  const [thoughtContainer, setThoughtContainer] = React.useState<HTMLDivElement | null>(null);
  // Entrance animation, armed on mount and disarmed by the first drag.
  const [animateDock, setAnimateDock] = React.useState(true);
  /**
   * The shell's header row, when there is one, is where this chat's top actions
   * belong — see the portal at the top of the render. Resolved after mount
   * because AppShell renders it in the same commit as this component, and
   * because the server has no DOM to find it in.
   */
  const [topActionsSlot, setTopActionsSlot] = React.useState<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    setTopActionsSlot(document.getElementById(TOP_ACTIONS_SLOT_ID));
  }, []);
  const [memoryFlash, setMemoryFlash] = React.useState(false);
  const [memoryLeaving, setMemoryLeaving] = React.useState(false);
  const [voiceOpen, setVoiceOpen] = React.useState(false);
  const [voiceSaving, setVoiceSaving] = React.useState(false);
  const [voiceSaveError, setVoiceSaveError] = React.useState<string | null>(null);
  const [voiceTurnSending, setVoiceTurnSending] = React.useState(false);
  const voiceSavingRef = React.useRef(voiceSaving);
  voiceSavingRef.current = voiceSaving;
  const voiceTurnSendingRef = React.useRef(voiceTurnSending);
  voiceTurnSendingRef.current = voiceTurnSending;
  const realtimeVoice = useRealtimeVoice();
  const realtimeVoiceRef = React.useRef(realtimeVoice);
  realtimeVoiceRef.current = realtimeVoice;
  const voiceOpenRef = React.useRef(voiceOpen);
  voiceOpenRef.current = voiceOpen;
  const voiceSessionIdRef = React.useRef<string | null>(null);
  const voiceUnloadPayloadRef = React.useRef<string | null>(null);
  const voiceSaveDetachedRef = React.useRef(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  // Sticky composer toggles live in AppProvider so they survive ChatView remounts
  // (e.g. the new-chat → /chat/[id] navigation after the first reply) and refreshes.
  const canvasEnabled = composerPrefs.canvas;
  const webSearchEnabled = composerPrefs.webSearch;
  const reasoningEffort =
    deepLinkReasoningActive && initialReasoningEffort !== undefined
      ? initialReasoningEffort
      : composerPrefs.reasoningEffort;
  const fastMode = composerPrefs.fastMode;
  const proMode = composerPrefs.proMode;
  const setCanvasEnabled = React.useCallback((v: boolean) => setComposerPrefs({ canvas: v }), [setComposerPrefs]);
  const setWebSearchEnabled = React.useCallback((v: boolean) => setComposerPrefs({ webSearch: v }), [setComposerPrefs]);
  const setFastMode = React.useCallback((v: boolean) => setComposerPrefs({ fastMode: v }), [setComposerPrefs]);
  const setProMode = React.useCallback((v: boolean) => setComposerPrefs({ proMode: v }), [setComposerPrefs]);
  const setReasoningEffort = React.useCallback(
    (e: ReasoningEffort | null) => {
      setDeepLinkReasoningActive(false);
      setComposerPrefs({ reasoningEffort: e });
    },
    [setComposerPrefs]
  );
  // Persist deep-link reasoning into sticky prefs so the /chat → /chat/[id]
  // remount keeps the same effort without needing the query string again.
  React.useEffect(() => {
    if (!deepLinkReasoningActive || initialReasoningEffort === undefined) return;
    setComposerPrefs({ reasoningEffort: initialReasoningEffort });
  }, [deepLinkReasoningActive, initialReasoningEffort, setComposerPrefs]);
  // Tool connectors (GitHub/Figma…) enabled for the next message.
  // Seeded from the conversation's persisted set so connectors turned on earlier
  // stay on across sends, remounts (the post-first-message /chat/[id] redirect),
  // and reopening the chat later — no re-toggling per prompt.
  const [enabledConnectors, setEnabledConnectors] = React.useState<string[]>(initialConnectors ?? []);
  const toggleConnector = React.useCallback(
    (id: string) => setEnabledConnectors((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    []
  );
  // Prompt-intent auto-enable: only adds (never removes). Cap matches composer.
  const enableConnectors = React.useCallback((ids: string[]) => {
    if (!ids.length) return;
    setEnabledConnectors((prev) => {
      const next = [...prev];
      for (const id of ids) {
        if (next.includes(id)) continue;
        if (next.length >= 5) break;
        next.push(id);
      }
      return next;
    });
  }, []);
  const [privateMode, setPrivateMode] = React.useState(false);
  React.useEffect(() => {
    window.dispatchEvent(new CustomEvent("juno:incognito", { detail: privateMode }));
    if (privateMode) {
      document.documentElement.setAttribute("data-private-mode", "true");
    } else {
      document.documentElement.removeAttribute("data-private-mode");
    }
    return () => {
      document.documentElement.removeAttribute("data-private-mode");
    };
  }, [privateMode]);
  /**
   * Tell the shell incognito is over when this view goes away.
   *
   * `data-private-mode` is dropped by the cleanup above, but the EVENT was not,
   * and the Chat/Work switcher in the shell outlives this component — it is
   * rendered by AppShell for /chat and /work alike. So leaving an incognito chat
   * by any door that is not the toggle (the sidebar, the command palette, a
   * link) left the switcher mirroring a private mode that no longer existed:
   * dimmed and unavailable on /work, with nothing on that route able to correct
   * it. Its own dedicated effect rather than a line in the cleanup above, which
   * runs on every toggle and would announce a false the very next line retracts.
   */
  React.useEffect(
    () => () => {
      window.dispatchEvent(new CustomEvent("juno:incognito", { detail: false }));
    },
    []
  );
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
    fastMode,
    proMode,
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
          kind: "chat",
          pinned: false,
          folderId: null,
          projectId: activeProjectId ?? null,
          activeConnectors: enabledConnectors,
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

  // A FAILED first generation still leaves a real conversation behind: the
  // server creates it before streaming, onMeta puts it in the sidebar, and the
  // messages are persisted. But the URL sync lives only in onDone, which an
  // error never reaches — so the address bar stayed on /chat, and a refresh
  // lost a thread the user could see listed beside them.
  React.useEffect(() => {
    if (privateMode || chat.status !== "error" || conversationId !== null) return;
    const id = createdIdRef.current;
    if (!id) return;
    createdIdRef.current = null;
    router.replace(`/chat/${id}`);
  }, [chat.status, privateMode, conversationId, router]);

  const currentConversationId = activeConversationId ?? createdIdRef.current ?? conversationId;

  /**
   * The durable research run attached to this conversation, if there is one.
   *
   * Owned here rather than inside ResearchRunPanel because two components now
   * read the same row: the panel draws it, and the composer steers and stops it.
   * One hook, one event cursor — see use-conversation-run.ts. Never in
   * incognito: that mode writes no rows to point at.
   */
  const research = useConversationResearch(privateMode ? null : currentConversationId);
  const researchSteering = research.steering;

  // Follow-ups appear only on a settled turn: the stream is idle and the last
  // message is a non-empty assistant reply. Flipping this false while a new send
  // is in flight is also what clears the previous turn's suggestions and drives
  // the refetch (the component keys its effect on `visible`).
  const followUpsVisible = React.useMemo(() => {
    if (chat.isBusy || chat.status !== "idle" || privateMode) return false;
    const last = chat.messages[chat.messages.length - 1];
    return !!last && last.role === "ASSISTANT" && !!last.content.trim() && !last.errorMessage;
  }, [chat.isBusy, chat.status, chat.messages, privateMode]);
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

  // Navigation/page-close fallback. The normal End button awaits the same
  // idempotent endpoint; sendBeacon protects finalized turns when the view is
  // torn down before that interaction can happen.
  React.useEffect(() => {
    // Once End is pressed, keep the exact payload available until the explicit
    // save succeeds (or the user discards it). Unmount/new-chat can then retry
    // the same idempotent session with sendBeacon instead of losing the turn.
    if (!voiceOpen) return;
    if (privateMode || !voiceSessionIdRef.current) {
      voiceUnloadPayloadRef.current = null;
      return;
    }
    const turns = realtimeVoice.transcript
      .filter((line) => line.text.trim())
      .map((line) => ({
        role: line.role === "assistant" ? "ASSISTANT" : "USER",
        content: line.text,
        attachmentIds: line.attachments.map((attachment) => attachment.id),
      }));
    voiceUnloadPayloadRef.current = turns.length
      ? JSON.stringify({
          sessionId: voiceSessionIdRef.current,
          conversationId: currentConversationId,
          model,
          projectId: activeProjectId,
          connectors: enabledConnectors,
          turns,
        })
      : null;
  }, [activeProjectId, currentConversationId, enabledConnectors, model, privateMode, realtimeVoice.transcript, voiceOpen]);

  React.useEffect(
    () => () => {
      voiceSaveDetachedRef.current = true;
      const payload = voiceUnloadPayloadRef.current;
      if (!payload || typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
      navigator.sendBeacon("/api/voice/transcript", new Blob([payload], { type: "application/json" }));
    },
    []
  );

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
    // Keyed on messages.LENGTH, not the array: titling should fire when a turn
    // is added, not on every streamed delta that replaces the array identity.
    // chat.messages is read for its current contents at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Same reason as above: chat.messages is read fresh inside, but re-running
    // on every delta would re-schedule the title on each streamed character.
    // The status edge and the turn count are the real triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (voiceSavingRef.current) voiceSaveDetachedRef.current = true;
      const payload = voiceUnloadPayloadRef.current;
      if (payload && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/voice/transcript", new Blob([payload], { type: "application/json" }));
      }
      if (voiceOpenRef.current) {
        realtimeVoiceRef.current.end();
        setVoiceOpen(false);
      }
      realtimeVoiceRef.current.clearTranscript();
      voiceSessionIdRef.current = null;
      voiceUnloadPayloadRef.current = null;
      setVoiceSaveError(null);
      setVoiceTurnSending(false);
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

  const exitPrivateMode = React.useCallback(() => {
    setPrivateMode(false);
    setForkedFrom(null);
    chat.reset();
    setActiveConversationId(null);
    createdIdRef.current = null;
    forkPayloadRef.current = null;
    setOpenArtifactId(null);
    setComposerQuote(null);
    setFullscreen(false);
    document.documentElement.removeAttribute("data-private-mode");
    router.push("/chat");
    window.dispatchEvent(new CustomEvent("juno:new-chat"));
  }, [chat, router, setActiveConversationId]);

  const togglePrivateMode = React.useCallback(() => {
    if (chat.isBusy || voiceOpen || voiceSaving || voiceSaveError || voiceTurnSending) return;
    if (privateMode) {
      exitPrivateMode();
      return;
    }
    const next = true;
    createdIdRef.current = null;
    forkPayloadRef.current = null;
    setPrivateMode(next);
    setForkedFrom(null);
    chat.reset();
    setActiveConversationId(null);
    setOpenArtifactId(null);
    setComposerQuote(null);
    setFullscreen(false);
    // Connectors reach third-party servers, so never carry them into incognito.
    setEnabledConnectors([]);
    if (conversationId) router.push("/chat");
  }, [chat, conversationId, exitPrivateMode, privateMode, router, setActiveConversationId, voiceOpen, voiceSaveError, voiceSaving, voiceTurnSending]);

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
      chat.send(initialPrompt, [], initialPromptResearch ? { deepResearch: true } : undefined);
      // Clear ?q= so a refresh doesn't resend.
      window.history.replaceState({}, "", "/chat");
    }
    // Deliberately fires only on the prompt arriving. autoSentRef already makes
    // this once-only, and depending on `chat` would re-run it every time the
    // hook's identity changed — i.e. re-send the prompt mid-conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const openArtifact = React.useMemo(
    () => chat.artifacts.find((a) => a.id === openArtifactId) ?? null,
    [chat.artifacts, openArtifactId]
  );

  // ?artifact= deep link (library → "open in its conversation"): open the named
  // canvas once per identifier. Keyed by identifier, not a boolean — a client
  // -side navigation that only swaps ?artifact= re-renders this same mounted
  // ChatView, and the new target must still open; a plain "consumed" flag would
  // swallow it. Closing the canvas afterwards stays closed (same identifier).
  const deepLinkConsumedRef = React.useRef<string | null>(null);
  // App Router PRESERVES this component instance across /chat/A → /chat/B soft
  // navigations, so the ref must reset per conversation — identifiers repeat
  // across conversations ("pomodoro" here is not "pomodoro" there), and a
  // stale consumed mark would silently swallow the second deep link.
  React.useEffect(() => {
    deepLinkConsumedRef.current = null;
  }, [conversationId]);
  React.useEffect(() => {
    if (!initialArtifactIdentifier || deepLinkConsumedRef.current === initialArtifactIdentifier) return;
    const a = chat.artifacts.find((x) => x.identifier === initialArtifactIdentifier);
    if (!a) return;
    deepLinkConsumedRef.current = initialArtifactIdentifier;
    setOpenArtifactId(a.id);
    setThoughtOpenId(null);
  }, [chat.artifacts, initialArtifactIdentifier]);

  /**
   * ?m= deep link — global search landing on the exact message it matched.
   *
   * A search result that only opens the conversation makes the reader find the
   * line again themselves, in a transcript that can be hundreds of turns long;
   * finding it was the thing they asked for. The anchor is the per-message
   * wrapper MessageList renders (`data-message-id`), the same one
   * ConversationFind jumps to, so this stays independent of how a message is
   * laid out.
   *
   * Consumed once per id, and only after the message is actually in the DOM:
   * MessageList virtualises nothing but does mount after the first paint, so a
   * single unconditional scroll on mount lands on nothing. `behavior: "auto"`
   * rather than "smooth" because MessageList pins scrollTop to the bottom on
   * mount, and a smooth scroll would spend half a second losing that fight in
   * full view of the user.
   */
  const focusedMessageRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    focusedMessageRef.current = null;
  }, [conversationId]);
  React.useEffect(() => {
    if (!initialFocusMessageId || focusedMessageRef.current === initialFocusMessageId) return;
    const el = document.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(initialFocusMessageId)}"]`
    );
    if (!el) return;
    focusedMessageRef.current = initialFocusMessageId;
    el.scrollIntoView({ block: "center" });
  }, [chat.messages, initialFocusMessageId]);

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
    // Matches the duration-fast exit — long enough for the fade, short enough
    // that a reopen never waits on a stale panel.
    const t = window.setTimeout(() => setClosingArtifact(null), 200);
    return () => window.clearTimeout(t);
  }, [openArtifact, closingArtifact]);

  const openArtifactByIdentifier = (identifier: string, opts?: { fullscreen?: boolean }) => {
    if (voiceOpen && typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      toast.error("End voice mode before opening an artifact on this screen, so the microphone controls stay visible.");
      return;
    }
    const a = chat.artifacts.find((x) => x.identifier === identifier);
    if (a) {
      setOpenArtifactId(a.id);
      setFullscreen(!!opts?.fullscreen);
      // COEXISTENCE RULE: the canvas and the thought panel are both docked right
      // columns, and chat + canvas + panel does not fit — the canvas alone
      // already reserves CHAT_MIN_WIDTH for what is left. So they are mutually
      // exclusive: the newest request wins and the other yields. Whichever the
      // user just asked for is the one they want to look at.
      setThoughtOpenId(null);
    }
  };

  const openThoughtPanel = React.useCallback(
    (id: string | null) => {
      setThoughtOpenId(id);
      if (id) closeArtifact();
    },
    [closeArtifact]
  );

  // SELF-HEAL. `openArtifact` is DERIVED from chat.artifacts, so every path that
  // replaces the transcript drops the canvas for free. `thoughtOpenId` is raw
  // state rendered directly, so it must be reconciled here or the dock outlives
  // the message it names: chat.reset() (new chat, private-mode toggle),
  // applyFork, switching conversations, and regenerate (which re-adds the answer
  // under a fresh id) all unmount the ActivityTimeline that portals the panel —
  // and with it the only close button. What is left is an empty bg-card column
  // that hides the whole chat below lg. One reconciliation covers them all;
  // clearing at each call site would keep missing the ones that are not call
  // sites at all.
  React.useEffect(() => {
    if (!thoughtOpenId) return;
    if (!chat.messages.some((m) => m.id === thoughtOpenId)) setThoughtOpenId(null);
  }, [chat.messages, thoughtOpenId]);

  // Esc closes the dock. The Sheet used to give us this for free; a docked,
  // non-modal panel has to ask. Bound while open only, so it never competes
  // with the composer's own Esc handling when there is nothing to close.
  React.useEffect(() => {
    if (!thoughtOpenId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // ONLY IF NO NEARER LAYER CLAIMED IT. At lg the chat stays typeable beside
      // the dock, so the composer's slash palette and quote chip are live at the
      // same time; both preventDefault on their own Escape but the native event
      // still bubbles up to window. Without this check one Escape dismisses the
      // palette AND destroys the panel the user is reading next to it.
      if (e.key === "Escape" && !e.defaultPrevented) setThoughtOpenId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [thoughtOpenId]);

  const thoughtPanel = React.useMemo(
    () => ({ openId: thoughtOpenId, setOpenId: openThoughtPanel, container: thoughtContainer }),
    [thoughtOpenId, openThoughtPanel, thoughtContainer]
  );

  /* ─── The two docked columns ───────────────────────────────────────────────
   * Both are `useSplitPane` now (src/hooks/use-split-pane.ts), which is where
   * the ~180 lines this replaced went: two copies of pointer capture, cursor
   * and user-select save/restore, clamp-on-resize and persistence, sitting 700
   * lines apart in this file and already disagreeing about three things. The
   * Work rail is the same object again on a different page, which is what made
   * a third copy unthinkable.
   *
   * What each one still owns is exactly what differs: its bounds, whether it
   * has a CSS default to fall back to, and whether it may take the sidebar.
   */
  const canvas = useSplitPane({
    storageKey: CANVAS_WIDTH_KEY,
    containerRef: layoutRef,
    bounds: canvasWidthBounds,
    // 46% of the container, not a stored constant: the canvas has no CSS
    // default, so "reset" has to be a measurement.
    resetWidth: (containerWidth) => Math.round(containerWidth * 0.46),
    ssrWidth: CANVAS_SSR_WIDTH,
    applies: splitResizeApplies,
    active: !!openArtifact && !fullscreen,
    // The canvas is the one pane with a legitimate "must be huge" case — it
    // holds documents being edited — so a drag past the max asks the shell for
    // the sidebar's width rather than simply refusing.
    onRequestRoom: () => window.dispatchEvent(new CustomEvent("juno:collapse-sidebar")),
  });
  const reclampCanvas = canvas.reclamp;

  const thought = useSplitPane({
    storageKey: THOUGHT_WIDTH_KEY,
    containerRef: layoutRef,
    bounds: thoughtWidthBounds,
    // THE DEFAULT DOES NOT MOVE: null, not a recomputed number, so an undragged
    // dock keeps rendering `lg:w-[30rem]` itself and stays honest at a root font
    // size that is not 16px.
    resetWidth: () => null,
    cssWidth: THOUGHT_DEFAULT_WIDTH,
    applies: splitResizeApplies,
    active: thoughtOpenId != null,
    // Deliberately no `onRequestRoom`. The canvas escalates because of what it
    // holds; the dock is capped at 60% and reading receipts is never worth
    // eating the sidebar.
    onUserResize: () => setAnimateDock(false),
  });

  // Each open is a fresh mount of the dock, so the entrance is re-armed here
  // rather than left disarmed by a drag in a previous open. Separate from the
  // hook because it is about the dock's animation, not about its width.
  React.useEffect(() => setAnimateDock(true), [thoughtOpenId]);

  // Opening a canvas into a container too narrow for both columns buys the
  // sidebar's width first and re-measures on the next frame. The threshold is
  // "neither column can have its minimum plus a gap", which is a different
  // question from the drag-time one above: this one fires with no pointer
  // anywhere near the handle.
  React.useEffect(() => {
    if (!openArtifact || fullscreen) return;
    const availableWidth = layoutRef.current?.getBoundingClientRect().width;
    if (!availableWidth || availableWidth >= CANVAS_MIN_WIDTH + CHAT_MIN_WIDTH + 32) return;
    window.dispatchEvent(new CustomEvent("juno:collapse-sidebar"));
    window.requestAnimationFrame(() => reclampCanvas());
    // `reclampCanvas`, not `canvas`: the hook hands back a fresh object every
    // render (its width changes on every pointer move), so depending on the
    // whole thing would re-run this on each of them — i.e. fire
    // `juno:collapse-sidebar` on repeat while a narrow layout stayed narrow.
  }, [fullscreen, openArtifact, reclampCanvas]);

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
    // Re-point the canvas at the saved artifact, but never RE-OPEN it. This
    // fires from fetch closures in CanvasPanel that resolve independently of
    // CanvasPanel's lifetime, so by the time a save lands the user may have
    // opened a thought dock — which closed the canvas on purpose (see the
    // COEXISTENCE RULE in openArtifactByIdentifier). Forcing it back open would
    // put both docked columns in flow at once and crush the chat to zero width.
    setOpenArtifactId((prev) => (prev ? updated.id : prev));
  };

  const voiceMessages = React.useMemo<ChatMessage[]>(() => {
    const lines: ChatMessage[] = realtimeVoice.transcript.map((line) => ({
      id: `voice-${line.id}`,
      role: line.role === "assistant" ? "ASSISTANT" : "USER",
      content: line.text,
      model: null,
      createdAt: line.createdAt,
      attachments: line.attachments,
      streaming: !line.final,
      voice: true,
    }));
    if (realtimeVoice.speechInterim.trim()) {
      lines.push({
        id: "voice-speech-interim",
        role: "USER",
        content: realtimeVoice.speechInterim,
        model: null,
        createdAt: new Date().toISOString(),
        attachments: [],
        streaming: true,
        voice: true,
      });
    }
    return lines;
  }, [realtimeVoice.speechInterim, realtimeVoice.transcript]);
  const displayMessages = React.useMemo(() => [...chat.messages, ...voiceMessages], [chat.messages, voiceMessages]);
  const hasMessages = displayMessages.length > 0 || voiceOpen;

  /* ─── First-message handoff ────────────────────────────────────────────────
   * The centered empty-state composer and the transcript's bottom dock are two
   * different subtrees, so React swaps them in one commit and the composer
   * teleported. document.startViewTransition cannot make this a shared-element
   * move cheaply: the swap is committed from inside useChat's own state updates
   * — the optimistic append, sometimes seconds after Send while the clarify
   * preflight runs — so there is no single DOM-mutation callback to hand the
   * API without freezing a page snapshot across a network wait. The swap is
   * choreographed by hand on the token ladder instead:
   *
   *   "leaving"  — the empty branch stays mounted for one exit beat
   *                (--dur-exit) while the greeting plays title-out: up and out.
   *   "entering" — the branches swap; the dock composer plays a measured
   *                translate from where the centered composer stood
   *                (--dur-slow / --ease-out-expo: long travel, no overshoot)
   *                while the transcript fades in beneath it.
   *
   * Armed only by a send from the empty composer. `hasMessages` also flips when
   * messages arrive by other routes — voice opening, a fork seeding, the
   * preserved App Router instance switching conversations — and replaying a
   * "first message" ceremony there would be motion narrating nothing. Reduced
   * motion never arms: this is travel, Tier B collapses it to the plain swap.
   */
  const [handoff, setHandoff] = React.useState<"leaving" | "entering" | null>(null);
  const [handoffSeen, setHandoffSeen] = React.useState(hasMessages);
  const handoffArmedAtRef = React.useRef(0);
  const handoffFromTopRef = React.useRef<number | null>(null);
  const emptyComposerRef = React.useRef<HTMLDivElement>(null);
  const dockComposerRef = React.useRef<HTMLDivElement>(null);
  if (hasMessages !== handoffSeen) {
    // Render-phase adjustment (the documented React pattern), so the exit beat
    // is in place in the SAME commit that would otherwise unmount the greeting.
    setHandoffSeen(hasMessages);
    if (
      hasMessages &&
      handoffArmedAtRef.current !== 0 &&
      // Generous on purpose: the clarify preflight can hold the optimistic
      // append for ~3.5s before the transcript exists.
      Date.now() - handoffArmedAtRef.current < 8000 &&
      typeof window !== "undefined" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setHandoff("leaving");
    }
  }

  React.useEffect(() => {
    if (handoff === null) return;
    if (!hasMessages) {
      // The transcript went away mid-ceremony (new chat, reset) — stand down.
      setHandoff(null);
      return;
    }
    if (handoff !== "leaving") return;
    handoffArmedAtRef.current = 0;
    // Measured now, not at send: the empty branch is still on screen during
    // the exit beat, and this is the composer's final resting place.
    handoffFromTopRef.current = emptyComposerRef.current?.getBoundingClientRect().top ?? null;
    const root = getComputedStyle(document.documentElement);
    const exitMs = parseFloat(root.getPropertyValue("--dur-exit")) || 160;
    const t = window.setTimeout(() => setHandoff("entering"), exitMs);
    return () => window.clearTimeout(t);
  }, [handoff, hasMessages]);

  // Layout effect so the travel's first painted frame already shows the dock
  // composer back at the centered position — an effect would flash it docked.
  React.useLayoutEffect(() => {
    if (handoff !== "entering") return;
    const el = dockComposerRef.current;
    const from = handoffFromTopRef.current;
    handoffFromTopRef.current = null;
    let travel: Animation | undefined;
    if (el && from != null && typeof el.animate === "function") {
      const dy = from - el.getBoundingClientRect().top;
      // Only when there is real distance to close — a sub-pixel "move" would
      // still cost a compositor layer and say nothing.
      if (Math.abs(dy) > 12) {
        const root = getComputedStyle(document.documentElement);
        travel = el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
          duration: parseFloat(root.getPropertyValue("--dur-slow")) || 360,
          easing: root.getPropertyValue("--ease-out-expo").trim() || "ease-out",
        });
      }
    }
    // Not a motion duration — just the moment the flag (and the transcript's
    // one-shot entrance class) can be dropped, safely past the longest strand.
    const t = window.setTimeout(() => setHandoff(null), 600);
    return () => {
      window.clearTimeout(t);
      travel?.cancel();
    };
  }, [handoff]);

  // NB: `quota.limit != null` is load-bearing and must not be "tidied" into a
  // truthiness check — Free's limit is 0, and `0 != null` is what keeps the
  // gate on for that plan at all.
  const quotaReached = quota.limit != null && quota.remaining != null && quota.remaining <= 0;
  // A plan with no allowance at all is a different situation from one that has
  // been used up, and telling someone they "reached their limit" on their first
  // visit — before they have sent anything — is simply untrue.
  const planIncludesNoMessages = quota.limit === 0;
  const planAllowsVoice = PLANS[quota.plan].voice;
  // Model-parameters live beside the incognito ghost (top-right) so the composer
  // stays uncluttered. Only meaningful for chat models.
  const resolvedModelInfo = resolveModel(model);
  const paramsIsChat = (resolvedModelInfo?.modality ?? "chat") === "chat";
  const paramsCanWebSearch =
    PLANS[quota.plan].webSearch && paramsIsChat && (resolvedModelInfo?.webSearch ?? false);

  // Composer aura. Two inputs travel down as custom properties on the host:
  // the lab colour (inert until :focus-within reads it) and how hard the model
  // is set to think, which drives both how bright and how big the bloom is.
  //
  // The effort is clamped to what the model actually accepts first — a sticky
  // "max" carried over from the last model would otherwise light the page at
  // full burn for a model that silently runs it at high.
  //
  // A model with no effort control is not "thinking at zero", it is a question
  // the slider never asks, so those sit at the middle of the ramp — as does an
  // unresolved model, by way of the property's initial-value.
  //
  // The test is whether a control is actually on screen, so it mirrors the
  // composer's own gate exactly (composer.tsx: `isAuto || !resolved ? [] :
  // reasoningOptions(resolved)`). The obvious `model.reasoning` is NOT that
  // test, in two ways. Eleven shipped models — Kimi K2.7 Code, DeepSeek
  // Reasoner, Magistral, several Grok and MiniMax — declare reasoning: true but
  // expose no tiers, so they would have clamped to null and lit the page at its
  // dimmest with no slider anywhere to explain why. And Auto resolves with the
  // full ladder while showing no slider at all, so it would have been driven by
  // a sticky global pref that Auto ignores on the wire anyway.
  const auraStyle = React.useMemo(() => {
    if (!resolvedModelInfo) return undefined;
    const hasEffortControl = !isAutoModelId(model) && reasoningOptions(resolvedModelInfo).length > 0;
    const think = hasEffortControl
      ? reasoningGlow(clampReasoningEffort(resolvedModelInfo, reasoningEffort ?? null))
      : 0.5;
    return {
      "--aura-provider": providerGlow(resolvedModelInfo.provider),
      "--aura-think": think,
    } as React.CSSProperties;
  }, [resolvedModelInfo, reasoningEffort, model]);

  const thinkingGlow = React.useMemo(() => {
    switch (reasoningEffort) {
      case "max":
        return {
          opacity: 0.52,
          width: "min(750px, 94%)",
          height: "270px",
          blur: "115px",
          // Exclusive deep bloom transition from accent color to violet and purple
          gradient: "radial-gradient(ellipse at center, hsl(var(--primary)) 0%, #8b5cf6 36%, #a855f7 64%, transparent 78%)",
        };
      case "xhigh":
        return {
          opacity: 0.44,
          width: "min(690px, 90%)",
          height: "245px",
          blur: "100px",
          // Pure rich accent color
          gradient: "radial-gradient(ellipse at center, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.7) 45%, hsl(var(--primary) / 0.25) 68%, transparent 78%)",
        };
      case "high":
        return {
          opacity: 0.36,
          width: "min(630px, 86%)",
          height: "220px",
          blur: "90px",
          gradient: "radial-gradient(ellipse at center, hsl(var(--primary)) 0%, hsl(var(--primary) / 0.6) 45%, transparent 75%)",
        };
      case "medium":
        return {
          opacity: 0.28,
          width: "min(570px, 82%)",
          height: "200px",
          blur: "85px",
          gradient: "radial-gradient(ellipse at center, hsl(var(--primary) / 0.85) 0%, hsl(var(--primary) / 0.45) 45%, transparent 72%)",
        };
      case "low":
        return {
          opacity: 0.22,
          width: "min(520px, 78%)",
          height: "180px",
          blur: "80px",
          gradient: "radial-gradient(ellipse at center, hsl(var(--primary) / 0.7) 0%, hsl(var(--primary) / 0.35) 45%, transparent 70%)",
        };
      case "minimal":
      default:
        // Instant / none / minimal: clearly visible, soft accent baseline glow
        return {
          opacity: 0.16,
          width: "min(470px, 74%)",
          height: "160px",
          blur: "75px",
          gradient: "radial-gradient(ellipse at center, hsl(var(--primary) / 0.55) 0%, hsl(var(--primary) / 0.22) 45%, transparent 68%)",
        };
    }
  }, [reasoningEffort]);

  // Send swells the bloom once. Cleared on a timer rather than animationend:
  // under prefers-reduced-motion the keyframes are switched off, so that event
  // would never arrive and the class would stick for the rest of the session.
  const [auraSending, setAuraSending] = React.useState(false);
  React.useEffect(() => {
    if (!auraSending) return;
    const t = window.setTimeout(() => setAuraSending(false), 1150);
    return () => window.clearTimeout(t);
  }, [auraSending]);

  // Read-aloud: clicking the active message again stops playback.
  const [speakingId, setSpeakingId] = React.useState<string | null>(null);

  // Find-in-conversation. Opens on Cmd/Ctrl+F, which is a deliberate override
  // of the browser's own find: the native one searches only what is painted,
  // and the transcript is a scroll container, so it silently misses most of the
  // conversation. Escape closes and returns focus to the page.
  const [findOpen, setFindOpen] = React.useState(false);
  React.useEffect(() => {
    // Every early return below shares one rule: never preventDefault unless the
    // find bar is genuinely about to appear and search what the user is looking
    // at. Suppressing the browser's own find and putting nothing usable in its
    // place is worse than not binding the key at all.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      // Only take the shortcut when there is actually a transcript to search.
      // The find bar renders inside the `hasMessages` branch, so on an empty
      // chat preventDefault would suppress the BROWSER's find and show nothing
      // in its place.
      if (!hasMessages) return;
      // On macOS, Ctrl+F inside a text field is the system emacs binding for
      // "move the caret forward one character". Taking it there replaces a
      // keystroke people use continuously with a search bar.
      const target = e.target as HTMLElement | null;
      const editing =
        target?.isContentEditable ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement;
      if (isApplePlatform() && e.ctrlKey && !e.metaKey && editing) return;
      // The canvas code editor is a plain textarea with no find of its own, so
      // the browser's is the only one that searches the code on screen. This bar
      // would search the chat transcript instead — the wrong content entirely.
      if (target?.closest("[data-code-surface]")) return;
      // A modal is open: the bar renders behind the overlay, so the keystroke
      // would look like it did nothing while still killing native find.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasMessages]);
  const handleSpeak = (id: string, text: string) => {
    if (speakingId === id) {
      tts.stop();
      setSpeakingId(null);
      return;
    }
    setSpeakingId(id);
    tts.speak(cleanForSpeech(text), settings.voiceId).finally(() => setSpeakingId((cur) => (cur === id ? null : cur)));
  };

  const sendFromComposer = React.useCallback(
    async (text: string, attachments: import("@/types/chat").ClientAttachment[], options?: import("@/hooks/use-chat").SendOptions) => {
      if (voiceSavingRef.current || voiceSaveError) {
        toast.error(voiceSaveError ?? "Wait for the voice transcript to finish saving.");
        return { accepted: false };
      }
      // Past the guards that can still refuse the turn, so the aura only swells
      // for a send that is actually going out.
      setAuraSending(true);
      // Arm the first-message handoff (see the choreography block above). The
      // send can still be refused downstream, in which case the transcript
      // never appears and the arm simply expires.
      if (!hasMessages) handoffArmedAtRef.current = Date.now();
      if (!voiceOpen) return chat.send(text, attachments, options);
      if (voiceTurnSendingRef.current) return { accepted: false };
      if (realtimeVoice.status !== "live") {
        toast.error("Voice is still connecting. Try again in a moment.");
        return { accepted: false };
      }
      if (attachments.some((attachment) => attachment.kind !== "IMAGE")) {
        toast.error("Voice mode can receive images, but not document attachments yet.");
        return { accepted: false };
      }
      if (attachments.length > 4) {
        toast.error("Voice mode accepts up to 4 images in one turn.");
        return { accepted: false };
      }
      voiceTurnSendingRef.current = true;
      setVoiceTurnSending(true);
      try {
        const accepted = await realtimeVoice.sendTurn(text, attachments);
        if (!accepted) {
          toast.error(attachments.length ? "This voice provider can’t view images. Switch to OpenAI, Gemini, or Qwen." : "Voice could not send that turn.");
        }
        return { accepted };
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Voice could not send that turn.");
        return { accepted: false };
      } finally {
        voiceTurnSendingRef.current = false;
        setVoiceTurnSending(false);
      }
    },
    [chat, hasMessages, realtimeVoice, voiceOpen, voiceSaveError]
  );

  const openVoice = React.useCallback(() => {
    if (privateMode || chat.isBusy || chat.pendingClarification || voiceSavingRef.current || voiceSaveError) return;
    closeArtifact();
    setComposerQuote(null);
    realtimeVoice.clearTranscript();
    voiceSaveDetachedRef.current = false;
    voiceUnloadPayloadRef.current = null;
    voiceSessionIdRef.current = crypto.randomUUID();
    setVoiceOpen(true);
    const history = chat.messages
      .filter((message) => (message.role === "USER" || message.role === "ASSISTANT") && message.content.trim())
      .map((message) => ({
        role: message.role === "ASSISTANT" ? ("assistant" as const) : ("user" as const),
        text: message.content,
      }));
    void realtimeVoice.start(undefined, history);
  }, [chat.isBusy, chat.messages, chat.pendingClarification, closeArtifact, privateMode, realtimeVoice, voiceSaveError]);

  const closeVoice = React.useCallback(() => {
    if (voiceSavingRef.current) return;
    if (voiceTurnSendingRef.current) {
      toast.error("Wait for the current voice turn to finish sending.");
      return;
    }
    setVoiceSaveError(null);
    const finalized = realtimeVoice.transcript
      .filter((line) => line.text.trim())
      .map((line) => ({ ...line, final: true }));
    const sessionId = voiceSessionIdRef.current ?? crypto.randomUUID();
    realtimeVoice.end();
    setVoiceOpen(false);
    if (privateMode || finalized.length === 0) {
      realtimeVoice.clearTranscript();
      voiceSessionIdRef.current = null;
      voiceUnloadPayloadRef.current = null;
      return;
    }
    const savePayload = JSON.stringify({
      sessionId,
      conversationId: currentConversationId,
      model,
      projectId: activeProjectId,
      connectors: enabledConnectors,
      turns: finalized.map((line) => ({
        role: line.role === "assistant" ? "ASSISTANT" : "USER",
        content: line.text,
        attachmentIds: line.attachments.map((attachment) => attachment.id),
      })),
    });
    voiceUnloadPayloadRef.current = savePayload;
    voiceSavingRef.current = true;
    setVoiceSaving(true);

    void (async () => {
      try {
        // Fetch keepalive is capped by browsers at roughly 64 KiB. It protects
        // normal sessions during navigation; larger transcripts still retain
        // the same idempotent payload for retry/beacon fallback.
        const keepalive = new TextEncoder().encode(savePayload).byteLength <= 60_000;
        const response = await fetch("/api/voice/transcript", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: savePayload,
          keepalive,
        });
        const data = (await response.json().catch(() => ({}))) as { conversationId?: string; messages?: ClientMessage[]; error?: string };
        if (!response.ok || !data.conversationId || !data.messages) throw new Error(data.error ?? "Could not save the voice transcript.");

        const detached = voiceSaveDetachedRef.current;
        if (!detached) {
          chat.setMessages((current) => {
            const known = new Set(current.map((message) => message.id));
            return [...current, ...data.messages!.filter((message) => !known.has(message.id))];
          });
        }
        realtimeVoice.clearTranscript();
        voiceSessionIdRef.current = null;
        voiceUnloadPayloadRef.current = null;
        setVoiceSaveError(null);
        const now = new Date().toISOString();
        if (!currentConversationId) {
          const title = finalized.find((line) => line.role === "user")?.text.slice(0, 48) || "Voice conversation";
          upsertConversation({
            id: data.conversationId,
            title,
            titleSource: "default",
            model,
            kind: "chat",
            pinned: false,
            folderId: null,
            projectId: activeProjectId,
            activeConnectors: enabledConnectors,
            lastMessageAt: now,
            createdAt: now,
          });
          if (!detached) {
            createdIdRef.current = data.conversationId;
            setActiveConversationId(data.conversationId);
            router.replace(`/chat/${data.conversationId}`);
          }
        } else {
          updateConversation(currentConversationId, { lastMessageAt: now });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "The voice transcript could not be saved.";
        setVoiceSaveError(message);
        toast.error("Voice transcript not saved yet. Retry or discard it below.");
      } finally {
        voiceSavingRef.current = false;
        setVoiceSaving(false);
      }
    })();
  }, [activeProjectId, chat, currentConversationId, enabledConnectors, model, privateMode, realtimeVoice, router, setActiveConversationId, updateConversation, upsertConversation]);

  const discardFailedVoiceSave = React.useCallback(() => {
    if (voiceSavingRef.current) return;
    realtimeVoice.clearTranscript();
    voiceSessionIdRef.current = null;
    voiceUnloadPayloadRef.current = null;
    setVoiceSaveError(null);
  }, [realtimeVoice]);

  const voiceSaveNotice = voiceSaving || voiceSaveError ? (
    <div
      role={voiceSaveError ? "alert" : "status"}
      aria-live="polite"
      className={cn(
        "mx-auto mb-2 flex w-[calc(100%-1rem)] max-w-2xl items-center gap-3 rounded-field border px-3 py-2 text-sm shadow-soft sm:w-full",
        // Both states now sit on the floating rung. They were on two different
        // grounds — a 5% destructive tint and `bg-background/85` behind a blur —
        // and on the #000 page those resolve to ~2.5% and ~0% lightness, so a
        // notice that floats over the transcript had the transcript showing
        // through it. The tone is carried by the border and the icon disc, which
        // is where it was legible in the first place.
        voiceSaveError
          ? "border-destructive/40 bg-popover text-foreground"
          : "border-border/70 bg-popover text-muted-foreground"
      )}
    >
      {/* One fixed 28px leading slot for both states. Saving showed a bare 16px
          spinner and failing showed a 28px disc, so the row's text jumped 12px
          sideways at the exact moment the user was reading it. The error glyph
          was also a literal "!" character — a text baseline inside a circle
          never optically centres, and it is the one mark here not drawn from the
          icon set. */}
      <span
        aria-hidden
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          voiceSaving ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"
        )}
      >
        {voiceSaving ? <Loader2 className="size-4 animate-spin" /> : <StatusIcons.error className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{voiceSaving ? "Saving voice transcript…" : "Voice transcript isn’t saved yet"}</p>
        {voiceSaveError && <p className="mt-0.5 truncate text-xs text-muted-foreground">{voiceSaveError}</p>}
      </div>
      {voiceSaveError && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={closeVoice}
            className="pressable inline-flex h-9 items-center gap-1.5 rounded-control px-2.5 text-xs font-medium text-primary hover:bg-primary/10 coarse:h-11 coarse:px-3"
          >
            <ActionIcons.refresh className="size-3.5" />
            Retry
          </button>
          <Pressable
            kind="icon"
            size="lg"
            onClick={discardFailedVoiceSave}
            aria-label="Discard unsaved voice transcript"
            // danger-hover overrides the default accent fill: this one deletes.
            // It does that on its own — the selector is doubled (globals.css)
            // precisely so it outranks a variant's hover utility — so the
            // `hover:bg-transparent` that used to ride along here never painted
            // and only made it look as though two rules were fighting.
            className="danger-hover"
          >
            <ActionIcons.delete className="size-3.5" />
          </Pressable>
        </div>
      )}
    </div>
  ) : null;

  const composer = (
    <Composer
      conversationId={conversationId}
      model={model}
      onModelChange={setModel}
      onSend={sendFromComposer}
      isBusy={chat.isBusy}
      status={chat.status}
      // Stopping a deep-research turn has to stop BOTH halves. The stream is
      // only the tail of it: cancel the generation without cancelling the run
      // and a worker keeps searching and keeps spending against a turn nobody
      // is waiting for any more. Order matters — the run first, so the money
      // stops even if the stream teardown throws.
      onStop={
        researchSteering?.accepting
          ? () => {
              researchSteering.stop();
              chat.stop();
            }
          : chat.stop
      }
      steering={
        researchSteering?.accepting
          ? {
              active: true,
              placeholder: "Add a constraint, or paste a source to include…",
              onSteer: async (value: string) => {
                const accepted = await researchSteering.steer(value);
                if (accepted) toast.success("Added to this research run");
                else toast.error(research.notice ?? "That could not be added to the run.");
                return accepted;
              },
            }
          : null
      }
      pendingClarification={chat.pendingClarification}
      onSubmitClarification={(answers) => chat.resolvePendingClarification(answers)}
      onSkipClarification={() => chat.resolvePendingClarification([], true)}
      onCancelClarification={chat.cancelPendingClarification}
      onOpenVoiceMode={planAllowsVoice && !privateMode && !voiceOpen && !voiceSaving && !voiceSaveError && !voiceTurnSending && !chat.pendingClarification ? openVoice : undefined}
      quotaReached={quotaReached}
      planIncludesNoMessages={planIncludesNoMessages}
      canvasEnabled={canvasEnabled}
      onToggleCanvas={setCanvasEnabled}
      webSearchEnabled={webSearchEnabled}
      onToggleWebSearch={setWebSearchEnabled}
      reasoningEffort={reasoningEffort}
      onReasoningChange={setReasoningEffort}
      fastMode={fastMode}
      onToggleFastMode={setFastMode}
      proMode={proMode}
      onToggleProMode={setProMode}
      connectorsEnabled={enabledConnectors}
      onToggleConnector={toggleConnector}
      onEnableConnectors={enableConnectors}
      quote={composerQuote}
      onClearQuote={() => setComposerQuote(null)}
      privateMode={privateMode}
      voiceActive={voiceOpen}
      sendLocked={voiceSaving || !!voiceSaveError || voiceTurnSending}
      placeholder={
        privateMode
          ? "How can I help you today?"
          : voiceSaving
            ? "Saving voice transcript…"
            : voiceSaveError
              ? "Retry or discard the unsaved voice transcript above."
              : voiceTurnSending
                ? "Sending this voice turn…"
                : voiceOpen
                  ? "Type or attach an image while voice is active…"
                  : undefined
      }
      selectedProjectId={activeProjectId}
      onPickProject={handlePickProject}
      hideDisclaimer={true}
    />
  );

  return (
    <ThoughtPanelProvider value={thoughtPanel}>
    <div ref={layoutRef} data-juno-chat-root className="relative flex h-full min-h-0 w-full overflow-hidden">
      {/* Share + model parameters + the incognito ghost, on the same Y grid as
          the Chat/Work switcher — which they now genuinely are: the shell
          renders `#juno-top-actions-slot` in that header row and this portals
          into it. Before the slot existed this fell through to its own
          `absolute right-3 top-2.5`, i.e. three buttons floating over the top of
          the transcript (and over the canvas's own header, when one was open)
          under a header bar that had room for them and was otherwise empty. The
          fallback stays for the case the slot is absent — never in the shipping
          shell, but this component must not depend on a node it does not own. */}
      {(() => {
        const actionsContent = (
          <div
            className={cn(
              "flex items-center gap-1.5 transition-[opacity,transform] duration-base ease-out-soft",
              privateMode ? "pointer-events-none opacity-0" : "opacity-100",
              (openArtifact || thoughtOpenId) && "hidden lg:flex"
            )}
          >
            {/* Share — saved, non-private chats with at least one message. */}
            {!privateMode && currentConversationId && hasMessages && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Pressable
                    kind="icon"
                    size="lg"
                    aria-label="Share chat"
                    onClick={() => setShareOpen(true)}
                    className="text-foreground/75"
                  >
                    <ActionIcons.share className="size-4.5" />
                  </Pressable>
                </TooltipTrigger>
                <TooltipContent>Share chat</TooltipContent>
              </Tooltip>
            )}
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
            <PrivateChatToggle
              active={privateMode}
              disabled={chat.isBusy || voiceOpen || voiceSaving || !!voiceSaveError || voiceTurnSending}
              onToggle={togglePrivateMode}
            />
          </div>
        );

        /* ONE wrapper for both destinations, so the visibility rule is written
         * once: `hidden md:flex` is the cluster's own gate (below md the mobile
         * bar in AppShell carries navigation and this row does not exist), and
         * the fallback adds only the positioning it needs. Two separately
         * classed branches drifted the moment the shell grew a slot — the
         * portalled copy would have shown up on a phone, where nothing is
         * arranged for it. */
        const cluster = (
          <div
            className={cn(
              "hidden items-center gap-1.5 md:flex",
              !topActionsSlot && "absolute right-3 top-2.5 z-20"
            )}
          >
            {actionsContent}
          </div>
        );

        return topActionsSlot ? createPortal(cluster, topActionsSlot) : cluster;
      })()}

      {/* Chat column */}
      {/* Below lg the canvas replaces the chat entirely — a split there leaves the
          chat column narrower than a phone. The thought dock follows the same
          precedent for the same reason, rather than inventing a second story. */}
      <div
        className={cn(
          "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          (openArtifact || thoughtOpenId) && "hidden lg:flex"
        )}
      >
        {/* Project scope indicator — persistent while this chat is filed in a
            project. Brand-new chats use the composer chip until they exist.

            Floats over the thread rather than occupying a full-width band, so
            the reply keeps the vertical space. It keeps the same inset the
            top-right action cluster used to answer it with (left-3/top-3, md:4)
            now that the cluster has moved up into the shell's header row — the
            inset is the page's own margin for a thing floating over the
            transcript, not a relationship to a control that is no longer there.
            Anchored to the chat column, not the chat root: the root also hosts
            the canvas panel, and a root-anchored pill would strand itself over
            the canvas on the breakpoint where this column is hidden. */}
        {activeProjectId && !privateMode && currentConversationId && (
          // Below sm the pill also has to leave room for the top-right action
          // cluster (share / params / incognito ≈ 9rem incl. coarse targets)
          // sharing the same row — 18rem alone overlaps it under ~450px.
          <div className="pointer-events-none absolute left-3 top-3 z-20 flex max-w-[min(18rem,calc(100%-10rem))] sm:max-w-[min(18rem,calc(100%-1.5rem))] md:left-4 md:top-4">
            {/* `bg-popover`, opaque. This pill is absolutely positioned over the
                live transcript, and `bg-card/70` behind a blur resolves to ~4.6%
                on the black ground with nothing for the blur to smear — message
                text scrolled straight through the project name. */}
            <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-full border border-border/60 bg-popover py-1 pl-1 pr-1 shadow-soft motion-safe:animate-fade-in">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10">
                <AppIcons.projects className="size-3 text-primary" />
              </span>
              <span className="hidden font-mono text-label uppercase text-muted-foreground sm:inline">
                Project
              </span>
              <span aria-hidden className="hidden h-3 w-px shrink-0 bg-border/70 sm:block" />
              {projectMeta ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => router.push(`/projects/${activeProjectId}`)}
                      className="min-w-0 truncate text-sm font-medium text-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:underline motion-reduce:transition-none"
                    >
                      {projectMeta.name}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Open project</TooltipContent>
                </Tooltip>
              ) : (
                <span className="skeleton h-3.5 w-24 rounded-full" aria-hidden />
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Was 24px / 28px on touch — below every icon rung, and a
                      28px touch target on a page that commits to 44 everywhere
                      else. `sm` is the smallest rung that exists (28/36). */}
                  <Pressable
                    kind="icon"
                    size="sm"
                    onClick={() => handlePickProject(null)}
                    disabled={chat.isBusy}
                    aria-label="Remove from project"
                    className="shrink-0"
                  >
                    <ActionIcons.dismiss className="size-3.5" />
                  </Pressable>
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
                // Same reason as the project pill: this is a floating status
                // token wearing `shadow-glass`, so it belongs on the floating
                // rung rather than on 80% of a fill that is itself near black.
                "inline-flex items-center gap-2 rounded-full border border-border/60 bg-popover px-3 py-1 shadow-glass",
                memoryLeaving ? "motion-safe:animate-title-out motion-safe:[animation-fill-mode:forwards]" : "motion-safe:animate-rise-in"
              )}
            >
              <span className="relative flex size-1.5">
                {/* `pulse-ring`, not Tailwind's stock `ping`. Two reasons, both
                    about the system rather than this dot: ping runs a 2× scale on
                    `cubic-bezier(0,0,0.2,1)`, which is not on the ease ladder and
                    is a visibly wider halo than the identical indicator elsewhere
                    in the product; and `pulse-ring` is the named keyframe every
                    other live dot here uses, so there is one place to tune them.
                    Same reasoning as the note at research-run-panel.tsx. */}
                <span aria-hidden className="absolute inline-flex size-full rounded-full bg-primary opacity-70 motion-safe:animate-pulse-ring" />
                <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
              </span>
              <span className="font-mono text-label uppercase text-muted-foreground">Memory updated</span>
            </span>
          </div>
        )}

        {/* Incognito header — grid-rows collapse keeps height animation smooth. */}
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-slow ease-out-soft",
            privateMode ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          )}
        >
          <div className={cn("min-h-0 overflow-hidden", !privateMode && "pointer-events-none")}>
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-4 text-sm text-foreground/80 sm:px-5">
              {forkedFrom ? (
                <div className="inline-flex min-w-0 items-center gap-2 font-medium">
                  <GitFork className="size-4 shrink-0 text-primary" />
                  <span className="min-w-0 truncate">
                    Branched from <span className="font-serif italic">&ldquo;{forkedFrom.title}&rdquo;</span>
                  </span>
                  <span className="shrink-0 font-mono text-label uppercase text-muted-foreground">
                    {forkedFrom.count} {forkedFrom.count === 1 ? "message" : "messages"}
                  </span>
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 font-medium">
                  <PrivateGhostMark className="size-4 text-foreground/70" />
                  Incognito chat
                </div>
              )}
              <button
                type="button"
                onClick={exitPrivateMode}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-foreground/75 hover:bg-white/10 hover:text-foreground active:scale-95 transition-all duration-fast z-30 pointer-events-auto"
                aria-label={forkedFrom ? "Discard branch" : "Leave private chat"}
              >
                <ActionIcons.dismiss className="size-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Main column — settles into a quiet framed card in incognito. */}
        <div
          className={cn(
            // `motion-reduce:transition-none`: this animates margin and
            // border-radius, i.e. it reflows the whole transcript column over
            // `duration-slow`, and it had no escape for a reader who asked the
            // OS for less motion.
            "flex min-h-0 flex-1 flex-col overflow-hidden transition-[margin,border-radius,border-color,background-color,box-shadow] duration-slow ease-out-soft motion-reduce:transition-none",
            privateMode
              // `bg-card`, not `bg-card/50` — half a 6.5% fill over black is
              // ~3.3%, so the "quiet framed card" incognito settles into was a
              // rounded border with the page inside it.
              ? "m-2 rounded-popover border border-border/70 bg-card shadow-soft sm:m-3 sm:rounded-composer"
              : "m-0 rounded-none border border-transparent bg-transparent shadow-none"
          )}
        >
          {/* `handoff === "leaving"` holds the empty branch through its one exit
              beat after the first message lands — see the handoff block above. */}
          {hasMessages && handoff !== "leaving" ? (
            // Message view
            <div className="flex min-h-0 flex-1 flex-col relative h-full">
              {findOpen && (
                <ConversationFind messages={displayMessages} onClose={() => setFindOpen(false)} />
              )}
              <MessageList
                className={handoff === "entering" ? "motion-safe:animate-fade-in" : undefined}
                messages={displayMessages}
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
                conversationTitle={
                  privateMode
                    ? "Private chat"
                    : conversations.find((c) => c.id === currentConversationId)?.title || undefined
                }
              />
              {currentConversationId && !privateMode && (
                // Same width cap, centring and horizontal padding as the composer
                // itself (composer.tsx:~1153) — otherwise these sit against the
                // chat column's left edge while the composer is centred under
                // them, and the two never line up.
                <div className="mx-auto w-full max-w-[calc(100vw-1.5rem)] shrink-0 px-0 pb-2 sm:max-w-[48rem] sm:px-4">
                  <FollowUpSuggestions
                    conversationId={currentConversationId}
                    onPick={(t) => void sendFromComposer(t, [])}
                    visible={followUpsVisible}
                  />
                </div>
              )}
              <div
                ref={dockComposerRef}
                className={cn(
                  // `isolate` matters: the aura sits on z-index -1, and without a
                  // stacking context here it would escape this wrapper and paint
                  // behind the whole column instead of behind the composer.
                  // No transition-[padding] utility here: it would out-order the
                  // .composer-aura-host transition and drop the aura's colour and
                  // effort easing with it. That rule carries the padding now.
                  "composer-aura-host relative isolate w-full",
                  privateMode ? "px-2 pb-1 sm:px-4" : "px-0 pb-1",
                  auraSending && "is-sending"
                )}
                style={auraStyle}
              >
                {/* Voice field while a call is live */}
                {voiceOpen && !privateMode && (
                  <VoiceAura status={voiceAuraStatus(realtimeVoice)} levelRef={realtimeVoice.levelRef} />
                )}
                {voiceOpen && <RealtimeVoice voice={realtimeVoice} onClose={closeVoice} />}
                {voiceSaveNotice}
                {/* A deep-research turn gathers into a durable run attached to
                    this conversation. The panel is what remains once the turn
                    has streamed: stages, sources, and the pause/steer/cancel
                    controls the in-request pipeline had nowhere to put. Never in
                    incognito — that mode writes no rows to point at. */}
                {!privateMode && !voiceOpen && (
                  <ResearchRunPanel
                    run={research.run}
                    events={research.events}
                    busy={research.busy}
                    notice={research.notice}
                    post={research.post}
                    className="mx-auto mb-3 w-[calc(100%-1rem)] max-w-4xl sm:w-[calc(100%-2rem)]"
                  />
                )}
                {composer}
              </div>
              <p className="shrink-0 select-none pb-2 text-center text-caption leading-4 text-muted-foreground">
                {forkedFrom
                  ? "This branch isn't saved — it continues from the fork point with full context."
                  : privateMode
                    ? "Incognito chats are not saved or added to memory."
                    : "Juno can be wrong — worth a second look on anything that matters."}
              </p>
            </div>
          ) : (
            // Empty / greeting view. overflow-x-clip so the composer aura, which
            // is wider than the column it sits in, can never put a horizontal
            // scrollbar over dead space (it still scrolls vertically).
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-y-auto overflow-x-clip">
              <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center px-3 py-6 sm:px-5 md:py-8">
                {/*
                  `isolate` bounds where the aura is allowed to fall. It paints
                  on z-index -1, and the column below deliberately does NOT
                  create a stacking context, so without a floor here the bloom
                  would drop to whatever distant ancestor happens to establish
                  one and could end up behind an unrelated background.
                */}
                <div className="relative isolate flex w-full flex-col items-center justify-center">
                  {/* Headers cross-fade — opacity only; scale was causing a jump. */}
                  <div
                    className={cn(
                      "mb-4 grid w-full grid-cols-1 grid-rows-1 justify-items-center sm:mb-5",
                      // The greeting's exit beat: up and out on title-out while
                      // the composer below holds still for its travel. Forwards
                      // fill, or the final frame would snap back before the swap
                      // — same pattern as the memory pill above.
                      handoff === "leaving" &&
                        "motion-safe:animate-title-out motion-safe:[animation-fill-mode:forwards]"
                    )}
                  >
                    <div
                      className={cn(
                        "col-start-1 row-start-1 flex w-full flex-col items-center justify-center transition-opacity duration-slow ease-out-soft",
                        privateMode || chat.pendingClarification
                          ? "pointer-events-none opacity-0"
                          : "opacity-100"
                      )}
                    >
                      <EmptyGreeting />
                    </div>
                    <div
                      className={cn(
                        "col-start-1 row-start-1 flex w-full flex-col items-center justify-center transition-opacity duration-slow ease-out-soft",
                        privateMode && !chat.pendingClarification
                          ? "opacity-100"
                          : "pointer-events-none opacity-0"
                      )}
                    >
                      <PrivateGreeting />
                    </div>
                  </div>

                  <div
                    ref={emptyComposerRef}
                    className={cn(
                      // NO z-index here, deliberately. A z-index would make this
                      // a stacking context and flatten everything inside it into
                      // one layer — which is exactly what made the greeting hard
                      // to read: the aura is z-index -1, but trapped in this
                      // layer it was composited OVER the text above rather than
                      // under it. Without the stacking context the aura falls to
                      // the isolate above, below the greeting, while the panels
                      // the composer opens upward keep their own z-30 and stay
                      // above it. Raising the greeting instead would have put it
                      // over those panels.
                      "composer-aura-host relative w-full max-w-[44rem]",
                      auraSending && "is-sending"
                    )}
                    style={auraStyle}
                  >
                    {/* Dynamic Ambient Accent Glow behind Centered Composer */}
                    {!privateMode && !voiceOpen && (
                      <div
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -z-10 rounded-full transition-all duration-700 ease-out"
                        style={{
                          opacity: thinkingGlow.opacity,
                          width: thinkingGlow.width,
                          height: thinkingGlow.height,
                          filter: `blur(${thinkingGlow.blur})`,
                          background: thinkingGlow.gradient,
                        }}
                      />
                    )}
                    {voiceOpen && !privateMode && (
                      <VoiceAura status={voiceAuraStatus(realtimeVoice)} levelRef={realtimeVoice.levelRef} />
                    )}
                    {voiceOpen && <RealtimeVoice voice={realtimeVoice} onClose={closeVoice} />}
                    {voiceSaveNotice}
                    {composer}
                  </div>
                </div>
              </div>

              {/* Disclaimer — pinned to the bottom of the page, not centered with the greeting. */}
              <p
                className={cn(
                  "shrink-0 select-none pb-2 text-center text-caption leading-4 text-muted-foreground transition-opacity duration-slow ease-out-soft",
                  privateMode ? "pointer-events-none opacity-0" : "opacity-100"
                )}
              >
                Juno can be wrong — worth a second look on anything that matters.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Thought dock — a real column, not an overlay. The chat narrows beside it
          and stays fully readable, scrollable and typeable: no backdrop, no
          dimming, no focus trap, no scroll lock. Sized like the canvas (shrink-0
          column at lg, full-bleed below it) and, since this session, resizable
          like it too — the handle below.
          ActivityTimeline portals the panel in here — see thought-panel-context.
          `duration-slow` sits on an `animate-*` element ON PURPOSE, exactly as
          the canvas does below: tailwindcss-animate makes it the slide's
          duration, which is the intent — so it must come off during a drag, or
          every pointer move would re-trigger a 400ms slide. */}
      {thoughtOpenId && (
        <div
          ref={setThoughtContainer}
          style={thought.width != null ? ({ "--juno-thought-width": `${thought.width}px` } as React.CSSProperties) : undefined}
          className={cn(
            "relative z-40 size-full shrink-0 border-border/70 bg-card",
            // min-w-0 replaces the old lg:min-w-[26rem]: that floor would have
            // silently overridden any drag below 416px and made the new minimum
            // unreachable. The real floor is enforced by thoughtWidthBounds.
            "lg:min-w-0 lg:border-l",
            // Undragged: the ORIGINAL default class, byte-for-byte.
            thought.width == null ? "lg:w-[30rem]" : "lg:w-[var(--juno-thought-width)]",
            // The entrance is a MOUNT effect, so it is dropped for good the
            // moment the user grabs the handle. Re-adding `animate-in` after a
            // drag re-triggers it — the dock would replay its 400ms slide on
            // every pointer-up. `duration-slow` travels with the animate-*
            // classes it belongs to and is never left behind on its own.
            animateDock && "duration-base ease-out-expo motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4",
            thought.resizing && "select-none"
          )}
        >
          {/* Below lg the dock is full-bleed `w-full`, so there is nothing to
              resize and the handle is display:none — matching the canvas. */}
          <button
            type="button"
            {...thought.separatorProps}
            aria-label="Resize thought process panel"
            title="Drag to resize. Arrow keys adjust, Home resets."
            className="group absolute inset-y-0 left-0 z-popper hidden w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center lg:flex"
          >
            {/* `bg-popover`. The grip was `bg-background/90` behind a blur — the
                page colour, over the page, i.e. a handle whose only visible part
                was its 1px border. It floats above two panels, so it takes the
                floating rung. */}
            <span className="flex h-12 w-1.5 items-center justify-center rounded-full border border-border/70 bg-popover text-muted-foreground opacity-0 shadow-soft transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
              <GripVertical className="size-3.5" />
            </span>
          </button>
        </div>
      )}

      {/* Canvas — settles in from the right edge it docks against: a short
          16px slide + fade, not a full-width sweep, so opening reads as the
          card "handing off" to the workspace rather than a scene change. On
          close it lingers (absolute, so the chat reflows underneath) while the
          brief fade-out plays, then unmounts. */}
      {(openArtifact ?? closingArtifact) && (
        <div
          style={{ "--juno-canvas-width": `${canvas.width ?? CANVAS_SSR_WIDTH}px` } as React.CSSProperties}
          className={cn(
            "relative z-40 size-full bg-background lg:w-[var(--juno-canvas-width)] lg:min-w-[420px] lg:shrink-0 lg:border-l",
            canvas.resizing ? "select-none transition-none" : "ease-out-expo",
            openArtifact
              ? !canvas.resizing && "duration-base animate-in fade-in slide-in-from-right-4"
              : "pointer-events-none absolute inset-y-0 right-0 duration-fast animate-out fade-out slide-out-to-right-4 fill-mode-forwards",
            openArtifact && !fullscreen && "lg:relative"
          )}
        >
          {/* The same separator contract the dock has, which this handle
              lacked: it was a focusable button labelled "Resize canvas" that
              answered no key at all, so a keyboard user could reach it, be told
              it resized the canvas, and find that nothing did. Arrows and Home
              work here too now — the drag, the persistence key and the sidebar
              escalation are untouched. */}
          {openArtifact && !fullscreen && (
            <button
              type="button"
              {...canvas.separatorProps}
              aria-label="Resize canvas"
              title="Drag to resize canvas. Arrow keys adjust, Home resets."
              className="group absolute inset-y-0 left-0 z-popper hidden w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center lg:flex"
            >
              <span className="flex h-12 w-1.5 items-center justify-center rounded-full border border-border/70 bg-popover text-muted-foreground opacity-0 shadow-soft transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                <GripVertical className="size-3.5" />
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
            shareable={!privateMode}
          />
        </div>
      )}

      {currentConversationId && (
        <ShareDialog kind="CHAT" conversationId={currentConversationId} open={shareOpen} onOpenChange={setShareOpen} />
      )}

    </div>
    </ThoughtPanelProvider>
  );
}
