"use client";

import * as React from "react";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  AudioLines,
  Blocks,
  NotebookPen,
  ChevronDown,
  Cpu,
  FileUp,
  GraduationCap,
  LayoutTemplate,
  Loader2,
  MessageSquarePlus,
  Mic,
  Paperclip,
  Plug,
  Plus,
  Search,
  Square,
  SquareDashedMousePointer,
  SquarePen,
  TextQuote,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { ActionIcons, AppIcons, CodeIcons, ComposerIcons, StatusIcons } from "@/lib/app-icons";
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
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { LibraryPicker } from "@/components/chat/library-picker";
import { ComposerClarificationPopover } from "@/components/chat/composer-clarification-popover";
import { resolveModel, type ModelInfo } from "@/lib/models";
import { isAutoModelId } from "@/lib/auto-model";
import { reasoningOptions, defaultReasoning, clampReasoningEffort, supportsProMode } from "@/lib/model-metrics";
import { supportsFastMode } from "@/lib/pricing";
import { PROVIDERS } from "@/lib/providers";
import { PLANS } from "@/lib/plans";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { ComposerDictation } from "@/components/chat/composer-dictation";
import { useApp } from "@/components/app/app-provider";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import {
  COMPOSER_INLINE_SOFT_CHARS,
  COMPOSER_LONG_TEXT_CHARS,
  sampleLineCount,
} from "@/lib/prompt-limits";
import { formatBytes, cn } from "@/lib/utils";
import { artifactEditRequestFromQuote, serializeQuote, quoteLocationLabel, type ComposerQuote } from "@/lib/quote-context";
import type { ModelId } from "@/lib/models";
import type {
  PendingPreflightClarification,
  PreflightClarificationAnswer,
  PreflightClarificationAnswerValue,
} from "@/lib/preflight-clarification";
import type { SendOptions, SendResult } from "@/hooks/use-chat";
import {
  MAX_CHAT_CONNECTORS,
  detectConnectorsFromPrompt,
  newlyDetectedConnectors,
} from "@/lib/connector-intent";
import type { ClientAttachment, GenerationStatus, ReasoningEffort } from "@/types/chat";

interface ComposerProps {
  conversationId: string | null;
  model: ModelId;
  onModelChange: (m: ModelId) => void;
  onSend: (text: string, attachments: ClientAttachment[], options?: SendOptions) => Promise<SendResult> | SendResult | void;
  isBusy: boolean;
  status: GenerationStatus;
  onStop: () => void;
  /**
   * A deep-research run is gathering, and this composer steers it.
   *
   * The research surface used to carry its own steering form and its own
   * pause/stop buttons — a second text field and a second set of transport
   * controls sitting a few hundred pixels above the real ones, for the same
   * conversation. The composer is where a person types at a conversation, so
   * while a run is live it is what direction goes into: text becomes a
   * constraint (or a pinned source, if it is a URL) on the running
   * investigation rather than a queued message, and the primary button's Stop
   * face ends the run rather than only the stream.
   *
   * `active` is narrower than "a run exists": it is true only while a worker is
   * actually spending, because that is the window in which added direction can
   * still change what gets read. Absent or inactive and every path below
   * behaves exactly as it did.
   */
  steering?: {
    active: boolean;
    placeholder: string;
    /** Resolves true when the server accepted it; the draft clears only then. */
    onSteer: (text: string) => Promise<boolean>;
  } | null;
  pendingClarification?: PendingPreflightClarification | null;
  onSubmitClarification?: (answers: PreflightClarificationAnswer[]) => Promise<SendResult> | SendResult | void;
  onSkipClarification?: () => Promise<SendResult> | SendResult | void;
  onCancelClarification?: () => void;
  onOpenVoiceMode?: () => void;
  quotaReached?: boolean;
  /** The plan grants no messages at all, rather than having exhausted them. */
  planIncludesNoMessages?: boolean;
  canvasEnabled: boolean;
  onToggleCanvas: (v: boolean) => void;
  webSearchEnabled?: boolean;
  onToggleWebSearch?: (v: boolean) => void;
  reasoningEffort: ReasoningEffort | null;
  onReasoningChange: (e: ReasoningEffort | null) => void;
  /** Premium "fast mode" (Anthropic speed / OpenAI priority) — the toggle only
   *  renders for models that support it (supportsFastMode). */
  fastMode?: boolean;
  onToggleFastMode?: (v: boolean) => void;
  /** GPT-5.6 pro execution — the toggle only renders for models that support it
   *  (supportsProMode). */
  proMode?: boolean;
  onToggleProMode?: (v: boolean) => void;
  connectorsEnabled?: string[];
  onToggleConnector?: (id: string) => void;
  /** Batch-add connector ids for this chat (no toggle-off). Used by prompt intent. */
  onEnableConnectors?: (ids: string[]) => void;
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

// One palette serves both composer triggers: "/" (commands, e.g. "/model") and
// "@" (tools + connectors, e.g. "@notion"). Rows are grouped for rendering but
// stay ONE flat, ordered list so the keyboard cursor is a single index.
type PaletteGroup = "commands" | "tools" | "navigate" | "connectors";

type SlashCommand = {
  id: string;
  /** Token typed after the trigger ("model" → "/model"); what the query filters on. */
  key: string;
  label: string;
  hint: string;
  group: PaletteGroup;
  /** Brand mark for connector rows; `icon` covers everything else. */
  connectorId?: string;
  icon?: LucideIcon;
  /** Defined ⇒ the row is an on/off tool and renders its state. */
  on?: boolean;
  /** Trailing note for a row that can't toggle right now ("not connected"). */
  note?: string;
  /** Extra haystack for `includes` matching — connector labels ("Google
   *  Calendar") rarely share a prefix with their slug ("googlecalendar"). */
  match?: string;
  run?: () => void;
};
type SlashItem = ModelInfo | SlashCommand;
type SlashState =
  | { kind: "model"; items: ModelInfo[] }
  | { kind: "command"; items: SlashCommand[] }
  | { kind: "mention"; items: SlashCommand[] }
  | null;

const GROUP_LABELS: Record<PaletteGroup, string> = {
  commands: "Commands",
  tools: "Tools",
  navigate: "Go to",
  connectors: "Connectors",
};

const MAX_VOICE_IMAGES = 4;
// Mirrors COMPOSIO_APP_PREFIX in lib/composio, which pulls in prisma and so
// cannot be imported from a client component.
const COMPOSIO_ID_PREFIX = "composio:";

/** The token an app answers to after "@": "composio:googlecalendar" → "googlecalendar". */
const connectorKey = (id: string) =>
  (id.startsWith(COMPOSIO_ID_PREFIX) ? id.slice(COMPOSIO_ID_PREFIX.length) : id).toLowerCase();

// Prefix match only, exactly as the slash list has always filtered — `match`
// widens connector rows without changing how commands behave.
const filterRows = (rows: SlashCommand[], query: string) =>
  query ? rows.filter((row) => row.key.startsWith(query) || (row.match?.includes(query) ?? false)) : rows;

// Selection is carried by the neutral accent fill + a coral hairline, never a
// coral wash: the mouse moves the cursor here, so a filled coral row would read
// as a hover colour rather than as "this is what Enter picks".
//
// `rounded-xs`, by the same arithmetic DropdownMenuItem documents: the palette
// shell is a 12px `rounded-menu` with p-1.5, so 12 − 6 leaves 6px for the rows.
// At rounded-md these were drawn 2px too round for their shell — and 2px rounder
// than the + menu's rows one trigger to the left, which are the same object.
const paletteRowClass = (selected: boolean) =>
  cn(
    "flex w-full cursor-pointer select-none items-center gap-2.5 rounded-xs px-2 py-1.5 text-left transition-[background-color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
    selected ? "bg-accent ring-1 ring-inset ring-primary/20" : "hover:bg-accent/50"
  );

/** Chunk the flat, pre-ordered rows into their groups while keeping each row's
 *  index in the FLAT list — that index is the keyboard cursor. */
function groupRows(items: SlashCommand[]) {
  const out: { group: PaletteGroup; rows: { item: SlashCommand; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const last = out[out.length - 1];
    if (last?.group === item.group) last.rows.push({ item, index });
    else out.push({ group: item.group, rows: [{ item, index }] });
  });
  return out;
}

/* The palette's ceiling and the chrome that sits between the listbox and the
 * top edge it is clamped against: the popover's mb-2 gap, its own hairline
 * border and p-1.5, and a gutter so the palette never kisses that edge. The
 * ceiling stays 18rem — it is the room above the anchor, measured below against
 * the nearest clipping ancestor, that decides the rest. */
const PALETTE_MAX_H = 288;
const PALETTE_CHROME = 8 + 2 * 1 + 2 * 6 + 8;

/** Ancestors that clip the palette. Nothing portals it, so its rows are lost to
 *  the nearest overflow-hiding boxes — the chat column, and the empty-state
 *  scroller — rather than to the viewport. Their padding-box top sits BELOW y=0
 *  whenever anything stacks above the chat column (the md:hidden mobile header,
 *  the incognito bar plus the column's own margin), so measuring room against
 *  the viewport over-counts by exactly that offset and lets the palette clip.
 *  Resolved once per open: getComputedStyle on every ancestor every frame would
 *  force a style recalc, and the clip chain only changes with the tree. */
function clipAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowY !== "visible" || style.overflowX !== "visible") out.push(node);
  }
  return out;
}

