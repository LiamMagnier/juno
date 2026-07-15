"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  AudioLines,
  Blocks,
  Box,
  Brain,
  Check,
  ChevronDown,
  FileText,
  FileUp,
  Globe,
  ImagePlus,
  LayoutTemplate,
  Library,
  Loader2,
  Mic,
  Plug,
  Plus,
  Search,
  Square,
  SquareDashedMousePointer,
  SquarePen,
  Telescope,
  TextQuote,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { ModelSelector } from "@/components/chat/model-selector";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerClarificationPopover } from "@/components/chat/composer-clarification-popover";
import { resolveModel, type ModelInfo } from "@/lib/models";
import { reasoningOptions, defaultReasoning } from "@/lib/model-metrics";
import { PROVIDERS } from "@/lib/providers";
import { PLANS } from "@/lib/plans";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { useApp } from "@/components/app/app-provider";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import { formatBytes, cn } from "@/lib/utils";
import { serializeQuote, quoteLocationLabel, type ComposerQuote } from "@/lib/quote-context";
import type { ModelId } from "@/lib/models";
import type {
  PendingPreflightClarification,
  PreflightClarificationAnswer,
  PreflightClarificationAnswerValue,
} from "@/lib/preflight-clarification";
import type { SendOptions, SendResult } from "@/hooks/use-chat";
import type { ClientAttachment, GenerationStatus, ReasoningEffort } from "@/types/chat";

interface ComposerProps {
  conversationId: string | null;
  model: ModelId;
  onModelChange: (m: ModelId) => void;
  onSend: (text: string, attachments: ClientAttachment[], options?: SendOptions) => Promise<SendResult> | SendResult | void;
  isBusy: boolean;
  status: GenerationStatus;
  onStop: () => void;
  pendingClarification?: PendingPreflightClarification | null;
  onSubmitClarification?: (answers: PreflightClarificationAnswer[]) => Promise<SendResult> | SendResult | void;
  onSkipClarification?: () => Promise<SendResult> | SendResult | void;
  onCancelClarification?: () => void;
  onOpenVoiceMode?: () => void;
  quotaReached?: boolean;
  canvasEnabled: boolean;
  onToggleCanvas: (v: boolean) => void;
  webSearchEnabled?: boolean;
  onToggleWebSearch?: (v: boolean) => void;
  reasoningEffort: ReasoningEffort | null;
  onReasoningChange: (e: ReasoningEffort | null) => void;
  connectorsEnabled?: string[];
  onToggleConnector?: (id: string) => void;
  /** Quoted artifact selection ("select → modify/ask") attached to the next message. */
  quote?: ComposerQuote | null;
  onClearQuote?: () => void;
  placeholder?: string;
  privateMode?: boolean;
  /** Realtime voice is live: keep this surface focused on text + images only. */
  voiceActive?: boolean;
  /** Temporarily block edits/submission without turning the primary action into
   * the normal chat Stop button (voice image conversion/transcript saving). */
  sendLocked?: boolean;
  hideDisclaimer?: boolean;
  // The project this chat is filed under. For a brand-new chat (no conversation
  // yet) this is the project the next message will be created in.
  selectedProjectId?: string | null;
  onPickProject?: (projectId: string | null) => void;
  onDictatingChange?: (dictating: boolean) => void;
}

// Slash commands typed into the composer (e.g. "/model", "/projects", "/artifact").
type SlashCommand = { id: string; label: string; hint: string; run?: () => void };
type SlashItem = ModelInfo | SlashCommand;
type SlashState = { kind: "model"; items: ModelInfo[] } | { kind: "command"; items: SlashCommand[] } | null;

const MAX_CHAT_CONNECTORS = 5;
const MAX_VOICE_IMAGES = 4;


export function Composer({
  conversationId,
  model,
  onModelChange,
  onSend,
  isBusy,
  status,
  onStop,
  pendingClarification,
  onSubmitClarification,
  onSkipClarification,
  onCancelClarification,
  onOpenVoiceMode,
  quotaReached,
  canvasEnabled,
  onToggleCanvas,
  webSearchEnabled = false,
  onToggleWebSearch,
  reasoningEffort,
  onReasoningChange,
  connectorsEnabled = [],
  onToggleConnector,
  quote = null,
  onClearQuote,
  placeholder: customPlaceholder,
  privateMode = false,
  voiceActive = false,
  sendLocked = false,
  hideDisclaimer = false,
  selectedProjectId = null,
  onPickProject,
  onDictatingChange,
}: ComposerProps) {
  const { features, settings, setSettings, quota, models } = useApp();
  const resolved = resolveModel(model);
  // Only the thinking tiers this specific model actually supports (real data).
  const effortOptions = React.useMemo(() => (resolved ? reasoningOptions(resolved) : []), [resolved]);
  const modality = resolved?.modality ?? "chat";

  // Switching models: drop a thinking effort the new model can't do (e.g. "max"
  // when moving to Gemini) so we never show — or send — an unsupported tier.
  const changeModel = React.useCallback(
    (m: ModelId) => {
      onModelChange(m);
      const next = resolveModel(m);
      if (next) {
        const opts = reasoningOptions(next);
        if (!opts.some((o) => o.value === reasoningEffort)) onReasoningChange(defaultReasoning(next));
      }
    },
    [onModelChange, onReasoningChange, reasoningEffort]
  );
  // Native web search (Gemini grounding, Claude/Grok tools) — gated by plan +
  // model capability; no third-party key required.
  const canWebSearch = !!onToggleWebSearch && PLANS[quota.plan].webSearch && modality === "chat" && (resolved?.webSearch ?? false);
  // Deep research — per-send flag (resets after each send, unlike the sticky
  // web-search pref). Hidden entirely when the server has no Tavily key or in
  // private chat; visible-but-disabled on plans without web tooling (FREE).
  const [research, setResearch] = React.useState(false);
  const researchAvailable = features.deepResearch && !privateMode && modality === "chat";
  const planAllowsResearch = PLANS[quota.plan].webSearch;
  const sendOptions = React.useMemo<SendOptions | undefined>(
    () => (research && researchAvailable && planAllowsResearch ? { deepResearch: true } : undefined),
    [research, researchAvailable, planAllowsResearch]
  );
  const placeholder = pendingClarification
    ? "Or type your own answer…"
    : quote
    ? quote.mode === "modify"
      ? "Describe the change…"
      : "Ask about this selection…"
    : customPlaceholder ?? (
        modality === "image" ? "Describe an image to generate…" : modality === "video" ? "Describe a video to generate…" : "Message Juno…"
      );
  const [text, setText] = React.useState("");
  // The user's raw draft as it was when a send got intercepted by a
  // clarification — restored on cancel (originalUserMessage may be the
  // serialized quote block, which must not go back into the textarea).
  const interceptedDraftRef = React.useRef("");
  const [clarificationAnswers, setClarificationAnswers] = React.useState<PreflightClarificationAnswer[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [projects, setProjects] = React.useState<{ id: string; name: string; conversationCount: number }[]>([]);
  const [loadingProjects, setLoadingProjects] = React.useState(false);
  const [connectors, setConnectors] = React.useState<{ id: string; label: string; connected: boolean }[]>([]);
  const [connectorsLoading, setConnectorsLoading] = React.useState(false);
  const [connectorQuery, setConnectorQuery] = React.useState("");
  const enabledConnectorIdsRef = React.useRef(connectorsEnabled);
  enabledConnectorIdsRef.current = connectorsEnabled;
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(privateMode ? null : conversationId);
  const sendAttachments = privateMode ? [] : readyAttachments;
  const uploading = privateMode ? false : isUploading;

  const addComposerFiles = React.useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      const matching = voiceActive ? list.filter((file) => file.type.startsWith("image/")) : list;
      if (voiceActive && matching.length !== list.length) toast.error("Voice mode accepts image attachments only.");
      const remaining = voiceActive ? Math.max(0, MAX_VOICE_IMAGES - uploads.length) : matching.length;
      const allowed = matching.slice(0, remaining);
      if (voiceActive && matching.length > remaining) {
        toast.error(`Voice mode accepts up to ${MAX_VOICE_IMAGES} images in one turn.`);
      }
      if (allowed.length > 0) addFiles(allowed);
    },
    [addFiles, uploads.length, voiceActive]
  );
  const addComposerAttachments = React.useCallback(
    (attachments: ClientAttachment[]) => {
      const matching = voiceActive ? attachments.filter((attachment) => attachment.kind === "IMAGE") : attachments;
      if (voiceActive && matching.length !== attachments.length) toast.error("Voice mode accepts images from your library only.");
      const remaining = voiceActive ? Math.max(0, MAX_VOICE_IMAGES - uploads.length) : matching.length;
      const allowed = matching.slice(0, remaining);
      if (voiceActive && matching.length > remaining) {
        toast.error(`Voice mode accepts up to ${MAX_VOICE_IMAGES} images in one turn.`);
      }
      if (allowed.length > 0) addAttachments(allowed);
    },
    [addAttachments, uploads.length, voiceActive]
  );

  // Enforce the per-chat connector limit even for conversations saved by an
  // older client that may contain duplicate or excess connector IDs.
  React.useEffect(() => {
    if (voiceActive || !onToggleConnector) return;
    const excess = Array.from(new Set(connectorsEnabled)).slice(MAX_CHAT_CONNECTORS);
    excess.forEach((id) => onToggleConnector(id));
  }, [connectorsEnabled, onToggleConnector, voiceActive]);

  React.useEffect(() => {
    if (voiceActive) setLibraryOpen(false);
  }, [voiceActive]);
  // Chip exit: play pop-out (120ms) before the upload actually leaves state.
  const [removingIds, setRemovingIds] = React.useState<string[]>([]);
  const removeUpload = React.useCallback(
    (localId: string) => {
      setRemovingIds((prev) => (prev.includes(localId) ? prev : [...prev, localId]));
      window.setTimeout(() => {
        setRemovingIds((prev) => prev.filter((id) => id !== localId));
        remove(localId);
      }, 120);
    },
    [remove]
  );

  const { supported: speechSupported } = useSpeechRecognition();
  const [dictating, setDictatingInner] = React.useState(false);
  const setDictating = React.useCallback(
    (d: boolean | ((prev: boolean) => boolean)) => {
      setDictatingInner((prev) => {
        const next = typeof d === "function" ? d(prev) : d;
        onDictatingChange?.(next);
        return next;
      });
    },
    [onDictatingChange]
  );

  // Quote chip exit: play pop-out (120ms) before the quote leaves state.
  const [quoteRemoving, setQuoteRemoving] = React.useState(false);
  const dismissQuote = React.useCallback(() => {
    if (!onClearQuote) return;
    setQuoteRemoving(true);
    window.setTimeout(() => {
      setQuoteRemoving(false);
      onClearQuote();
    }, 120);
  }, [onClearQuote]);

  // A fresh selection lands the user straight in the textarea, ready to type.
  React.useEffect(() => {
    if (!quote) return;
    setQuoteRemoving(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [quote]);

  // Sending disables the textarea for the whole generation, which silently
  // drops keyboard focus to <body>. Hand it back the moment the composer
  // re-enables so Enter-to-send flows straight into typing the follow-up —
  // but never steal focus from a field the user moved to mid-generation
  // (only reclaim it from <body> or from within the composer itself).
  const wasBusyRef = React.useRef(false);
  React.useEffect(() => {
    const busy = isBusy || status === "checking";
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = busy;
    if (!wasBusy || busy || dictating || pendingClarification) return;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el || el.disabled) return;
      const active = document.activeElement;
      if (!active || active === document.body || rootRef.current?.contains(active)) el.focus();
    });
  }, [isBusy, status, dictating, pendingClarification]);

  const autoresize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = pendingClarification ? 60 : 200;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [pendingClarification]);

  React.useEffect(() => {
    autoresize();
  }, [text, pendingClarification, autoresize]);

  React.useEffect(() => {
    if (privateMode) {
      clear();
      setDragging(false);
    }
  }, [clear, privateMode]);

  React.useEffect(() => {
    setClarificationAnswers([]);
    // The intercepted draft is preserved in pendingClarification.originalUserMessage;
    // leaving it in the textarea made submit() treat it as a custom answer that
    // silently overwrote whichever option the user actually clicked.
    if (pendingClarification) {
      setText("");
      requestAnimationFrame(autoresize);
    }
  }, [pendingClarification, autoresize]);

  const clarificationOpen = !!pendingClarification;
  const controlsLocked = isBusy || sendLocked || uploading || !!quotaReached;
  const canSend = (text.trim().length > 0 || sendAttachments.length > 0 || clarificationAnswers.length > 0) && !controlsLocked;
  // With nothing to send and voice available, the primary button becomes the
  // voice-conversation launcher; the moment there's sendable content it morphs
  // back into Send.
  const showVoiceButton = !isBusy && !canSend && !!onOpenVoiceMode;
  const longText = text.trim().length > 1500 || text.split("\n").length > 30;

  const attachAsFile = () => {
    const content = text;
    if (!content.trim()) return;
    const file = new File([content], "prompt.txt", { type: "text/plain" });
    addComposerFiles([file]);
    setText("");
    requestAnimationFrame(autoresize);
  };

  const submit = async () => {
    if (!canSend) return;
    if (clarificationOpen && pendingClarification) {
      const success = await submitClarification(clarificationAnswers);
      if (success) {
        setClarificationAnswers([]);
      }
      return;
    }
    // A quoted selection wraps the user text in a structured block the model
    // can anchor on (artifact identifier + selection + mode instruction).
    // Keep the user's raw words: when a clarification intercepts this send,
    // cancel must restore the pre-serialization draft (the quote chip is
    // still attached, so restoring the serialized block would double-wrap).
    interceptedDraftRef.current = text.trim();
    const outgoing = quote ? serializeQuote(quote, text.trim()) : text.trim();
    const result = await onSend(outgoing, sendAttachments, sendOptions);
    if (result && result.accepted === false) return;
    setText("");
    setResearch(false); // per-send: research never sticks to the next message
    clear();
    onClearQuote?.();
    requestAnimationFrame(autoresize);
  };

  // Dictate Mode hand-off: Stop lands the transcript in the textarea for
  // editing; Send merges + submits through the exact same path as typing.
  const closeDictation = React.useCallback(
    (transcript: string, sendNow: boolean) => {
      setDictating(false);
      const merged = [text.trim(), transcript.trim()].filter(Boolean).join(" ");
      if (!sendNow || !merged || controlsLocked) {
        setText(merged);
        requestAnimationFrame(() => {
          autoresize();
          textareaRef.current?.focus();
        });
        return;
      }
      interceptedDraftRef.current = merged;
      const outgoing = quote ? serializeQuote(quote, merged) : merged;
      void (async () => {
        const result = await onSend(outgoing, sendAttachments, sendOptions);
        if (result && result.accepted === false) {
          setText(merged); // keep the words — nothing gets lost on a refusal
          return;
        }
        setText("");
        setResearch(false); // per-send: research never sticks to the next message
        clear();
        onClearQuote?.();
        requestAnimationFrame(autoresize);
      })();
    },
    [text, controlsLocked, quote, onSend, sendAttachments, sendOptions, clear, onClearQuote, autoresize]
  );

  // ——— Slash commands (type "/" then a command, e.g. "/model", "/projects") ———
  const router = useRouter();
  const commands = React.useMemo<SlashCommand[]>(
    () => [
      { id: "model", label: "/model", hint: "Switch the AI model" },
      { id: "artifact", label: "/artifact", hint: "Start a canvas / artifact" },
      {
        id: "search",
        label: "/search",
        hint: webSearchEnabled ? "Turn web search off" : "Turn web search on",
        run: () => onToggleWebSearch?.(!webSearchEnabled),
      },
      ...(researchAvailable && planAllowsResearch
        ? [
            {
              id: "research",
              label: "/research",
              hint: research ? "Turn deep research off" : "Deep-research the next message",
              run: () => setResearch((v) => !v),
            },
          ]
        : []),
      {
        id: "learn-demo",
        label: "/learn-demo",
        hint: "Preview the visual learning blocks",
        run: () => window.dispatchEvent(new CustomEvent("juno:learning-demo")),
      },
      { id: "projects", label: "/projects", hint: "Open your projects", run: () => router.push("/projects") },
      { id: "library", label: "/library", hint: "Open your library", run: () => router.push("/library") },
      { id: "memory", label: "/memory", hint: "Open memory", run: () => router.push("/memory") },
      ...(onOpenVoiceMode ? [{ id: "voice", label: "/voice", hint: "Start voice mode", run: onOpenVoiceMode }] : []),
      {
        id: "new",
        label: "/new",
        hint: "Start a new chat",
        run: () => {
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
          router.push("/chat");
        },
      },
    ],
    [webSearchEnabled, onToggleWebSearch, researchAvailable, planAllowsResearch, research, onOpenVoiceMode, router]
  );

  const slash = React.useMemo((): SlashState => {
    if (!text.startsWith("/")) return null;
    const modelMatch = text.match(/^\/model(?:\s+(.*))?$/i);
    if (modelMatch) {
      const q = (modelMatch[1] ?? "").toLowerCase().trim();
      const items = models
        .filter((m) => !q || m.name.toLowerCase().includes(q) || (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q))
        .slice(0, 8);
      return { kind: "model", items };
    }
    const cmdMatch = text.match(/^\/([\w-]*)$/);
    if (cmdMatch) {
      const c = cmdMatch[1].toLowerCase();
      const items = commands.filter((cmd) => cmd.id.startsWith(c));
      return items.length ? { kind: "command", items } : null;
    }
    return null;
  }, [text, models, commands]);

  const [slashIndex, setSlashIndex] = React.useState(0);
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  const slashOpen = !controlsLocked && !!slash && !slashDismissed && slash.items.length > 0;

  React.useEffect(() => setSlashIndex(0), [text]);
  React.useEffect(() => {
    if (!text.startsWith("/")) setSlashDismissed(false);
  }, [text]);

  const applySlash = (item: SlashItem) => {
    if ("providerModel" in item) {
      changeModel(item.id);
      setText("");
      requestAnimationFrame(autoresize);
      return;
    }
    if (item.id === "model") {
      setText("/model ");
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (item.id === "artifact") {
      onToggleCanvas(true);
      setText("Create an artifact that ");
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
      return;
    }
    item.run?.();
    setText("");
    requestAnimationFrame(autoresize);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && slash) {
      const n = slash.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + n) % n);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
        e.preventDefault();
        applySlash(slash.items[Math.min(slashIndex, n - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Escape" && quote && !quoteRemoving) {
      e.preventDefault();
      dismissQuote();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length && features.storage && !privateMode) {
      e.preventDefault();
      addComposerFiles(files);
    }
  };

  const startCanvas = () => {
    onToggleCanvas(true);
    setText((prev) => (prev.trim() ? prev : "Create an artifact that "));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  };

  const toggleMemory = (v: boolean) => {
    setSettings({ memoryEnabled: v });
    fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memoryEnabled: v }),
    }).catch(() => {});
  };

  // Load the project list when the normal + menu opens, and also when a
  // brand-new chat already belongs to a project whose name is not loaded yet.
  const loadProjects = React.useCallback(() => {
    setLoadingProjects(true);
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProjects(d?.projects ?? []))
      .catch(() => {})
      .finally(() => setLoadingProjects(false));
  }, []);

  React.useEffect(() => {
    if (plusOpen && !privateMode && !voiceActive) loadProjects();
  }, [plusOpen, privateMode, voiceActive, loadProjects]);

  const refreshConnectors = React.useCallback(
    async (signal?: AbortSignal) => {
      if (privateMode || !onToggleConnector) return;
      setConnectorsLoading(true);
      try {
        const response = await fetch("/api/connectors", { signal });
        if (!response.ok) return;
        const data = (await response.json()) as {
          connectors?: { id: string; label: string; connected: boolean }[];
        };
        if (signal?.aborted) return;
        const connected = (data.connectors ?? []).filter((connector) => connector.connected);
        setConnectors(connected);

        // Reconcile the conversation's saved IDs against the live account
        // connections, removing disconnected apps and anything over the limit.
        const availableIds = new Set(connected.map((connector) => connector.id));
        const enabledIds = Array.from(new Set(enabledConnectorIdsRef.current));
        const removals = enabledIds.filter((id, index) => !availableIds.has(id) || index >= MAX_CHAT_CONNECTORS);
        if (removals.length > 0) {
          const removeSet = new Set(removals);
          enabledConnectorIdsRef.current = enabledIds.filter((id) => !removeSet.has(id));
          removals.forEach((id) => onToggleConnector(id));
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          // Keep the last known list on transient failures.
        }
      } finally {
        if (!signal?.aborted) setConnectorsLoading(false);
      }
    },
    [onToggleConnector, privateMode]
  );

  // Reconcile on mount, when returning from Connections, and when the normal
  // + menu opens in case another tab changed an app connection.
  React.useEffect(() => {
    if (privateMode || voiceActive || !onToggleConnector) return;
    const controller = new AbortController();
    void refreshConnectors(controller.signal);
    const handleConnectionsChanged = () => void refreshConnectors(controller.signal);
    window.addEventListener("juno:connections-changed", handleConnectionsChanged);
    return () => {
      controller.abort();
      window.removeEventListener("juno:connections-changed", handleConnectionsChanged);
    };
  }, [onToggleConnector, privateMode, refreshConnectors, voiceActive]);

  React.useEffect(() => {
    if (plusOpen && !privateMode && !voiceActive && onToggleConnector) void refreshConnectors();
  }, [onToggleConnector, plusOpen, privateMode, refreshConnectors, voiceActive]);

  React.useEffect(() => {
    if (selectedProjectId && projects.length === 0 && !privateMode && !voiceActive) loadProjects();
  }, [selectedProjectId, projects.length, privateMode, voiceActive, loadProjects]);

  const pickProject = (projectId: string | null) => {
    onPickProject?.(projectId);
    setPlusOpen(false);
  };

  const clearComposerDraft = React.useCallback(() => {
    setText("");
    clear();
    setDictating(false);
    requestAnimationFrame(autoresize);
  }, [autoresize, clear]);

  const submitClarification = React.useCallback(
    async (answers: PreflightClarificationAnswer[]) => {
      if (!onSubmitClarification) return false;
      // Every answer value must respect the server's zod limits (string ≤ 1000,
      // string[] ≤ 12 × 500) — an oversized "Other" answer would 400 the whole
      // send and lose the user's input.
      const clampValue = (v: PreflightClarificationAnswerValue): PreflightClarificationAnswerValue =>
        typeof v === "string" ? v.slice(0, 1000) : Array.isArray(v) ? v.slice(0, 12).map((s) => s.slice(0, 500)) : v;
      const finalAnswers = answers.map((a) => (a.value === undefined ? a : { ...a, value: clampValue(a.value) }));
      // Text typed in the main textarea while the popover is open still counts,
      // but as a custom answer for the first UNANSWERED question — it must
      // never overwrite an option the user clicked or the popover's own
      // "Other" input. Clamped to the server's 1000-char answer limit.
      const trimmedText = text.trim().slice(0, 1000);
      if (trimmedText && pendingClarification) {
        const target = pendingClarification.result.questions.find(
          (q) => !finalAnswers.some((a) => a.questionId === q.id)
        );
        finalAnswers.push(
          target
            ? { questionId: target.id, question: target.question, source: "else", value: trimmedText }
            : { questionId: "additional_context", question: "Additional context", source: "else", value: trimmedText }
        );
      }
      const result = await onSubmitClarification(finalAnswers);
      if (!result || result.accepted !== false) clearComposerDraft();
      return !result || result.accepted !== false;
    },
    [clearComposerDraft, onSubmitClarification, pendingClarification, text]
  );

  const skipClarification = React.useCallback(async () => {
    if (!onSkipClarification) return false;
    const result = await onSkipClarification();
    if (!result || result.accepted !== false) clearComposerDraft();
    return !result || result.accepted !== false;
  }, [clearComposerDraft, onSkipClarification]);

  const cancelClarification = React.useCallback(() => {
    // Closing the popover restores the intercepted draft so nothing is lost —
    // the RAW draft, not originalUserMessage, which may be a serialized quote.
    if (pendingClarification) setText(interceptedDraftRef.current || pendingClarification.originalUserMessage);
    onCancelClarification?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [onCancelClarification, pendingClarification]);

  const selectedProject = selectedProjectId ? projects.find((p) => p.id === selectedProjectId) ?? null : null;
  const activeConnectorCount = connectors.filter((connector) => connectorsEnabled.includes(connector.id)).length;
  const connectorSearch = connectorQuery.trim().toLocaleLowerCase();
  const visibleConnectors = connectorSearch
    ? connectors.filter((connector) =>
        `${connector.label} ${connector.id}`.toLocaleLowerCase().includes(connectorSearch)
      )
    : connectors;

  return (
    <div
      ref={rootRef}
      className="mx-auto w-full max-w-[calc(100vw-1.5rem)] px-0 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-[48rem] sm:px-4"
    >
      {quotaReached && (
        <div role="status" className="mb-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-center text-sm text-foreground">
          You&apos;ve reached your monthly limit.{" "}
          <a href="/upgrade" className="font-medium text-primary underline-offset-2 hover:underline">
            Upgrade to keep chatting
          </a>
        </div>
      )}

      {/* Existing chats get the persistent scope bar at the top of the chat
          instead; the chip only announces where a brand-new chat will land. */}
      {selectedProject && !privateMode && !conversationId && (
        <div className="mb-2 flex">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card/80 px-2.5 py-1 text-caption text-muted-foreground shadow-soft">
            <Box className="h-3 w-3 text-primary" />
            <span>
              {"New chat in "}
              <span className="font-medium text-foreground">{selectedProject.name}</span>
            </span>
            <button
              type="button"
              onClick={() => pickProject(null)}
              aria-label="Remove from project"
              className="pressable ml-0.5 rounded-full p-0.5 text-muted-foreground/70 hover:text-foreground coarse:p-1.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      <div className={cn("relative w-full flex items-center justify-center transition-all duration-300", dictating ? "min-h-[170px] pt-20 pb-2" : "min-h-[76px]")}>
        {dictating && (
          <div className="w-full flex justify-center py-1 relative z-30">
            <ComposerDictation
              onCancel={() => setDictating(false)}
              onStop={(t) => closeDictation(t, false)}
              onSend={(t) => closeDictation(t, true)}
            />
          </div>
        )}

        <div
          onDragOver={(e) => {
            if (!features.storage || privateMode) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (features.storage && !privateMode && e.dataTransfer.files.length) addComposerFiles(e.dataTransfer.files);
          }}
          className={cn(
            "rounded-panel border bg-card/90 shadow-float backdrop-blur flex flex-col w-full origin-center relative transition-all duration-300 ease-out-soft",
            dictating
              ? "max-h-0 py-0 border-transparent bg-transparent shadow-none opacity-0 scale-95 pointer-events-none overflow-hidden absolute inset-x-0 top-1/2 -translate-y-1/2"
              : "max-h-[600px] opacity-100 scale-100",
            clarificationOpen ? "p-4 gap-4" : "",
            privateMode
              ? "border-dashed border-foreground/25"
              : "border-border/70 focus-within:border-primary/30 focus-within:shadow-glass",
            dragging && "border-primary/60 ring-2 ring-primary/30"
          )}
        >
        {dragging && !privateMode && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-panel border-2 border-dashed border-primary/50 bg-primary/10 backdrop-blur-sm motion-safe:animate-fade-in">
            <FileUp className="h-6 w-6 text-primary" />
            <span className="font-mono text-label uppercase text-primary">Drop to attach</span>
          </div>
        )}

        {pendingClarification && (
          <ComposerClarificationPopover
            pending={pendingClarification}
            disabled={isBusy && status !== "checking"}
            onSubmit={submitClarification}
            onSkip={skipClarification}
            onClose={cancelClarification}
            variant="inline"
            onAnswersChange={setClarificationAnswers}
          />
        )}

        <div
          className={cn(
            "flex flex-col w-full relative transition-[opacity,transform] duration-base ease-out-soft",
            clarificationOpen
              ? "rounded-xl border border-border bg-background/50 p-4 shadow-inner"
              : ""
          )}
        >

        {!privateMode && (
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-base ease-out-soft",
              uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="flex flex-wrap gap-2 p-3 pb-0">
                {uploads.map((u) => (
                  <div
                    key={u.localId}
                    className={cn(
                      "group relative flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-xs shadow-soft",
                      removingIds.includes(u.localId) ? "pointer-events-none motion-safe:animate-pop-out" : "motion-safe:animate-rise-in"
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

        {quote && (
          <div
            className={cn(
              "mx-3 mt-3 flex items-start gap-2.5 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 shadow-soft",
              quoteRemoving ? "pointer-events-none motion-safe:animate-pop-out" : "motion-safe:animate-rise-in"
            )}
          >
            <span
              aria-hidden
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border border-primary/25 bg-primary/10 text-primary"
            >
              {quote.kind === "element" ? (
                <SquareDashedMousePointer className="h-3.5 w-3.5" />
              ) : (
                <TextQuote className="h-3.5 w-3.5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="shrink-0 font-mono text-label uppercase text-primary">
                  {quote.mode === "modify" ? "Modify" : "Ask"}
                </span>
                <span className="min-w-0 truncate text-sm font-medium">{quote.title}</span>
                {quoteLocationLabel(quote) && (
                  <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
                    {quoteLocationLabel(quote)}
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 break-all font-mono text-caption leading-relaxed text-muted-foreground">
                {quote.text.replace(/\s+/g, " ").trim().slice(0, 220)}
              </p>
            </div>
            <button
              type="button"
              onClick={dismissQuote}
              aria-label="Remove quoted selection"
              className="pressable -mr-1 mt-0.5 shrink-0 rounded-full p-1 text-muted-foreground/70 transition-colors duration-fast hover:bg-accent hover:text-foreground coarse:p-2"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {longText && features.storage && !privateMode && (
          <div className="flex items-center justify-between gap-3 px-4 pt-3">
            <span className="text-caption text-muted-foreground">
              That’s a long one — attach it as a file to keep the chat tidy?
            </span>
            <Button type="button" variant="outline" size="sm" onClick={attachAsFile} className="h-7 shrink-0 gap-1.5">
              <FileUp className="h-3.5 w-3.5" /> Attach as file
            </Button>
          </div>
        )}

        {slashOpen && slash && (
          <div className="absolute bottom-full left-2 right-2 z-30 mb-2 overflow-hidden rounded-xl border bg-popover/95 shadow-float backdrop-blur duration-fast ease-out-expo motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1">
            <div className="px-3 pb-1 pt-2 font-mono text-label uppercase text-muted-foreground">
              {slash.kind === "model" ? "Switch model" : "Commands"}
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {slash.kind === "model"
                ? slash.items.map((m, i) => (
                    <button
                      key={m.id}
                      type="button"
                      onMouseEnter={() => setSlashIndex(i)}
                      onClick={() => applySlash(m)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast",
                        i === slashIndex ? "bg-accent" : "hover:bg-accent/50"
                      )}
                    >
                      <ProviderLogo provider={m.provider} className="h-5 w-5" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</span>
                      <span className="shrink-0 text-caption text-muted-foreground">{PROVIDERS[m.provider].label.split(" · ")[0]}</span>
                      {m.id === model && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                    </button>
                  ))
                : slash.items.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      onMouseEnter={() => setSlashIndex(i)}
                      onClick={() => applySlash(c)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-fast",
                        i === slashIndex ? "bg-accent" : "hover:bg-accent/50"
                      )}
                    >
                      <span className="font-mono text-sm text-primary">{c.label}</span>
                      <span className="text-xs text-muted-foreground">{c.hint}</span>
                    </button>
                  ))}
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={isBusy || sendLocked || status === "checking"}
          rows={1}
          placeholder={placeholder}
          className={cn(
            "w-full resize-none bg-transparent px-3.5 py-3.5 leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground disabled:opacity-70 sm:px-4",
            clarificationOpen ? "max-h-[60px] min-h-[48px] text-sm" : "max-h-[200px] min-h-[86px] text-body-lg"
          )}
        />

        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-2.5 pb-2.5 pt-0.5">
          {/* Left: + menu and model selector */}
          <div className="flex min-w-0 flex-1 basis-[13rem] flex-wrap items-center gap-1">
            <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Add"
                  disabled={controlsLocked}
                  className={cn("rounded-[20px] coarse:h-11 coarse:w-11", plusOpen && "bg-accent")}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" sideOffset={8} className={voiceActive ? "w-52" : "w-64"}>
                {voiceActive ? (
                  <>
                    <DropdownMenuItem
                      disabled={!features.storage || privateMode}
                      onSelect={() => imageInputRef.current?.click()}
                    >
                      <ImagePlus className="text-muted-foreground" />
                      <span className="flex-1">Add photos</span>
                      {(privateMode || !features.storage) && (
                        <span className="text-caption text-muted-foreground/60">{privateMode ? "private" : "no storage"}</span>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled>
                      <FileUp className="text-muted-foreground" />
                      <span className="flex-1">Add files</span>
                      <span className="text-caption text-muted-foreground/60">chat only</span>
                    </DropdownMenuItem>
                  </>
                ) : (
                  <>
                    <DropdownMenuItem
                      disabled={!features.storage || privateMode}
                      onSelect={() => imageInputRef.current?.click()}
                    >
                      <ImagePlus className="text-muted-foreground" />
                      <span className="flex-1">Add photos</span>
                      {(privateMode || !features.storage) && (
                        <span className="text-caption text-muted-foreground/60">{privateMode ? "private" : "no storage"}</span>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!features.storage || privateMode}
                      onSelect={() => fileInputRef.current?.click()}
                    >
                      <FileUp className="text-muted-foreground" />
                      <span className="flex-1">Add files</span>
                      {(privateMode || !features.storage) && (
                        <span className="text-caption text-muted-foreground/60">{privateMode ? "private" : "no storage"}</span>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!features.storage || privateMode}
                      onSelect={() => setLibraryOpen(true)}
                    >
                      <Library className="text-muted-foreground" />
                      <span className="flex-1">Add from library</span>
                      {(privateMode || !features.storage) && (
                        <span className="text-caption text-muted-foreground/60">{privateMode ? "private" : "no storage"}</span>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={privateMode} onSelect={() => startCanvas()}>
                      <SquarePen className="text-muted-foreground" />
                      <span className="flex-1">Create a canvas</span>
                    </DropdownMenuItem>

                    {privateMode ? (
                      <DropdownMenuItem disabled>
                        <Box className="text-muted-foreground" />
                        <span className="flex-1">Add to project</span>
                        <span className="text-caption text-muted-foreground/60">private</span>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Box className="text-muted-foreground" />
                          <span className="flex-1">Add to project</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
                          {loadingProjects && projects.length === 0 ? (
                            <div className="flex items-center justify-center py-6">
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            </div>
                          ) : projects.length === 0 ? (
                            <div className="px-2 py-4 text-center">
                              <p className="text-caption text-muted-foreground">No projects yet.</p>
                              <a href="/projects" className="mt-1 inline-block text-caption text-primary hover:underline">
                                Create one →
                              </a>
                            </div>
                          ) : (
                            projects.map((project) => {
                              const active = selectedProjectId === project.id;
                              return (
                                <DropdownMenuItem key={project.id} onSelect={() => pickProject(active ? null : project.id)}>
                                  <Box className={cn(active ? "text-primary" : "text-muted-foreground")} />
                                  <span className="flex-1 truncate">{project.name}</span>
                                  {active ? (
                                    <Check className="!size-3.5 text-primary" />
                                  ) : (
                                    <span className="font-mono text-caption text-muted-foreground/60">{project.conversationCount}</span>
                                  )}
                                </DropdownMenuItem>
                              );
                            })
                          )}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}

                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="flex items-center gap-1.5 font-mono text-label uppercase">
                      <Blocks className="h-3.5 w-3.5" />
                      Plugins
                    </DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={privateMode}
                      onSelect={(event) => {
                        event.preventDefault();
                        onToggleCanvas(!canvasEnabled);
                      }}
                    >
                      <LayoutTemplate className="text-muted-foreground" />
                      <span className="flex-1">Canvas &amp; artifacts</span>
                      <Switch checked={!privateMode && canvasEnabled} className="pointer-events-none" />
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        toggleMemory(!settings.memoryEnabled);
                      }}
                    >
                      <Brain className="text-muted-foreground" />
                      <span className="flex-1">Memory</span>
                      <Switch checked={settings.memoryEnabled} className="pointer-events-none" />
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canWebSearch}
                      onSelect={(event) => {
                        event.preventDefault();
                        onToggleWebSearch?.(!webSearchEnabled);
                      }}
                    >
                      <Globe className="text-muted-foreground" />
                      <span className="flex-1">Web search</span>
                      {canWebSearch ? (
                        <Switch checked={webSearchEnabled} className="pointer-events-none" />
                      ) : (
                        <span className="text-caption text-muted-foreground/60">{modality === "chat" ? "not on this model" : "chat only"}</span>
                      )}
                    </DropdownMenuItem>

                    {onToggleConnector && !privateMode && modality === "chat" && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub onOpenChange={(open) => !open && setConnectorQuery("")}>
                          <DropdownMenuSubTrigger>
                            <Plug className="text-muted-foreground" />
                            <span className="flex-1">Connectors</span>
                            {activeConnectorCount > 0 && (
                              <span className="mr-1 font-mono text-caption text-primary">{activeConnectorCount}</span>
                            )}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-72 p-0">
                            <div className="border-b border-border/60 p-2">
                              <div className="mb-1.5 flex items-center justify-between px-1 text-caption text-muted-foreground">
                                <span>Choose apps for this chat</span>
                                <span className="font-mono tabular-nums">{activeConnectorCount}/{MAX_CHAT_CONNECTORS}</span>
                              </div>
                              <label className="relative block">
                                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                                <input
                                  value={connectorQuery}
                                  onChange={(event) => setConnectorQuery(event.target.value)}
                                  onKeyDown={(event) => event.stopPropagation()}
                                  placeholder="Search connected apps…"
                                  aria-label="Search connected apps"
                                  className="h-9 w-full rounded-[9px] border border-border/60 bg-background/70 pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
                                />
                              </label>
                            </div>
                            <div className="max-h-64 overflow-y-auto p-1.5 overscroll-contain">
                              {connectorsLoading && connectors.length === 0 ? (
                                <div role="status" className="px-2 py-5 text-center text-xs text-muted-foreground">
                                  Loading connected apps…
                                </div>
                              ) : connectors.length === 0 ? (
                                <DropdownMenuItem onSelect={() => router.push("/connections")}>
                                  <Plug className="text-muted-foreground" />
                                  <span className="flex-1">Connect an app</span>
                                  <span className="text-caption text-muted-foreground/60">set up</span>
                                </DropdownMenuItem>
                              ) : visibleConnectors.length === 0 ? (
                                <div className="px-2 py-5 text-center text-xs text-muted-foreground">
                                  No connected apps match “{connectorQuery.trim()}”.
                                </div>
                              ) : (
                                visibleConnectors.map((connector) => {
                                  const selected = connectorsEnabled.includes(connector.id);
                                  return (
                                    <DropdownMenuItem
                                      key={connector.id}
                                      onSelect={(event) => {
                                        event.preventDefault();
                                        if (!selected && new Set(connectorsEnabled).size >= MAX_CHAT_CONNECTORS) {
                                          toast.error(
                                            `You can use up to ${MAX_CHAT_CONNECTORS} connectors at once. Turn one off before adding another.`
                                          );
                                          return;
                                        }
                                        onToggleConnector(connector.id);
                                      }}
                                      className="min-h-10"
                                    >
                                      <Plug className="text-muted-foreground" />
                                      <span className="min-w-0 flex-1 truncate">{connector.label}</span>
                                      <Switch checked={selected} className="pointer-events-none" />
                                    </DropdownMenuItem>
                                  );
                                })
                              )}
                            </div>
                            {connectors.length > 0 && (
                              <div className="border-t border-border/60 p-1.5">
                                <DropdownMenuItem onSelect={() => router.push("/connections")} className="text-muted-foreground">
                                  <Plug />
                                  Manage connections
                                </DropdownMenuItem>
                              </div>
                            )}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <span className="mx-0.5 hidden h-5 w-px shrink-0 bg-border/60 min-[420px]:block" aria-hidden="true" />

            <div
              className={cn("min-w-0 shrink", controlsLocked && "pointer-events-none opacity-60")}
              aria-disabled={controlsLocked}
            >
              <ModelSelector value={model} onChange={changeModel} reasoningEffort={reasoningEffort} onReasoningChange={onReasoningChange} />
            </div>

            {effortOptions.length > 0 && (() => {
              const currentEffort = effortOptions.find((e) => e.value === reasoningEffort) ?? effortOptions[0];
              return (
                <>
                  {/* Thinking effort as a plain label instead of an icon. */}
                  <span className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block" aria-hidden="true" />
                  <Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={controlsLocked}
                            aria-label={`Thinking effort: ${currentEffort.label}`}
                            className="group h-8 gap-1 rounded-[10px] px-2 font-mono text-[13px] tracking-tight text-foreground/80 hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:bg-accent data-[state=open]:bg-accent data-[state=open]:text-foreground"
                          >
                            {currentEffort.label}
                            <ChevronDown className="h-3 w-3 shrink-0 opacity-50 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
                          </Button>
                        </TooltipTrigger>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        {effortOptions.map((e) => (
                          <DropdownMenuItem key={e.label} onSelect={() => onReasoningChange(e.value)}>
                            <span className="flex-1">{e.label}</span>
                            {reasoningEffort === e.value && <Check className="h-4 w-4 text-primary" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <TooltipContent>Thinking effort</TooltipContent>
                  </Tooltip>
                </>
              );
            })()}

            {/* Deep research — per-send chip: one prompt becomes a planned,
                searched, cited report. Hidden without a Tavily key (and in
                private chat); disabled with the upgrade hint on Free. */}
            {researchAvailable && (
              <>
                <span className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block" aria-hidden="true" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={controlsLocked}
                      aria-disabled={controlsLocked || !planAllowsResearch}
                      aria-pressed={research}
                      aria-label={research ? "Turn off deep research" : "Turn on deep research for the next message"}
                      onClick={() => planAllowsResearch && setResearch((v) => !v)}
                      className={cn(
                        "h-8 gap-1.5 rounded-[10px] px-2 font-mono text-[13px] tracking-tight focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:bg-accent",
                        research
                          ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                          : "text-foreground/80 hover:text-foreground",
                        !planAllowsResearch && "opacity-50"
                      )}
                    >
                      <Telescope className="h-3.5 w-3.5 shrink-0" />
                      Research
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!planAllowsResearch
                      ? "Deep research needs a paid plan"
                      : research
                        ? "Deep research is on for this message"
                        : "Deep research — a multi-step, cited report"}
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </div>

          {/* Right: dictation mic + primary action (voice ⇄ send ⇄ stop). */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {speechSupported && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDictating(true)}
                    disabled={controlsLocked || dictating || voiceActive}
                    aria-label="Dictate"
                    aria-pressed={dictating}
                    className="coarse:h-11 coarse:w-11"
                  >
                    <Mic className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Dictate</TooltipContent>
              </Tooltip>
            )}

            {speechSupported && (
              <span className="mx-0.5 hidden h-5 w-px shrink-0 bg-border/60 min-[420px]:block" aria-hidden="true" />
            )}

            {/* Primary action morphs in place: Voice (empty) → Send (has text) → Stop (busy). */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  onClick={
                    isBusy && status !== "checking"
                      ? onStop
                      : showVoiceButton
                        ? onOpenVoiceMode
                        : () => void submit()
                  }
                  disabled={isBusy ? status === "stopping" || status === "checking" : showVoiceButton ? false : !canSend}
                  aria-label={
                    isBusy && status !== "checking"
                      ? status === "stopping"
                        ? "Stopping generation"
                        : "Stop generating"
                      : showVoiceButton
                        ? "Start voice conversation"
                        : "Send message"
                  }
                  className={cn(
                    // rounded-lg (24px) clamps to a perfect circle at these sizes but, unlike
                    // rounded-full, keeps the radius morph to rounded-md animatable.
                    "coarse:h-11 coarse:w-11 transition-[width,border-radius,color,background-color,border-color,box-shadow,transform] duration-base ease-spring",
                    isBusy && status !== "checking" ? "w-12 rounded-md shadow-soft ring-2 ring-primary/20" : "rounded-lg"
                  )}
                >
                  {status === "checking" ? (
                    <Loader2 key="checking" className="h-4 w-4 animate-spin motion-safe:animate-fade-in" />
                  ) : isBusy ? (
                    <Square key="stop" className="h-3.5 w-3.5 fill-current motion-safe:animate-fade-in" />
                  ) : showVoiceButton ? (
                    <AudioLines key="voice" className="h-4 w-4 motion-safe:animate-fade-in" />
                  ) : (
                    <ArrowUp key="send" className="h-4 w-4 motion-safe:animate-fade-in" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showVoiceButton && !isBusy ? "Voice conversation" : "Send"}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <input
          ref={imageInputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            if (!privateMode && e.target.files?.length) addComposerFiles(e.target.files);
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
            if (!privateMode && e.target.files?.length) addComposerFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {!voiceActive && !privateMode && features.storage && (
          <LibraryPicker
            open={libraryOpen}
            onOpenChange={setLibraryOpen}
            onAttach={addComposerAttachments}
            existingCount={uploads.length}
          />
        )}
        </div>
      </div>
      </div>
      {!hideDisclaimer && (
        <p className="mt-2 text-center text-caption text-muted-foreground">
          {privateMode ? "Incognito chats are not saved or added to memory." : "Juno can be wrong — worth a second look on anything that matters."}
        </p>
      )}
    </div>
  );
}