/** Land the clamp on a row boundary so the list never opens onto a sliced row.
 *  Row offsets are read against the popover (the nearest positioned ancestor),
 *  so the listbox's own offset comes back out; unlike getBoundingClientRect,
 *  offsetTop ignores scrollTop, which is what keeps this stable to re-measure.
 *  Snapping only applies once the content actually overflows: rounding a fitting
 *  list down to its last row would conjure a 1px scrollbar out of nothing. */
function snapPaletteToRow(list: HTMLElement | null, limit: number) {
  if (!list || list.scrollHeight <= limit) return limit;
  let snapped = limit;
  for (const row of list.querySelectorAll<HTMLElement>('[role="option"]')) {
    const bottom = row.offsetTop - list.offsetTop + row.offsetHeight;
    if (bottom > limit) break;
    snapped = bottom;
  }
  return snapped;
}

// aria-hidden: the enclosing role="group" already carries this label, so exposing
// it again would announce every section name twice.
function PaletteEyebrow({ label, counter }: { label: string; counter?: string }) {
  return (
    <div aria-hidden className="flex items-baseline justify-between gap-2 px-2 pb-1 pt-1.5">
      <span className="font-mono text-label text-muted-foreground">{label}</span>
      {counter && <span className="font-mono text-caption tabular-nums text-muted-foreground">{counter}</span>}
    </div>
  );
}

/** Uniform icon slot: brand marks need a surface to read on, and a shared tile
 *  keeps lucide glyphs, provider logos and connector marks on one baseline. */
function PaletteIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-xs border border-border/50 bg-background/60">
      {children}
    </span>
  );
}


export function Composer({
  conversationId,
  model,
  onModelChange,
  onSend,
  isBusy,
  status,
  onStop,
  steering,
  pendingClarification,
  onSubmitClarification,
  onSkipClarification,
  onCancelClarification,
  onOpenVoiceMode,
  quotaReached,
  planIncludesNoMessages,
  canvasEnabled,
  onToggleCanvas,
  webSearchEnabled = false,
  onToggleWebSearch,
  reasoningEffort,
  onReasoningChange,
  fastMode = false,
  onToggleFastMode,
  proMode = false,
  onToggleProMode,
  connectorsEnabled = [],
  onToggleConnector,
  onEnableConnectors,
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
  const isAuto = isAutoModelId(model);
  // Only the thinking tiers this specific model actually supports (real data).
  // Auto picks thinking server-side — no manual slider.
  const effortOptions = React.useMemo(
    () => (isAuto || !resolved ? [] : reasoningOptions(resolved)),
    [isAuto, resolved]
  );
  // Fast mode (premium speed) is only offered on the handful of models that
  // actually support it — see supportsFastMode(). The toggle hides otherwise.
  const canFastMode = React.useMemo(
    () => !isAuto && !!resolved && supportsFastMode(resolved),
    [isAuto, resolved]
  );
  // Pro execution is a separate axis from effort and exists on the GPT-5.6 line
  // only — see supportsProMode(). Same hide-when-unsupported rule as Flash.
  const canProMode = React.useMemo(
    () => !isAuto && !!resolved && supportsProMode(resolved),
    [isAuto, resolved]
  );
  // Pro at Instant is a contradiction — the mode's whole content is that the
  // model deliberates. Rather than send a self-cancelling pair (the adapter
  // would drop the effort and quietly apply the API default), raise the tier
  // when Pro goes on, so the control shows what will actually run.
  const toggleProMode = React.useCallback(
    (v: boolean) => {
      onToggleProMode?.(v);
      if (v && reasoningEffort == null && resolved) {
        onReasoningChange(clampReasoningEffort(resolved, "medium"));
      }
    },
    [onToggleProMode, onReasoningChange, reasoningEffort, resolved]
  );
  const modality = resolved?.modality ?? "chat";

  // Switching models: drop a thinking effort the new model can't do (e.g. "max"
  // when moving to Gemini) so we never show — or send — an unsupported tier.
  // Auto: clear effort (server chooses per message).
  const changeModel = React.useCallback(
    (m: ModelId) => {
      onModelChange(m);
      if (isAutoModelId(m)) {
        onReasoningChange(null);
        return;
      }
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
  // Voice mode never loads connectors (every fetch effect below bails on it), so
  // the "@" palette must not offer rows it has no data for either.
  const showConnectors = !!onToggleConnector && !privateMode && !voiceActive && modality === "chat";
  // Deep research — per-send flag (resets after each send, unlike the sticky
  // web-search pref). Hidden entirely when the server has no Tavily key or in
  const [research, setResearch] = React.useState(false);
  const researchAvailable = !privateMode && modality === "chat";
  const planAllowsResearch = true;
  const sendOptions = React.useMemo<SendOptions | undefined>(
    () => (research && researchAvailable && planAllowsResearch ? { deepResearch: true } : undefined),
    [research, researchAvailable, planAllowsResearch]
  );
  const outgoingOptions = React.useMemo<SendOptions | undefined>(
    () =>
      quote?.mode === "modify"
        ? { artifactEdit: artifactEditRequestFromQuote(quote) }
        : sendOptions,
    [quote, sendOptions]
  );
  // Research lives in the + menu now, so the trigger carries its armed state —
  // otherwise a per-send mode would be on with nothing on screen saying so.
  const researchArmed = !!sendOptions;
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
  // Huge pastes stay in `text` for send, but we collapse the textarea DOM so
  // multi-10k curricula don't freeze / blank the tab. Expand to edit inline.
  const [draftExpanded, setDraftExpanded] = React.useState(false);
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
  // The whole account list, not just the linked apps: "@notion" on an unlinked
  // Notion must be able to say so instead of matching nothing. `configured`
  // gates out apps this deployment has no OAuth credentials for — those can
  // never be connected, so offering them would be a dead end.
  const [allConnectors, setAllConnectors] = React.useState<
    { id: string; label: string; connected: boolean; configured?: boolean }[]
  >([]);
  const connectors = React.useMemo(() => allConnectors.filter((c) => c.connected), [allConnectors]);
  const [connectorsLoading, setConnectorsLoading] = React.useState(false);
  const [connectorQuery, setConnectorQuery] = React.useState("");
  const enabledConnectorIdsRef = React.useRef(connectorsEnabled);
  enabledConnectorIdsRef.current = connectorsEnabled;
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const paletteAnchorRef = React.useRef<HTMLDivElement>(null);
  const paletteListRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);
  const { uploads, addFiles, addAttachments, remove, clear, readyAttachments, isUploading } = useUploads(privateMode ? null : conversationId);
  // Memoized: a fresh `[]` every private-mode render would churn every hook
  // that lists sendAttachments as a dependency.
  const sendAttachments = React.useMemo(() => (privateMode ? [] : readyAttachments), [privateMode, readyAttachments]);
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
  /**
   * Steering mode: busy, but with somewhere for typing to go.
   *
   * Gated on `isBusy` as well as on the caller's flag, because a run and a
   * generation are the same turn from the user's side and the field is only
   * locked during the second. A clarification owns the composer outright while
   * it is up, so it wins over steering — answering the question is the only
   * thing that moves anything forward.
   */
  const steerMode = !!steering?.active && isBusy && status !== "checking" && !pendingClarification;
  const controlsLocked = isBusy || sendLocked || uploading || !!quotaReached;
  const canSend = steerMode
    ? // No attachments and no clarification answers: direction is words, and a
      // file cannot be handed to a run that is already reading.
      text.trim().length > 0 && !sendLocked && !quotaReached
    : (text.trim().length > 0 || sendAttachments.length > 0 || clarificationAnswers.length > 0) && !controlsLocked;
  // With nothing to send and voice available, the primary button becomes the
  // voice-conversation launcher; the moment there's sendable content it morphs
  // back into Send.
  const showVoiceButton = !isBusy && !canSend && !!onOpenVoiceMode;
  // The primary button's four faces, derived once so the stacked glyphs, the
  // tooltip and the busy ring cannot disagree about which state is showing.
  // While steering, a draft flips the face back to Send — the button follows
  // what the field is holding, so Stop is never the only thing a typed
  // constraint can be handed to.
  const primaryFace: "checking" | "stop" | "voice" | "send" =
    status === "checking"
      ? "checking"
      : steerMode && text.trim().length > 0
        ? "send"
        : isBusy
          ? "stop"
          : showVoiceButton
            ? "voice"
            : "send";
  // Never split() multi-MB drafts just to count lines — sample the head only.
  const longText = text.trim().length > COMPOSER_LONG_TEXT_CHARS || sampleLineCount(text) > 30;
  const hugeDraft = text.length > COMPOSER_INLINE_SOFT_CHARS;
  const showCollapsedDraft = hugeDraft && !draftExpanded;

  const attachAsFile = () => {
    const content = text;
    if (!content.trim()) return;
    const file = new File([content], "prompt.txt", { type: "text/plain" });
    addComposerFiles([file]);
    setText("");
    setDraftExpanded(false);
    requestAnimationFrame(autoresize);
  };

  /** When the user names a connected app ("my GitHub", "Figma file…"), turn it
   *  on for this chat and return the full connector list for this send so the
   *  request doesn't wait a render for sticky state to catch up. */
  const resolveSendConnectors = React.useCallback(
    async (prompt: string): Promise<string[] | undefined> => {
      if (privateMode || !onToggleConnector) return undefined;

      let available = connectors.map((c) => ({ id: c.id, label: c.label }));
      // First paint may not have /api/connectors yet — fetch once so a prompt
      // like "use my GitHub" still matches on a cold composer.
      if (available.length === 0) {
        try {
          const response = await fetch("/api/connectors");
          if (response.ok) {
            const data = (await response.json()) as {
              connectors?: { id: string; label: string; connected: boolean }[];
            };
            const list = data.connectors ?? [];
            setAllConnectors(list);
            available = list.filter((c) => c.connected).map((c) => ({ id: c.id, label: c.label }));
          }
        } catch {
          /* keep empty — no auto-enable without a live connection list */
        }
      }
      if (available.length === 0) return connectorsEnabled;

      const merged = detectConnectorsFromPrompt(prompt, available, connectorsEnabled);
      const fresh = newlyDetectedConnectors(prompt, available, connectorsEnabled);
      if (fresh.length > 0) {
        onEnableConnectors?.(fresh);
        if (!onEnableConnectors) {
          for (const id of fresh) {
            if (!connectorsEnabled.includes(id)) onToggleConnector(id);
          }
        }
        const labels = fresh
          .map((id) => available.find((c) => c.id === id)?.label ?? id)
          .filter(Boolean);
        if (labels.length === 1) toast.message(`Enabled ${labels[0]} for this chat`);
        else if (labels.length > 1) toast.message(`Enabled ${labels.join(", ")} for this chat`);
      }
      return merged.length > 0 ? merged : connectorsEnabled;
    },
    [connectors, connectorsEnabled, onEnableConnectors, onToggleConnector, privateMode]
  );

  const submit = async () => {
    if (!canSend) return;
    try {
      // Direction into the live run, not a message into the thread. First,
      // because every path below this builds an outgoing chat turn.
      if (steerMode && steering) {
        const value = text.trim();
        if (!value) return;
        const accepted = await steering.onSteer(value);
        if (accepted) {
          setText("");
          setDraftExpanded(false);
          requestAnimationFrame(autoresize);
        }
        return;
      }
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
      const connectorsForSend = await resolveSendConnectors(outgoing);
      const result = await onSend(outgoing, sendAttachments, {
        ...outgoingOptions,
        ...(connectorsForSend ? { connectors: connectorsForSend } : null),
      });
      if (result && result.accepted === false) return;
      setText("");
      setDraftExpanded(false);
      setResearch(false); // per-send: research never sticks to the next message
      clear();
      onClearQuote?.();
      requestAnimationFrame(autoresize);
    } catch (err) {
      // Never let a large-paste / network failure navigate the SPA away.
      console.error("[composer] send failed", err);
      toast.error(err instanceof Error ? err.message : "Could not send that message. Try again.");
    }
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
        const connectorsForSend = await resolveSendConnectors(outgoing);
        const result = await onSend(outgoing, sendAttachments, {
          ...outgoingOptions,
          ...(connectorsForSend ? { connectors: connectorsForSend } : null),
        });
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
    [text, controlsLocked, quote, onSend, sendAttachments, outgoingOptions, clear, onClearQuote, autoresize, setDictating, resolveSendConnectors]
  );

  // ——— Composer palette: "/" for commands, "@" for tools + connectors ———
  const router = useRouter();

  const toggleMemory = React.useCallback(
    (v: boolean) => {
      setSettings({ memoryEnabled: v });
      fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryEnabled: v }),
      }).catch(() => {});
    },
    [setSettings]
  );

  // The per-chat cap is a rule about connectors, not about one menu — the +
  // submenu and the "@" palette both go through here so they can't drift.
  const pickConnector = React.useCallback(
    (id: string) => {
      if (!onToggleConnector) return;
      const selected = connectorsEnabled.includes(id);
      if (!selected && new Set(connectorsEnabled).size >= MAX_CHAT_CONNECTORS) {
        toast.error(`You can use up to ${MAX_CHAT_CONNECTORS} connectors at once. Turn one off before adding another.`);
        return;
      }
      onToggleConnector(id);
    },
    [connectorsEnabled, onToggleConnector]
  );

  // Group order is also the keyboard order, so "commands" stays first: "/" then
  // Enter has always landed on /model and should keep doing so.
  const commands = React.useMemo<SlashCommand[]>(
    () => [
      { id: "model", key: "model", label: "/model", hint: "Switch the AI model", group: "commands", icon: Cpu },
      { id: "artifact", key: "artifact", label: "/artifact", hint: "Start a canvas / artifact", group: "commands", icon: SquarePen },
      ...(onOpenVoiceMode
        ? [{ id: "voice", key: "voice", label: "/voice", hint: "Start voice mode", group: "commands" as const, icon: AudioLines, run: onOpenVoiceMode }]
        : []),
      {
        id: "new",
        key: "new",
        label: "/new",
        hint: "Start a new chat",
        group: "commands",
        icon: MessageSquarePlus,
        run: () => {
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
          router.push("/chat");
        },
      },
      {
        id: "learn-demo",
        key: "learn-demo",
        label: "/learn-demo",
        hint: "Preview the visual learning blocks",
        group: "commands",
        icon: GraduationCap,
        run: () => window.dispatchEvent(new CustomEvent("juno:learning-demo")),
      },
      {
        id: "search",
        key: "search",
        label: "/search",
        hint: "Let Juno search the web",
        group: "tools",
        icon: ComposerIcons.web,
        on: webSearchEnabled,
        run: () => onToggleWebSearch?.(!webSearchEnabled),
      },
      ...(researchAvailable && planAllowsResearch
        ? [
            {
              id: "research",
              key: "research",
              label: "/research",
              hint: "Deep-research the next message",
              group: "tools" as const,
              icon: ComposerIcons.research,
              on: research,
              run: () => setResearch((v) => !v),
            },
          ]
        : []),
      { id: "projects", key: "projects", label: "/projects", hint: "Open your projects", group: "navigate", icon: AppIcons.projects, run: () => router.push("/projects") },
      { id: "library", key: "library", label: "/library", hint: "Open your library", group: "navigate", icon: AppIcons.library, run: () => router.push("/library") },
      { id: "memory", key: "memory", label: "/memory", hint: "Open memory", group: "navigate", icon: NotebookPen, run: () => router.push("/memory") },
    ],
    [webSearchEnabled, onToggleWebSearch, researchAvailable, planAllowsResearch, research, onOpenVoiceMode, router]
  );

  // "@" rows toggle a capability rather than navigate. A row whose capability is
  // unavailable stays VISIBLE with the reason attached — "@search" on a model
  // that can't search has to say why, not vanish and match nothing.
  const mentions = React.useMemo<SlashCommand[]>(() => {
    const rows: SlashCommand[] = [
      {
        id: "tool:search",
        key: "search",
        label: "@search",
        hint: "Search the web",
        group: "tools",
        icon: ComposerIcons.web,
        on: canWebSearch ? webSearchEnabled : undefined,
        note: canWebSearch ? undefined : modality === "chat" ? "not on this model" : "chat only",
        run: canWebSearch
          ? () => onToggleWebSearch?.(!webSearchEnabled)
          : () => toast.error(`Web search isn’t available ${modality === "chat" ? "on this model" : "for this modality"}.`),
      },
      ...(researchAvailable
        ? [
            {
              id: "tool:research",
              key: "research",
              label: "@research",
              hint: "Deep-research the next message",
              group: "tools" as const,
              icon: ComposerIcons.research,
              on: planAllowsResearch ? research : undefined,
              note: planAllowsResearch ? undefined : "paid plan",
              run: planAllowsResearch
                ? () => setResearch((v) => !v)
                : () => toast.error("Deep research is available on paid plans."),
            },
          ]
        : []),
      {
        id: "tool:canvas",
        key: "canvas",
        label: "@canvas",
        hint: "Canvas & artifacts",
        group: "tools",
        icon: LayoutTemplate,
        on: privateMode ? undefined : canvasEnabled,
        note: privateMode ? "private" : undefined,
        run: privateMode ? () => toast.error("Canvas is off in incognito chats.") : () => onToggleCanvas(!canvasEnabled),
      },
      {
        id: "tool:memory",
        key: "memory",
        label: "@memory",
        hint: "Remember things across chats",
        group: "tools",
        icon: NotebookPen,
        on: settings.memoryEnabled,
        run: () => toggleMemory(!settings.memoryEnabled),
      },
      {
        id: "tool:python",
        key: "python",
        label: "@python",
        hint: "Python sandbox & data analysis",
        group: "tools",
        icon: AppIcons.code,
        on: true,
        run: () => toast.success("Python interpreter & data analysis sandbox active."),
      },
      {
        id: "tool:assistants",
        key: "assistants",
        label: "@assistants",
        hint: "Browse & switch Juno Assistants",
        group: "tools",
        icon: AppIcons.assistants,
        run: () => router.push("/assistants"),
      },
    ];

    if (showConnectors) {
      // Linked apps first: they're the ones "@" can actually switch on.
      const usable = allConnectors
        .filter((connector) => connector.connected || connector.configured)
        .sort((a, b) => Number(b.connected) - Number(a.connected));
      for (const connector of usable) {
        const key = connectorKey(connector.id);
        rows.push({
          id: `connector:${connector.id}`,
          key,
          label: `@${key}`,
          hint: connector.label,
          group: "connectors",
          connectorId: connector.id,
          match: `${connector.label.toLowerCase()} ${key}`,
          on: connector.connected ? connectorsEnabled.includes(connector.id) : undefined,
          note: connector.connected ? undefined : "not connected",
          // Not connected is not a failure — it's a missing setup step, so say
          // what's wrong and go to the one place that can fix it.
          run: connector.connected
            ? () => pickConnector(connector.id)
            : () => {
                toast.info(`${connector.label} isn’t connected yet — opening Connections.`);
                router.push("/connections");
              },
        });
      }
    }
    return rows;
  }, [
    canWebSearch,
    webSearchEnabled,
    onToggleWebSearch,
    modality,
    researchAvailable,
    planAllowsResearch,
    research,
    privateMode,
    canvasEnabled,
    onToggleCanvas,
    settings.memoryEnabled,
    toggleMemory,
    showConnectors,
    allConnectors,
    connectorsEnabled,
    pickConnector,
    router,
  ]);

  // Both triggers share one convention (the only one this composer has ever
  // had): anchored at the START of the draft, and closed by any character the
  // token can't contain — typing a space is how you get a literal "@" or "/".
  const slash = React.useMemo((): SlashState => {
    if (text.startsWith("/")) {
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
        const items = filterRows(commands, cmdMatch[1].toLowerCase());
        return items.length ? { kind: "command", items } : null;
      }
      return null;
    }
    if (text.startsWith("@")) {
      const mentionMatch = text.match(/^@([\w-]*)$/);
      if (mentionMatch) {
        const items = filterRows(mentions, mentionMatch[1].toLowerCase());
        return items.length ? { kind: "mention", items } : null;
      }
      return null;
    }
    return null;
  }, [text, models, commands, mentions]);

  const [slashIndex, setSlashIndex] = React.useState(0);
  /*
   * True only when the arrow keys last moved the selection. The list is
   * height-capped and scrolls, so arrowing past the last visible row walked the
   * cursor somewhere the user could not see. Scrolling on EVERY index change is
   * not the fix: rows set the index on mouseEnter too, so it would yank the list
   * out from under the pointer. Same guard the command palette uses.
   */
  const paletteKeyNavRef = React.useRef(false);
  React.useEffect(() => {
    if (!paletteKeyNavRef.current) return;
    paletteKeyNavRef.current = false;
    document.getElementById(`composer-palette-${slashIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [slashIndex]);
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  const slashOpen = !controlsLocked && !!slash && !slashDismissed && slash.items.length > 0;

  /*
   * The palette is pinned above the anchor by hand, not by Radix popper, so it
   * gets no --radix-*-available-height and nothing measures the room above it
   * for us. That room is not a constant: in the empty state the composer is
   * vertically centred (chat-view.tsx), so a ~700px laptop leaves ~250-320px
   * above it — less than the list's own 18rem. Overflowing is unrecoverable,
   * not merely ugly: rows laid out above a clipper's top edge create no
   * scrollable area, so they cannot be reached.
   */
  const [paletteMaxH, setPaletteMaxH] = React.useState(PALETTE_MAX_H);
  React.useLayoutEffect(() => {
    if (!slashOpen) return;
    const anchor = paletteAnchorRef.current;
    if (!anchor) return;
    const clippers = clipAncestors(anchor);
    const measure = () => {
      let ceiling = 0;
      for (const clipper of clippers) {
        // clientTop = border-top: overflow clips at the padding box, not the border box.
        ceiling = Math.max(ceiling, clipper.getBoundingClientRect().top + clipper.clientTop);
      }
      const room = anchor.getBoundingClientRect().top - ceiling - PALETTE_CHROME;
      const limit = Math.max(0, Math.min(PALETTE_MAX_H, room));
      setPaletteMaxH(snapPaletteToRow(paletteListRef.current, limit));
    };
    /* The clamp depends on the anchor's POSITION, but everything that moves it
     * leaves its own box the same size — the greeting cross-fading above, the
     * voice panel mounting — so a ResizeObserver on the anchor never fires for
     * any of it. Sample per frame while the palette is open (Floating UI's
     * autoUpdate does the same for moved-not-resized anchors); React bails out
     * when the measurement is unchanged, and the palette is open only while a
     * slash/mention token is being typed. */
    let raf = 0;
    const tick = () => {
      measure();
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [slashOpen, slash]);

  React.useEffect(() => setSlashIndex(0), [text]);
  React.useEffect(() => {
    if (!text.startsWith("/") && !text.startsWith("@")) setSlashDismissed(false);
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
        paletteKeyNavRef.current = true;
        setSlashIndex((i) => (i + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        paletteKeyNavRef.current = true;
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
      return;
    }
    // After a large text paste, collapse the textarea so the DOM stays light.
    // React's controlled onChange updates `text` first; we schedule the collapse.
    const pasted = e.clipboardData.getData("text/plain");
    if (pasted.length > COMPOSER_INLINE_SOFT_CHARS) {
      setDraftExpanded(false);
    }
  };

  const setDraftText = React.useCallback((next: string) => {
    setText(next);
    if (next.length <= COMPOSER_INLINE_SOFT_CHARS) setDraftExpanded(false);
  }, []);

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
          connectors?: { id: string; label: string; connected: boolean; configured?: boolean }[];
        };
        if (signal?.aborted) return;
        setAllConnectors(data.connectors ?? []);
        const connected = (data.connectors ?? []).filter((connector) => connector.connected);

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

  // "New project" at the foot of the Add-to-project submenu: create an unnamed
  // project (the API names it from its first chat) and file this chat into it
  // straight away, so it behaves like picking an existing one.
  const [creatingProject, setCreatingProject] = React.useState(false);
  const createProjectAndPick = React.useCallback(async () => {
    if (creatingProject) return;
    setCreatingProject(true);
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.id) throw new Error(d?.error ?? "Could not create project.");
      // Optimistically seed the list so the composer chip has a name to show
      // before the sidebar's reload lands.
      setProjects((prev) => [{ id: d.id, name: "New project", conversationCount: 0 }, ...prev]);
      window.dispatchEvent(new CustomEvent("projects:sync"));
      onPickProject?.(d.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create project.");
    } finally {
      setCreatingProject(false);
      setPlusOpen(false);
    }
  }, [creatingProject, onPickProject]);

  const clearComposerDraft = React.useCallback(() => {
    setText("");
    clear();
    setDictating(false);
    requestAnimationFrame(autoresize);
  }, [autoresize, clear, setDictating]);

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
  const canAttach = features.storage && !privateMode;
  const activeConnectorCount = connectors.filter((connector) => connectorsEnabled.includes(connector.id)).length;
  const connectorSearch = connectorQuery.trim().toLocaleLowerCase();
  const visibleConnectors = connectorSearch
    ? connectors.filter((connector) =>
        `${connector.label} ${connector.id}`.toLocaleLowerCase().includes(connectorSearch)
      )
    : connectors;

  // Counts rows that are ON, not rows that exist: while collapsed this is the only
  // thing in the menu saying that e.g. deep research is armed for this message.
  // Each term repeats its row's own gate so a row that isn't rendered can't count.
  //
  // Named rather than only counted: the + trigger's aria-label used to say "deep
  // research is on for this message" whatever was actually armed, so a screen
  // reader user with web search and four connectors on was told about the one
  // axis that wasn't. Order matches the menu, so hearing the label and opening
  // the menu agree.
  const armedToolsInGroup = [
    researchArmed ? "deep research" : null,
    canWebSearch && webSearchEnabled ? "web search" : null,
    !privateMode && canvasEnabled ? "canvas" : null,
    settings.memoryEnabled ? "memory" : null,
  ].filter((label): label is string => label !== null);
  // Connectors sit in the ADD group, not TOOLS, so they must not inflate the
  // disclosure's count — but they are still armed state the + trigger owes the user.
  const armedConnectors =
    showConnectors && activeConnectorCount > 0
      ? `${activeConnectorCount} connector${activeConnectorCount === 1 ? "" : "s"}`
      : null;
  const armedTools = armedConnectors ? [...armedToolsInGroup, armedConnectors] : armedToolsInGroup;
  const activeToolCount = armedTools.length;
  const armedSummary = activeToolCount > 0 ? `${armedTools.join(", ")} on` : "";

  // Deep research — per-send, so it reads as a toggle that announces its own
  // expiry. Gating matches the toolbar chip this replaced exactly: hidden
  // without a Tavily key, in private chat, and on non-chat models; disabled
  // with an upgrade hint on Free. Shared by both menus because the old chip
  // lived on the toolbar, which voice mode also renders.
  const researchMenuItem = researchAvailable ? (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={research && planAllowsResearch}
      disabled={!planAllowsResearch}
      className="flex h-9 items-center justify-between gap-2 rounded-menu px-2.5 cursor-pointer text-xs"
      onSelect={(event) => {
        event.preventDefault();
        setResearch((v) => !v);
      }}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <ComposerIcons.research className="size-4 text-muted-foreground mr-2.5 shrink-0" />
        <span className="truncate font-medium">Deep research</span>
      </div>
      {planAllowsResearch ? (
        <Switch checked={research} tabIndex={-1} aria-hidden className="pointer-events-none shrink-0" />
      ) : (
        <span className="text-micro font-medium text-muted-foreground">Pro</span>
      )}
    </DropdownMenuItem>
  ) : null;

  // Voice mode's TOOLS group is a single row (research), so it stays a plain
  // label — a disclosure over one item is just a lid.
  const toolsLabel = (
    <DropdownMenuLabel className="flex items-center gap-1.5 font-mono text-label">
      <Blocks className="size-3.5" />
      Tools
    </DropdownMenuLabel>
  );



  return (
    <div
      ref={rootRef}
      className="mx-auto w-full max-w-[calc(100vw-1.5rem)] px-0 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-[48rem] sm:px-4"
    >
      {quotaReached && (
        <div role="status" className="mb-2 rounded-card border border-primary/30 bg-primary/5 px-3 py-2 text-center text-sm text-foreground">
          {planIncludesNoMessages ? (
            <>
              The Free plan doesn&apos;t include any messages.{" "}
              <a href="/upgrade" className="font-medium text-primary underline-offset-2 hover:underline">
                Upgrade to start chatting
              </a>
            </>
          ) : (
            <>
              You&apos;ve reached your monthly limit.{" "}
              <a href="/upgrade" className="font-medium text-primary underline-offset-2 hover:underline">
                Upgrade to keep chatting
              </a>
            </>
          )}
        </div>
      )}

      {/* Existing chats get the persistent scope bar at the top of the chat
          instead; the chip only announces where a brand-new chat will land. */}
      {selectedProject && !privateMode && !conversationId && (
        <div className="mb-2 flex">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card/80 px-2.5 py-1 text-caption text-muted-foreground shadow-soft">
            <AppIcons.projects className="size-3 text-primary" />
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
              <ActionIcons.dismiss className="size-3" />
            </button>
          </span>
        </div>
      )}

      {/*
       * Composer ⇄ Dictation live in the SAME grid cell and cross-fade.
       *
       * This used to animate min-height, padding-top AND the composer's
       * max-height at once, while also flipping the composer to `absolute` —
       * four layout properties mid-flight, so every frame forced a reflow and
       * the swap visibly stuttered. Now the only animated layout property is the
       * container's min-height (needed to open headroom for the dictation
       * transcript preview, which floats above the capsule); both layers
       * themselves move on opacity/transform, which stay on the compositor.
       */}
      <div
        className={cn(
          "relative grid w-full grid-cols-1 grid-rows-1 items-center justify-items-center transition-[min-height] duration-slow ease-out-strong motion-reduce:transition-none",
          dictating ? "min-h-[170px]" : "min-h-[68px]"
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
            "col-start-1 row-start-1 z-30 flex w-full justify-center transition-[opacity,transform] duration-base ease-out-strong motion-reduce:transition-none",
            dictating ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-1 scale-95 opacity-0"
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
          // `inert` is what actually takes this half of the cross-fade out of the
          // page. `opacity-0 pointer-events-none` hides it from the eye and the
          // mouse and leaves it in the tab order and the accessibility tree, so a
          // keyboard or screen-reader user could reach a composer that is not on
          // screen — and, mid-dictation, type into it. Same defect the chat
          // transcript's jump-to-latest button had.
          inert={dictating}
          className={cn(
            /*
             * No `shadow-none`. It used to close this line, and because Tailwind
             * emits utilities after the components layer at equal specificity, it
             * beat `.composer-surface`'s box-shadow — so the composer rendered as
             * a flat bordered rectangle with no material at all, and the
             * `[data-juno-chat-root] .composer-surface` rule written specifically
             * to give this surface its in-product elevation was dead code that
             * never painted a pixel. On the black ground that mattered twice over:
             * the dark treatment carries an INSET top highlight, which is the only
             * depth cue that survives on #000, and it was being suppressed too.
             */
            "composer-surface col-start-1 row-start-1 relative flex max-h-[600px] w-full origin-center flex-col rounded-composer border bg-card/95 shadow-[0_2px_12px_rgba(0,0,0,0.03)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)]",
            "transition-[opacity,transform,border-color,box-shadow,height] duration-base ease-out-strong motion-reduce:transition-none",
            dictating ? "pointer-events-none -translate-y-1 scale-[0.97] opacity-0" : "translate-y-0 scale-100 opacity-100",
            clarificationOpen ? "gap-3 p-3 sm:gap-3.5 sm:p-3.5" : "",
            privateMode
              ? "border-dashed border-foreground/25"
              : "border-border/80 focus-within:border-foreground/25 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.08)] dark:focus-within:shadow-[0_6px_28px_rgba(0,0,0,0.4)]",
            dragging && "border-primary/55 ring-2 ring-primary/20"
          )}
        >
        {dragging && !privateMode && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-inherit border-2 border-dashed border-primary/45 bg-primary/10 backdrop-blur-sm motion-safe:animate-fade-in">
            <FileUp className="size-6 text-primary" />
            <span className="font-mono text-label text-primary">Drop to attach</span>
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
          // The palette's containing block: it carries `relative`, so this — not
          // the capsule — is what its `bottom-full` resolves against, and so this
          // is the top edge the room above it must be measured from.
          ref={paletteAnchorRef}
          className={cn(
            "relative flex w-full flex-col transition-[opacity,transform] duration-base ease-out-soft",
            // Keep the free-text path calm under a clarification — no second heavy card.
            clarificationOpen
              ? "rounded-card border border-border/45 bg-secondary px-3 py-2.5 sm:rounded-popover sm:px-3.5 sm:py-3"
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
                      // The chip sits inside the composer shell, which is `bg-card`.
                      // `bg-background` is pure black in dark — DARKER than its own
                      // container — so an attached file read as a hole punched in
                      // the composer, and its `shadow-soft` (black ink) had nothing
                      // to cast onto. `bg-secondary` is the rung above card, which
                      // is what "raised chip" actually means here.
                      // `rounded-field` — the small-container rung. rounded-md was
                      // off the ladder, and 2px sharper than the quote card below,
                      // which is the same species of object in the same slot.
                      "group relative flex items-center gap-2 rounded-field border bg-secondary px-2.5 py-2",
                      removingIds.includes(u.localId) ? "pointer-events-none motion-safe:animate-pop-out" : "motion-safe:animate-rise-in"
                    )}
                  >
                    {u.attachment?.kind === "IMAGE" ? (
                      <Image src={u.attachment.url} unoptimized={requiresViewerCredentials(u.attachment.url)} alt={u.fileName} width={32} height={32} className="size-8 rounded-xs object-cover" />
                    ) : (
                      <CodeIcons.file className="size-5 text-muted-foreground" />
                    )}
                    <div className="max-w-[140px]">
                      <p className="truncate text-ui font-medium">{u.fileName}</p>
                      {/* Size / progress is metadata, so it takes the mono voice —
                          the quote card's location line beside it already does. */}
                      <p className="font-mono text-caption tabular-nums text-muted-foreground">
                        {u.status === "uploading" ? `${u.progress}%` : u.status === "error" ? "Failed" : formatBytes(u.size)}
                      </p>
                    </div>
                    {u.status === "uploading" && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                    <button
                      type="button"
                      onClick={() => removeUpload(u.localId)}
                      className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background opacity-0 shadow-soft transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 coarse:-right-2.5 coarse:-top-2.5 coarse:p-1.5 coarse:opacity-100"
                      aria-label="Remove attachment"
                    >
                      <ActionIcons.dismiss className="size-3 coarse:size-4" />
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
              // `rounded-field`, like the collapsed-draft card that shares this
              // slot — the two attachment cards were on two radii for no reason.
              "mx-3 mt-3 flex items-start gap-2.5 rounded-field border border-primary/25 bg-primary/5 px-3 py-2 shadow-soft",
              quoteRemoving ? "pointer-events-none motion-safe:animate-pop-out" : "motion-safe:animate-rise-in"
            )}
          >
            {/* Same size-6 tile as PaletteIcon, so the same rounded-xs corner. */}
            <span
              aria-hidden
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-xs border border-primary/25 bg-primary/10 text-primary"
            >
              {quote.kind === "element" ? (
                <SquareDashedMousePointer className="size-3.5" />
              ) : (
                <TextQuote className="size-3.5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="shrink-0 font-mono text-label text-primary">
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
              <ActionIcons.dismiss className="size-3.5" />
            </button>
          </div>
        )}

        {showCollapsedDraft && (
          <div
            className="mx-3 mt-3 flex flex-col gap-2 rounded-field border border-border/70 bg-secondary px-3 py-3 sm:mx-3.5"
            tabIndex={0}
            role="group"
            aria-label="Large paste ready to send. Press Enter to send."
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Large paste ready to send</p>
                <p className="mt-0.5 font-mono text-caption text-muted-foreground">
                  {text.length.toLocaleString()} characters · full text is kept and will be sent · Enter to send
                </p>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-caption text-muted-foreground/90">
                  {text.slice(0, 280)}
                  {text.length > 280 ? "…" : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Clear paste"
                className="shrink-0"
                onClick={() => {
                  setText("");
                  setDraftExpanded(false);
                  requestAnimationFrame(autoresize);
                }}
              >
                <ActionIcons.dismiss className="size-3.5" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5"
                onClick={() => {
                  setDraftExpanded(true);
                  requestAnimationFrame(() => {
                    const el = textareaRef.current;
                    if (!el) return;
                    el.focus();
                    const len = el.value.length;
                    el.setSelectionRange(len, len);
                    autoresize();
                  });
                }}
              >
                <ActionIcons.edit className="size-3.5" /> Expand to edit
              </Button>
              {features.storage && !privateMode && (
                <Button type="button" variant="outline" size="sm" onClick={attachAsFile} className="h-7 gap-1.5">
                  <FileUp className="size-3.5" /> Attach as file
                </Button>
              )}
            </div>
          </div>
        )}

        {longText && !showCollapsedDraft && features.storage && !privateMode && (
          <div className="flex items-center justify-between gap-3 px-4 pt-3">
            <span className="text-caption text-muted-foreground">
              That’s a long one — attach it as a file to keep the chat tidy?
            </span>
            <Button type="button" variant="outline" size="sm" onClick={attachAsFile} className="h-7 shrink-0 gap-1.5">
              <FileUp className="size-3.5" /> Attach as file
            </Button>
          </div>
        )}

        {/* Matches the DropdownMenu/Popover surface exactly — this is the same
            kind of object as the + menu and shouldn't read as its own species.
            No duration or ease utility here: tailwindcss-animate would land it on
            animate-pop-in's animation- longhands and clobber the pop. origin-bottom
            rather than .origin-popper because this is not Radix popper content —
            it's pinned to the composer's top edge, so the pop scales out of it. */}
        {slashOpen && slash && (
          // No `shadow-float` here: .glass-raised already sets box-shadow (its
          // inset sheen + --shadow-glass), and a utility beats the components
          // layer — so adding shadow-float silently replaced the glass entirely
          // and left this popover looking unlike the + menu beside it.
          // DropdownMenuContent uses glass-raised alone; match it.
          <div className="absolute bottom-full left-2 right-2 z-30 mb-2 origin-bottom overflow-hidden rounded-menu border border-border/60 bg-popover/90 p-1.5 text-popover-foreground glass-raised backdrop-blur-xl motion-safe:animate-pop-in">
            {/* Options, not tab stops: the caret never leaves the textarea, so this
                is a combobox popup. A button row also could not legally hold the
                Switch, which is itself a button. */}
            <div
              ref={paletteListRef}
              id="composer-palette-listbox"
              role="listbox"
              aria-label={slash.kind === "model" ? "Switch model" : slash.kind === "mention" ? "Tools and connectors" : "Commands"}
              // Measured, not `max-h-72`: the cap is whatever fits above the anchor.
              style={{ maxHeight: paletteMaxH }}
              className="overflow-y-auto overscroll-contain"
            >
              {slash.kind === "model" ? (
                <div role="group" aria-label="Switch model">
                  <PaletteEyebrow label="Switch model" />
                  {slash.items.map((m, i) => (
                    <div
                      key={m.id}
                      id={`composer-palette-${i}`}
                      role="option"
                      aria-selected={i === slashIndex}
                      onMouseEnter={() => setSlashIndex(i)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applySlash(m)}
                      className={paletteRowClass(i === slashIndex)}
                    >
                      <PaletteIcon>
                        <ProviderLogo provider={m.provider} className="size-4" />
                      </PaletteIcon>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</span>
                      <span className="shrink-0 text-caption text-muted-foreground">
                        {PROVIDERS[m.provider].label.split(" · ")[0]}
                      </span>
                      {m.id === model && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
                    </div>
                  ))}
                </div>
              ) : (
                groupRows(slash.items).map(({ group, rows }) => (
                  <div
                    key={group}
                    role="group"
                    // The eyebrow is aria-hidden, so the cap has to ride on the
                    // group name or it would exist for sighted users only.
                    aria-label={
                      group === "connectors"
                        ? `Connectors, ${activeConnectorCount} of ${MAX_CHAT_CONNECTORS} on`
                        : GROUP_LABELS[group]
                    }
                  >
                    <PaletteEyebrow
                      label={GROUP_LABELS[group]}
                      counter={group === "connectors" ? `${activeConnectorCount}/${MAX_CHAT_CONNECTORS}` : undefined}
                    />
                    {rows.map(({ item, index }) => {
                      const Icon = item.icon;
                      const selected = index === slashIndex;
                      return (
                        <div
                          key={item.id}
                          id={`composer-palette-${index}`}
                          role="option"
                          aria-selected={selected}
                          // aria-selected is the keyboard cursor; aria-checked is
                          // the tool's own state. The Switch that draws it is
                          // aria-hidden, so without this the state is visual only.
                          aria-checked={item.on}
                          onMouseEnter={() => setSlashIndex(index)}
                          // Keeps the caret (and the draft's selection) in the
                          // textarea when a row is picked with the mouse.
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => applySlash(item)}
                          className={paletteRowClass(selected)}
                        >
                          <PaletteIcon>
                            {item.connectorId ? (
                              <ConnectorMark id={item.connectorId} className="size-3.5 text-foreground" />
                            ) : Icon ? (
                              // Coral marks a tool that is ON — the one state worth
                              // colouring. Selection is the ring, not the colour.
                              <Icon className={cn("size-3.5", item.on ? "text-primary" : "text-muted-foreground")} />
                            ) : null}
                          </PaletteIcon>
                          <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="max-w-[55%] shrink-0 truncate font-mono text-sm">{item.label}</span>
                            <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{item.hint}</span>
                          </span>
                          {item.note ? (
                            <span className="shrink-0 whitespace-nowrap text-caption text-muted-foreground">
                              {item.note}
                            </span>
                          ) : item.on !== undefined ? (
                            <Switch checked={item.on} tabIndex={-1} aria-hidden className="pointer-events-none shrink-0" />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Huge drafts render as a compact card above; keep the textarea out of
            the DOM so React never diffs multi-10k controlled values every key. */}
        {!showCollapsedDraft && (
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            // Steering keeps the field live through a generation — that is the
            // whole point of it. Every other busy state still locks it.
            disabled={(isBusy && !steerMode) || sendLocked || status === "checking"}
            rows={1}
            placeholder={steerMode && steering ? steering.placeholder : placeholder}
            // The palette is driven from here — focus never moves to it — so the
            // textarea has to name the row the arrow keys are sitting on, and
            // aria-controls ties that row's listbox back to this field while it
            // is showing (activedescendant alone leaves AT to guess which list).
            aria-controls={slashOpen ? "composer-palette-listbox" : undefined}
            aria-activedescendant={
              slashOpen && slash ? `composer-palette-${Math.min(slashIndex, slash.items.length - 1)}` : undefined
            }
            className={cn(
              "w-full resize-none bg-transparent px-4 pb-3 pt-4 leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground/70 disabled:opacity-70 sm:px-[18px] sm:pt-[17px]",
              // `text-base` (16px) at rest is load-bearing, not stylistic: iOS
              // Safari zooms the whole page into any focused field below 16px.
              // The clarification / huge-draft states step down to the body rung;
              // under a clarification the leading tightens too, so the capped
              // 72px window shows three lines instead of two and a bit.
              clarificationOpen
                ? "max-h-[72px] min-h-[40px] text-body leading-snug"
                : hugeDraft
                  ? "max-h-[min(60vh,28rem)] min-h-[120px] text-body"
                  : "max-h-[200px] min-h-[64px] text-base"
            )}
          />
        )}

        <div className="flex flex-nowrap items-center justify-between gap-1.5 px-3 pb-2.5 pt-0.5 sm:px-3.5 sm:pb-3">
          {/* Left: + menu */}
          <div className="flex min-w-0 items-center gap-1">
            <DropdownMenu open={plusOpen} onOpenChange={setPlusOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={armedSummary ? `Add — ${armedSummary}` : "Add"}
                      disabled={controlsLocked}
                      className={cn(
                        "composer-chip group size-8 shrink-0 rounded-composer-control border border-border/50 bg-secondary/30 hover:bg-accent hover:border-border text-muted-foreground hover:text-foreground transition-all duration-fast flex items-center justify-center coarse:size-11",
                        plusOpen && "bg-accent border-border text-foreground ring-1 ring-border/50"
                      )}
                    >
                      <Plus
                        aria-hidden="true"
                        className="size-4 text-muted-foreground transition-colors group-hover:text-foreground"
                      />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>{armedSummary ? `Add — ${armedSummary}` : "Add files, tools and integrations"}</TooltipContent>
              </Tooltip>

              <DropdownMenuContent
                align="start"
                side="top"
                sideOffset={8}
                collisionPadding={24}
                avoidCollisions={true}
                className="w-60 max-h-[var(--radix-dropdown-menu-content-available-height,360px)] overflow-y-auto rounded-panel border border-border/80 bg-popover/98 p-1.5 text-popover-foreground shadow-2xl backdrop-blur-2xl"
              >
                {voiceActive ? (
                  <>
                    <DropdownMenuItem
                      disabled={!features.storage || privateMode}
                      onSelect={() => fileInputRef.current?.click()}
                      className="flex h-9 items-center rounded-menu px-2.5 cursor-pointer text-xs"
                    >
                      <Paperclip className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                      <span className="flex-1 font-medium">Add files or photos</span>
                    </DropdownMenuItem>
                    {researchMenuItem && (
                      <>
                        <DropdownMenuSeparator className="my-1" />
                        {toolsLabel}
                        {researchMenuItem}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <DropdownMenuItem
                      disabled={!canAttach}
                      onSelect={() => fileInputRef.current?.click()}
                      className="flex h-9 items-center rounded-menu px-2.5 cursor-pointer text-xs"
                    >
                      <Paperclip className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                      <span className="flex-1 font-medium">Add files or photos</span>
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      onSelect={() => setLibraryOpen(true)}
                      className="flex h-9 items-center rounded-menu px-2.5 cursor-pointer text-xs"
                    >
                      <AppIcons.library className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                      <span className="flex-1 font-medium">Library</span>
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      disabled={privateMode}
                      onSelect={() => startCanvas()}
                      className="flex h-9 items-center rounded-menu px-2.5 cursor-pointer text-xs"
                    >
                      <SquarePen className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                      <span className="flex-1 font-medium">New canvas</span>
                    </DropdownMenuItem>

                    <DropdownMenuSeparator className="my-1" />

                    <DropdownMenuItem
                      role="menuitemcheckbox"
                      aria-checked={canWebSearch && webSearchEnabled}
                      disabled={!canWebSearch}
                      onSelect={(event) => {
                        event.preventDefault();
                        onToggleWebSearch?.(!webSearchEnabled);
                      }}
                      className="flex h-9 items-center justify-between gap-2 rounded-menu px-2.5 cursor-pointer text-xs"
                    >
                      <div className="flex min-w-0 flex-1 items-center">
                        <ComposerIcons.web className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                        <span className="truncate font-medium">Web search</span>
                      </div>
                      {canWebSearch ? (
                        <Switch checked={webSearchEnabled} tabIndex={-1} aria-hidden className="pointer-events-none shrink-0" />
                      ) : (
                        <span className="text-micro font-medium text-muted-foreground">Off</span>
                      )}
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      role="menuitemcheckbox"
                      aria-checked={!privateMode && canvasEnabled}
                      disabled={privateMode}
                      onSelect={(event) => {
                        event.preventDefault();
                        onToggleCanvas(!canvasEnabled);
                      }}
                      className="flex h-9 items-center justify-between gap-2 rounded-menu px-2.5 cursor-pointer text-xs"
                    >
                      <div className="flex min-w-0 flex-1 items-center">
                        <LayoutTemplate className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                        <span className="truncate font-medium">Canvas editor</span>
                      </div>
                      <Switch checked={!privateMode && canvasEnabled} tabIndex={-1} aria-hidden className="pointer-events-none shrink-0" />
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      role="menuitemcheckbox"
                      aria-checked={settings.memoryEnabled}
                      onSelect={(event) => {
                        event.preventDefault();
                        toggleMemory(!settings.memoryEnabled);
                      }}
                      className="flex h-9 items-center justify-between gap-2 rounded-menu px-2.5 cursor-pointer text-xs"
                    >
                      <div className="flex min-w-0 flex-1 items-center">
                        <NotebookPen className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                        <span className="truncate font-medium">Memory</span>
                      </div>
                      <Switch checked={settings.memoryEnabled} tabIndex={-1} aria-hidden className="pointer-events-none shrink-0" />
                    </DropdownMenuItem>

                    {researchMenuItem}

                    {(!privateMode || showConnectors) && <DropdownMenuSeparator className="my-1" />}

                    {!privateMode && (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="flex h-9 items-center rounded-menu px-2.5 cursor-pointer text-xs">
                          <AppIcons.projects className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                          <span className="flex-1 font-medium">Project</span>
                          {selectedProject && (
                            <span className="font-mono text-micro text-primary truncate max-w-[80px] mr-1">
                              {selectedProject.name}
                            </span>
                          )}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="flex max-h-[min(20rem,55vh)] w-56 flex-col p-1 rounded-card shadow-2xl">
                          <ScrollFade className="min-h-0 flex-1" viewportClassName="p-1 space-y-0.5">
                            {loadingProjects && projects.length === 0 ? (
                              <div className="flex items-center justify-center py-4">
                                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                              </div>
                            ) : projects.length === 0 ? (
                              <p className="px-2 py-3 text-center text-micro text-muted-foreground">
                                No projects yet.
                              </p>
                            ) : (
                              projects.map((project) => {
                                const active = selectedProjectId === project.id;
                                return (
                                  <DropdownMenuItem
                                    key={project.id}
                                    onSelect={() => pickProject(active ? null : project.id)}
                                    className="rounded-field px-2 py-1.5 text-xs"
                                  >
                                    <AppIcons.projects className={cn("size-3.5 mr-2", active ? "text-primary" : "text-muted-foreground")} />
                                    <span className="flex-1 truncate">{project.name}</span>
                                    {active && <StatusIcons.success className="size-3 text-primary" />}
                                  </DropdownMenuItem>
                                );
                              })
                            )}
                          </ScrollFade>
                          <div className="shrink-0 border-t border-border/60 pt-1">
                            <DropdownMenuItem
                              disabled={creatingProject}
                              onSelect={(e) => {
                                e.preventDefault();
                                void createProjectAndPick();
                              }}
                              className="rounded-field px-2 py-1.5 text-xs font-medium text-primary"
                            >
                              {creatingProject ? (
                                <Loader2 className="size-3 animate-spin mr-1.5" />
                              ) : (
                                <Plus className="size-3 mr-1.5" />
                              )}
                              <span>New project</span>
                            </DropdownMenuItem>
                          </div>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}

                    {showConnectors && (
                      <DropdownMenuSub onOpenChange={(open) => !open && setConnectorQuery("")}>
                        <DropdownMenuSubTrigger className="flex h-9 items-center rounded-menu px-2.5 cursor-pointer text-xs">
                          <Plug className="size-4 text-muted-foreground mr-2.5 shrink-0" />
                          <span className="flex-1 font-medium">Connectors</span>
                          {activeConnectorCount > 0 && (
                            <span className="font-mono text-micro text-primary mr-1">
                              {activeConnectorCount}
                            </span>
                          )}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-64 p-1 rounded-card shadow-2xl">
                          <div className="border-b border-border/60 p-1.5">
                            <label className="relative block">
                              {/* Raw `Search`: this filters the connector list in
                                  place. `AppIcons.search` is the app's search
                                  destination, which this never opens. */}
                              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                              <input
                                value={connectorQuery}
                                onChange={(event) => setConnectorQuery(event.target.value)}
                                onKeyDown={(event) => event.stopPropagation()}
                                placeholder="Search apps…"
                                aria-label="Search apps"
                                className="h-7.5 w-full rounded-md border border-border/60 bg-background/80 pl-7 pr-2 text-xs outline-none focus:border-primary/50"
                              />
                            </label>
                          </div>
                          <div className="max-h-52 overflow-y-auto p-1 space-y-0.5">
                            {connectorsLoading && connectors.length === 0 ? (
                              <div className="flex flex-col gap-1 p-1">
                                {[0, 1, 2].map((row) => (
                                  <span key={row} className="skeleton h-8 rounded-lg" />
                                ))}
                              </div>
                            ) : connectors.length === 0 ? (
                              <DropdownMenuItem onSelect={() => router.push("/connections")} className="rounded-lg text-xs">
                                <Plug className="size-3.5 text-muted-foreground mr-2" />
                                <span className="flex-1">Connect an app</span>
                              </DropdownMenuItem>
                            ) : visibleConnectors.length === 0 ? (
                              <div className="px-2 py-3 text-center text-micro text-muted-foreground">
                                No apps match “{connectorQuery.trim()}”.
                              </div>
                            ) : (
                              visibleConnectors.map((connector) => {
                                const selected = connectorsEnabled.includes(connector.id);
                                return (
                                  <DropdownMenuItem
                                    key={connector.id}
                                    onSelect={(event) => {
                                      event.preventDefault();
                                      pickConnector(connector.id);
                                    }}
                                    className="rounded-lg px-2 py-1.5 cursor-pointer text-xs"
                                  >
                                    <ConnectorMark id={connector.id} className="size-3.5 mr-2" />
                                    <span className="min-w-0 flex-1 truncate">{connector.label}</span>
                                    <Switch checked={selected} className="pointer-events-none scale-75" />
                                  </DropdownMenuItem>
                                );
                              })
                            )}
                          </div>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Model selector on the LEFT */}
            <div
              className={cn(
                "min-w-0 shrink-0 transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
                controlsLocked && "pointer-events-none opacity-60"
              )}
              aria-disabled={controlsLocked}
            >
              <ModelSelector value={model} onChange={changeModel} reasoningEffort={reasoningEffort} onReasoningChange={onReasoningChange} />
            </div>

            {/* Thinking / Reasoning selector on the LEFT */}
            {isAuto && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-disabled
                    aria-label="Thinking effort: Auto — chosen automatically with the model"
                    className="composer-chip h-8 shrink-0 cursor-default justify-center gap-1 rounded-composer-control px-2.5 font-mono text-ui tracking-tight text-muted-foreground opacity-70 hover:bg-transparent hover:text-muted-foreground active:scale-100 coarse:h-11"
                  >
                    <span className="min-w-0 truncate">Auto</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Thinking depth is chosen automatically with the model</TooltipContent>
              </Tooltip>
            )}

            {!isAuto && effortOptions.length > 0 && (() => {
              const clampedEffort = resolved ? clampReasoningEffort(resolved, reasoningEffort) : reasoningEffort;
              const currentEffort = effortOptions.find((e) => e.value === clampedEffort) ?? effortOptions[0];
              const compactEffortLabel = currentEffort.label === "Extra high" ? "X-high" : currentEffort.label;
              const atTopTier =
                effortOptions.length > 1 && currentEffort.value === effortOptions[effortOptions.length - 1].value;
              return (
                <Tooltip>
                  <Popover>
                    <PopoverTrigger asChild>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={controlsLocked}
                          aria-label={`Thinking effort: ${currentEffort.label}${canFastMode ? `; Flash mode ${fastMode ? "on" : "off"}` : ""}${canProMode ? `; Pro mode ${proMode ? "on" : "off"}` : ""}`}
                          className={cn(
                            "composer-chip group h-8 shrink-0 items-center justify-between gap-1.5 rounded-composer-control px-2.5 font-mono text-ui tracking-tight coarse:h-11",
                            atTopTier ? "text-primary" : "text-foreground"
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate text-center">
                            {compactEffortLabel}
                          </span>
                          <ChevronDown className="size-3 shrink-0 opacity-50 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" />
                        </Button>
                      </TooltipTrigger>
                    </PopoverTrigger>
                    <PopoverContent align="start" sideOffset={10} className="w-[300px] origin-popper p-4 rounded-2xl border border-border/80 bg-popover/98 text-popover-foreground shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-[#161618]/98">
                      <ReasoningSlider
                        options={effortOptions}
                        value={reasoningEffort}
                        onChange={onReasoningChange}
                        disabled={controlsLocked}
                        fastMode={fastMode}
                        onFastModeChange={canFastMode && onToggleFastMode ? onToggleFastMode : undefined}
                        proMode={proMode}
                        onProModeChange={canProMode && onToggleProMode ? toggleProMode : undefined}
                      />
                    </PopoverContent>
                  </Popover>
                  <TooltipContent>Thinking effort</TooltipContent>
                </Tooltip>
              );
            })()}
          </div>

          {/* Right: dictation mic + primary action (voice ⇄ send ⇄ stop). */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                    className="composer-mic-button rounded-composer-control coarse:size-11"
                  >
                    <Mic className="composer-mic-icon size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Dictate</TooltipContent>
              </Tooltip>
            )}

            {speechSupported && (
              <span className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block" aria-hidden="true" />
            )}

            {/* Primary action morphs in place: Voice (empty) → Send (has text) → Stop (busy). */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  onClick={
                    primaryFace === "stop"
                      ? onStop
                      : primaryFace === "voice"
                        ? onOpenVoiceMode
                        : () => void submit()
                  }
                  disabled={
                    primaryFace === "stop"
                      ? status === "stopping" || status === "checking"
                      : primaryFace === "voice"
                        ? false
                        : !canSend
                  }
                  aria-label={
                    primaryFace === "stop"
                      ? status === "stopping"
                        ? "Stopping generation"
                        : "Stop generating"
                      : primaryFace === "voice"
                        ? "Start voice conversation"
                        : steerMode
                          ? "Add this to the research"
                          : "Send message"
                  }
                  className={cn(
                    "composer-primary-action size-9 rounded-composer-action coarse:size-11 transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-base ease-out-strong",
                    primaryFace === "stop" && "ring-2 ring-primary/15"
                  )}
                >
                  <span aria-hidden="true" className="grid place-items-center">
                    <Loader2
                      className={cn(
                        "col-start-1 row-start-1 size-4 transition-[opacity,transform] duration-exit ease-out-soft",
                        primaryFace === "checking" ? "scale-100 animate-spin opacity-100" : "scale-75 opacity-0 motion-reduce:scale-100"
                      )}
                    />
                    <Square
                      className={cn(
                        "col-start-1 row-start-1 size-3.5 fill-current transition-[opacity,transform] duration-exit ease-out-soft",
                        primaryFace === "stop"
                          ? "composer-stop-icon scale-100 opacity-100"
                          : "scale-75 opacity-0 motion-reduce:scale-100"
                      )}
                    />
                    <span
                      className={cn(
                        "composer-voice-wave col-start-1 row-start-1 transition-[opacity,transform] duration-exit ease-out-soft",
                        primaryFace === "voice" ? "scale-100 opacity-100" : "scale-75 opacity-0 motion-reduce:scale-100"
                      )}
                    >
                      <span /><span /><span /><span /><span />
                    </span>
                    <ArrowUp
                      className={cn(
                        "col-start-1 row-start-1 size-4 transition-[opacity,transform] duration-exit ease-out-soft",
                        primaryFace === "send"
                          ? "composer-send-icon scale-100 opacity-100"
                          : "scale-75 opacity-0 motion-reduce:scale-100"
                      )}
                    />
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {primaryFace === "stop"
                  ? steerMode
                    ? "Stop the research"
                    : "Stop"
                  : primaryFace === "voice"
                    ? "Voice conversation"
                    : steerMode
                      ? "Add to the research"
                      : "Send"}
              </TooltipContent>
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
      {!hideDisclaimer && privateMode && (
        <p className="mt-2 text-center text-micro text-muted-foreground">
          Incognito chats are not saved or added to memory.
        </p>
      )}
    </div>
  );
}
