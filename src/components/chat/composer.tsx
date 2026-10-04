"use client";

import * as React from "react";
import { ContextComposerField, rememberContextItem, type ContextFieldElement } from "./context-composer-field";
import { type ContextToken, rangesForStoredText } from "@/lib/chat/context-tokens";
import {
  appendToDraft,
  clearComposerDraft as forgetStoredDraft,
  readComposerDraft,
  tokensForRemainder,
  tokensForText,
  writeComposerDraft,
} from "@/lib/chat/context-draft";
import { placeComposerLayer, preferredLayerSide, type LayerPlacement, type LayerSide } from "@/lib/chat/composer-layer-placement";
import { TIMING } from "@/lib/interaction";
import type { MentionItem, MentionSearchResult } from "@/lib/mentions/types";
import type { VoiceCallParts } from "@/components/voice/realtime-voice";
import { VoiceComposerGlow } from "@/components/voice/voice-composer-glow";
import nextDynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import {
  AudioLines,
  Crop,
  Mic,
  Plus,
  Scan,
  Search,
  SquareDashedMousePointer,
  TextQuote,
  AtSign,
  Pencil,
} from "@/components/ui/icons";
import type { IconComponent } from "@/components/ui/icons";
import { useComposerSketch } from "@/components/chat/sketch/use-composer-sketch";
import { toast } from "sonner";
import {
  ActionIcons,
  AppIcons,
  ComposerIcons,
  SettingsIcons,
  StatusIcons,
} from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  ComposerAttachmentRow,
  ComposerPrimaryAction,
  ComposerArmedMark,
  ComposerFieldLead,
  ComposerShell,
  composerFieldClass,
  composerIconButtonClass,
  useComposerAutosize,
  type ComposerPrimaryFace,
} from "@/components/ui/composer-shell";
import { useModifierKeyLabel } from "@/components/ui/platform";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  PlusMenu,
  PlusMenuRow,
  PlusMenuSeparator,
  type PlusMenuItem,
  type PlusMenuSection,
} from "@/components/chat/composer-plus-menu";
import { researchEffortFor } from "@/lib/research/auto-effort";
import type { ResearchEffort } from "@/lib/research/domain";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { ModelSelector } from "@/components/chat/model-selector";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { LibraryPicker } from "@/components/chat/library-picker";
import { useFileDrop } from "@/components/library/library-drop-zone";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";
/**
 * Split: it renders only while a clarification is pending, which is a state
 * most messages never enter, and its render site is already guarded on
 * `pendingClarification`. `ssr: false` because a pending clarification is
 * client state by construction — the server has never had one to render.
 */
const ComposerClarificationPopover = nextDynamic(
  () =>
    import("@/components/chat/composer-clarification-popover").then(
      (m) => m.ComposerClarificationPopover,
    ),
  { ssr: false },
);
import { resolveModel, type ModelInfo } from "@/lib/models";
import { isAutoModelId } from "@/lib/auto-model";
import {
  reasoningOptions,
  defaultReasoning,
  clampReasoningEffort,
  supportsProMode,
} from "@/lib/model-metrics";
import { supportsFastMode } from "@/lib/pricing";
import { PROVIDERS } from "@/lib/providers";
import { PLANS, cheapestPlanWith } from "@/lib/plans";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useUploads } from "@/hooks/use-uploads";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { DictationSwap } from "@/components/ui/dictation-swap";
import { useApp } from "@/components/app/app-provider";
import { ACCEPT_ATTRIBUTE } from "@/lib/uploads";
import {
  COMPOSER_INLINE_SOFT_CHARS,
  COMPOSER_LONG_TEXT_CHARS,
  sampleLineCount,
} from "@/lib/prompt-limits";
import { duration } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { cachedJson, CachedJsonError } from "@/lib/client-cache";
import {
  artifactEditRequestFromQuote,
  serializeQuote,
  quoteLocationLabel,
  type ComposerQuote,
} from "@/lib/quote-context";
import type { ModelId } from "@/lib/models";
import { VOICE_ATTACHMENT_LIMIT } from "@/lib/voice-attachment-context";
import type {
  PendingPreflightClarification,
  PreflightClarificationAnswer,
  PreflightClarificationAnswerValue,
} from "@/lib/preflight-clarification";
import type { SendOptions, SendResult } from "@/hooks/use-chat";
import { readSkillInvocation, useChatSkills, YOURS_SOURCE_LABEL } from "@/components/chat/use-chat-skills";
import { ComposerSkillsPanel } from "@/components/skills/composer-skills-panel";
import { ComposerTray } from "@/components/chat/composer-tray";
import { ComposerMediaParams, useMediaParams } from "@/components/chat/composer-media-params";
import { MenuEmpty, MenuLabel, MenuSearch, MenuSkeleton } from "@/components/chat/composer-menu";
import { trustPermitsAutoSelection, type ClientWorkSkill } from "@/lib/work/skills";
import {
  MAX_CHAT_CONNECTORS,
  detectConnectorsFromPrompt,
  newlyDetectedConnectors,
} from "@/lib/connector-intent";
import type {
  ClientAttachment,
  GenerationStatus,
  ReasoningEffort,
} from "@/types/chat";
import { uiPref } from "@/lib/ui-prefs";

/**
 * The chat field's id, so a card in the transcript can put the cursor in it.
 *
 * Named rather than written out at the `<textarea>`, because the run components
 * the Work merge mounts inside this transcript were built against the /work
 * thread composer and reach for its field by id. A card that says "Reply below"
 * and focuses nothing is worse than one that says nothing at all, so the id is
 * an export a caller can hand to them.
 */
export const CHAT_COMPOSER_FIELD_ID = "juno-composer-textarea";

interface ComposerProps {
  initialResearch?: boolean;
  conversationId: string | null;
  model: ModelId;
  onModelChange: (m: ModelId) => void;
  onSend: (
    text: string,
    attachments: ClientAttachment[],
    options?: SendOptions,
  ) => Promise<SendResult> | SendResult | void;
  isBusy: boolean;
  status: GenerationStatus;
  onStop: () => void;
  /** An explicit destination choice; shown in both ordinary and steering mode. */
  modeControl?: React.ReactNode;
  /**
   * A durable run is going on this conversation, and this composer steers it.
   *
   * Two things arrive here: a deep-research run gathering, and a delegated task
   * working. Both used to carry their own text field and their own transport
   * controls — a second box and a second Stop a few hundred pixels above the
   * real ones, for the same conversation. The composer is where a person types
   * at a conversation, so while a run is live it is what direction goes into:
   * text becomes a constraint on the investigation, or an answer to the
   * question the task asked, rather than a queued message, and the primary
   * button's Stop face ends the run rather than only the stream.
   *
   * `active` is narrower than "a run exists": the caller sets it only while
   * typing at the run can still change what it does — a paused research run, a
   * run at the plan gate and a finished task all steer nothing. Absent or
   * inactive and every path below behaves exactly as it did.
   *
   * The two labels are the caller's because the verbs are not interchangeable.
   * "Add to the research" and "Answer the task's question" are different
   * promises, and a component that guessed between them would get it wrong on
   * exactly the surface where being wrong costs the reader their sentence.
   */
  steering?: {
    active: boolean;
    /**
     * The run is not this conversation's generation.
     *
     * A deep-research turn and the stream that narrates it are one turn from
     * the reader's side, so steering one is gated on `isBusy` — the field is
     * only taken over while the answer is arriving. A delegated task is not a
     * turn at all: it was dispatched minutes ago, nothing is streaming, and
     * `isBusy` is false for its entire life. Without this flag the composer
     * would offer a delegated run no way to be answered, which is precisely the
     * gap this exists to close.
     */
    standalone?: boolean;
    placeholder: string;
    /** What the primary action says while it sends into the run, not the chat. */
    sendLabel: string;
    /** What Stop ends — the run, not only a stream. */
    stopLabel: string;
    /** Anything the run needs said directly above the field, e.g. a steer queue. */
    above?: React.ReactNode;
    /** Resolves true when the server accepted it; the draft clears only then. */
    onSteer: (text: string) => Promise<boolean>;
  } | null;
  pendingClarification?: PendingPreflightClarification | null;
  onSubmitClarification?: (
    answers: PreflightClarificationAnswer[],
  ) => Promise<SendResult> | SendResult | void;
  onSkipClarification?: () => Promise<SendResult> | SendResult | void;
  onCancelClarification?: () => void;
  onOpenVoiceMode?: () => void;
  /**
   * A live voice call, drawn INTO the composer: its status on the left, its
   * controls on the right, End in the primary slot while nothing is typed
   * (components/voice/realtime-voice.tsx, `voiceCallParts`).
   */
  voiceCall?: VoiceCallParts;
  quotaReached?: boolean;
  /** Free's monthly allowance is spent, as opposed to a paid plan's limit. */
  freeAllowanceUsed?: boolean;
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
  /**
   * How the composer is framed by whatever holds it.
   *
   * `dock` (the default) is the chat surface's fixed bottom dock: it supplies
   * its own `.page-gutter`, centres itself on the reading measure, and reserves
   * the home-indicator inset underneath.
   *
   * `inline` is a composer sitting INSIDE a page column that has already been
   * measured and guttered — the project page's. There the dock's chrome is not
   * neutral, it is a second gutter: the field indented 16–32px further than the
   * section headings beneath it, on both edges, so nothing in the column shared
   * a left margin. A surface takes the page's gutter once (PREMIUM_AUDIT §2b),
   * and the column it is in has already taken it.
   *
   * `landing` is the empty chat's centred composer, which sits inside a column
   * that has already taken the page gutter. It is capped at the dock's measure
   * (the reading measure less one gutter each side) rather than guttered
   * again, so it is exactly as wide as the docked composer it turns into on
   * the first send, and it reserves no bottom inset: the starter chips follow
   * it directly.
   */
  frame?: "dock" | "landing" | "inline";
  privateMode?: boolean;
  /** Realtime voice is live: keep this surface focused on the turn being spoken. */
  voiceActive?: boolean;
  /** The live voice provider accepts image frames. Files ride with the turn as
   * resolved text either way, so this gates pictures alone. */
  voiceCanSeeImages?: boolean;
  /** Temporarily block edits/submission without turning the primary action into
   * the normal chat Stop button (voice image conversion/transcript saving). */
  sendLocked?: boolean;
  /**
   * One quiet line under the docked field: the "can make mistakes" notice, or
   * what is different about this chat (a fork, incognito). The caller owns the
   * words; the dock owns the slot. It is drawn INSIDE the dock's bottom inset
   * rather than under it, so it sits above the home indicator and the dock is
   * the same height with or without it. Ignored by the other frames.
   */
  footnote?: React.ReactNode;
  // The project this chat is filed under. For a brand-new chat (no conversation
  // yet) this is the project the next message will be created in.
  selectedProjectId?: string | null;
  onPickProject?: (projectId: string | null) => void;
  onDictatingChange?: (dictating: boolean) => void;
  /**
   * The @ lookup, injected only by the dev galleries (labelled fixtures, no
   * account); production searches GET /api/mentions.
   */
  loadMentions?: (query: string, signal: AbortSignal) => Promise<MentionSearchResult>;
}

// One palette serves both composer triggers: "/" (commands, e.g. "/model") and
// "@" (tools + connectors, e.g. "@notion"). Rows are grouped for rendering but
// stay ONE flat, ordered list so the keyboard cursor is a single index.
type PaletteGroup = "commands" | "skills" | "tools" | "navigate" | "connectors";

type SlashCommand = {
  id: string;
  /** Token typed after the trigger ("model" → "/model"); what the query filters on. */
  key: string;
  label: string;
  hint: string;
  group: PaletteGroup;
  /** Brand mark for connector rows; `icon` covers everything else. */
  connectorId?: string;
  icon?: IconComponent;
  /** Defined ⇒ the row is an on/off tool and renders its state. */
  on?: boolean;
  /**
   * Trailing note: why a row can't toggle right now ("not connected"), or
   * where a skill came from ("Yours", owner/repo). Drawn beside the "on"
   * tick, not instead of it, so an armed skill keeps its source label.
   */
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
  | null;

const GROUP_LABELS: Record<PaletteGroup, string> = {
  commands: "Commands",
  // Between the commands and the tools, because that is what a skill is from
  // here: something you type a slash and a name to reach, like /model, that
  // then changes how this one message is answered, like the tools below it.
  skills: "Skills",
  tools: "Tools",
  navigate: "Go to",
  connectors: "Connectors",
};

/** The composer's four states, on the shared primary action's faces. */
const PRIMARY_FACES = {
  checking: "busy",
  stop: "stop",
  send: "send",
  voice: "voice",
} as const satisfies Record<string, ComposerPrimaryFace>;
// Prefix match only, exactly as the slash list has always filtered — `match`
// widens connector rows without changing how commands behave.
const filterRows = (rows: SlashCommand[], query: string) =>
  query
    ? rows.filter(
        (row) =>
          row.key.startsWith(query) || (row.match?.includes(query) ?? false),
      )
    : rows;

// The slash palette's rows are the composer layer's rows (composer.css): the
// highlight is a fill that moves without animation (F0), and it marks the one
// row Enter picks. Hover tints only under a fine pointer.
const PALETTE_ROW_CLASS = "composer-layer__row cursor-pointer select-none";

/** Chunk the flat, pre-ordered rows into their groups while keeping each row's
 *  index in the FLAT list — that index is the keyboard cursor. */
function groupRows(items: SlashCommand[]) {
  const out: {
    group: PaletteGroup;
    rows: { item: SlashCommand; index: number }[];
  }[] = [];
  items.forEach((item, index) => {
    const last = out[out.length - 1];
    if (last?.group === item.group) last.rows.push({ item, index });
    else out.push({ group: item.group, rows: [{ item, index }] });
  });
  return out;
}

// aria-hidden: the enclosing role="group" already carries this label, so exposing
// it again would announce every section name twice.
function PaletteEyebrow({
  label,
  counter,
}: {
  label: string;
  counter?: string;
}) {
  return (
    <div aria-hidden className="composer-layer__label flex items-baseline justify-between gap-2">
      <span>{label}</span>
      {/* A count IS machine metadata, so it keeps tabular figures. */}
      {counter && <span className="font-mono tabular-nums">{counter}</span>}
    </div>
  );
}

/**
 * Uniform icon slot — a SLOT, not a plate.
 *
 * It was a 24px bordered tile with its own fill, on the argument that brand
 * marks need a surface to read on and a shared tile keeps the set's glyphs,
 * provider logos and connector marks on one baseline. The second half is the
 * real requirement and a fixed-size box delivers it on its own; the border and
 * the fill were the part that made ten rows read as ten plates, which is
 * exactly what the ⌘K palette dropped for the same reason.
 *
 * A 20px slot holding a 16px mark — the menu rung, the same size the `+` menu
 * one trigger to the left draws its glyphs at — so the glyph starts on 16 and
 * the label on 46, the grid the palette, the sidebar and every dropdown share.
 * The slot used to force every child to 18px with a descendant selector that
 * outranked the size written on the glyph itself, so a `size-3.5` here was
 * silently drawn at 18 and the two menus' marks never matched.
 */
function PaletteIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden">
      {children}
    </span>
  );
}

/**
 * The slash palette's floating shell (INTERACTION_SPEC C11): the composer
 * layer recipe on the shared material, portalled to the body at a fixed
 * position `placeComposerLayer` chose OUTSIDE the composer, below it on the
 * home and above it in the dock, so it never covers the draft or the row of
 * controls. Typing "/" opened it, so it appears and leaves in the same frame
 * (F0): no fade, no travel.
 */
function SlashLayer({ placement, children }: { placement: LayerPlacement | null; children: React.ReactNode }) {
  const [body, setBody] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => setBody(document.body), []);
  if (!body) return null;
  return createPortal(
    <div
      className="composer-layer composer-layer--palette surface-float"
      data-composer-layer=""
      data-side={placement?.side}
      onMouseDown={(event) => event.preventDefault()}
      style={
        placement
          ? {
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              ...(placement.side === "below" ? { top: placement.top } : { bottom: placement.bottom }),
            }
          : { visibility: "hidden", left: 0, top: 0 }
      }
    >
      {children}
    </div>,
    body,
  );
}

/**
 * One tool armed for the next message, as data — see the list that builds these
 * inside `Composer` for which states earn one and in what order.
 */
type ArmedMark = {
  id: string;
  /**
   * The glyph, carrying `size-4` ITSELF rather than inheriting a size from the
   * box around it.
   *
   * `icons.tsx` picks each glyph's optical cut from the size written on it
   * (the bold cut at 12px and under), so a mark sized only through a parent
   * selector is drawn without that decision being made. `ComposerArmedMark`'s
   * box keeps a `[&_svg]:size-4` floor so a caller that forgets cannot blow
   * the row out to 24px, but the class belongs on the glyph.
   */
  icon: React.ReactNode;
  label: string;
  /** A derived fact: research depth, or that an armed skill is not trusted. */
  detail?: string;
  /** What `detail` means, in a sentence, on the mark's tooltip. */
  tooltip?: React.ReactNode;
  /** Accessible name for the half that opens the menu this was armed from. */
  openLabel: string;
  /** Accessible name for the ✕. */
  removeLabel: string;
  remove: () => void;
};

function ComposerImpl({
  initialResearch = false,
  conversationId,
  model,
  onModelChange,
  onSend,
  isBusy,
  status,
  onStop,
  steering,
  modeControl,
  pendingClarification,
  onSubmitClarification,
  onSkipClarification,
  onCancelClarification,
  onOpenVoiceMode,
  voiceCall,
  quotaReached,
  freeAllowanceUsed,
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
  frame = "dock",
  privateMode = false,
  voiceActive = false,
  voiceCanSeeImages = true,
  sendLocked = false,
  footnote,
  selectedProjectId = null,
  onPickProject,
  onDictatingChange,
  loadMentions,
}: ComposerProps) {
  const { features, settings, setSettings, quota, models } = useApp();
  const dockFootnote = frame === "dock" ? footnote : undefined;
  const resolved = resolveModel(model);
  const isAuto = isAutoModelId(model);
  // Only the thinking tiers this specific model actually supports (real data).
  // Auto picks thinking server-side — no manual slider.
  const effortOptions = React.useMemo(
    () => (isAuto || !resolved ? [] : reasoningOptions(resolved)),
    [isAuto, resolved],
  );
  // Fast mode (premium speed) is only offered on the handful of models that
  // actually support it — see supportsFastMode(). The toggle hides otherwise.
  const canFastMode = React.useMemo(
    () => !isAuto && !!resolved && supportsFastMode(resolved),
    [isAuto, resolved],
  );
  // Pro execution is a separate axis from effort and exists on the GPT-5.6 line
  // only — see supportsProMode(). Same hide-when-unsupported rule as Flash.
  const canProMode = React.useMemo(
    () => !isAuto && !!resolved && supportsProMode(resolved),
    [isAuto, resolved],
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
    [onToggleProMode, onReasoningChange, reasoningEffort, resolved],
  );
  const modality = resolved?.modality ?? "chat";
  // An image, video or music model's choices (aspect, resolution, length,
  // sound, count, format), remembered per model: composer-media-params.tsx.
  const mediaParams = useMediaParams(model);

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
        if (!opts.some((o) => o.value === reasoningEffort))
          onReasoningChange(defaultReasoning(next));
      }
    },
    [onModelChange, onReasoningChange, reasoningEffort],
  );
  // Native web search (Gemini grounding, Claude/Grok tools) — gated by plan +
  // model capability; no third-party key required.
  const canWebSearch =
    !!onToggleWebSearch &&
    PLANS[quota.plan].webSearch &&
    modality === "chat" &&
    (resolved?.webSearch ?? false);
  // Voice mode never loads connectors (every fetch effect below bails on it), so
  // the "@" palette must not offer rows it has no data for either.
  const showConnectors =
    !!onToggleConnector && !privateMode && !voiceActive && modality === "chat";
  /*
   * ── The skill this message is sent under ──────────────────────────────────
   *
   * Per-send, exactly like deep research, and cleared on every successful send
   * below. A skill that stuck would keep shaping answers after the reader had
   * forgotten it was on, and the symptom — an answer that quietly followed
   * somebody else's method — is one nobody thinks to look for.
   *
   * A slug rather than the skill object: the library reloads, a skill can be
   * renamed or switched off between arming and sending, and the slug is what
   * the route resolves. Holding the row would mean holding a copy of a row that
   * may no longer be true.
   */
  const [skillSlug, setSkillSlug] = React.useState<string | null>(null);
  /*
   * The library is fetched only once somebody asks for it.
   *
   * This composer is mounted on every conversation in the product, so a read on
   * mount would put a request on the critical path of every chat for a control
   * most of them never open. `skillsWanted` flips when the "/" palette or the
   * add menu opens — or when a skill is already armed, because the pill has to
   * be able to name it after a reload.
   */
  const [skillsWanted, setSkillsWanted] = React.useState(false);
  // Deep research — per-send flag (resets after each send, unlike the sticky
  // web-search pref). Hidden entirely when the server has no Tavily key or in
  const [research, setResearch] = React.useState(initialResearch);
  // Research is a Pro-and-up feature (PLANS[plan].research). Below that the
  // row stays visible, because a missing feature reads as a missing product,
  // and choosing it says which plan has it and opens /upgrade instead of
  // arming a send the server would refuse.
  const router = useRouter();
  const planAllowsResearch = PLANS[quota.plan].research;
  const toggleResearch = React.useCallback(() => {
    if (!planAllowsResearch) {
      toast.message(`Deep research is included from ${PLANS[cheapestPlanWith("research")].name}.`);
      router.push("/upgrade");
      return;
    }
    setResearch((on) => !on);
  }, [planAllowsResearch, router]);
  // Depth is not a second decision: it follows the model and the thinking
  // effort already chosen on this row (see src/lib/research/auto-effort.ts).
  // The chip says what was derived, so a person who wants a deeper run knows
  // to pick a stronger model or turn thinking up.
  const researchEffort = React.useMemo<ResearchEffort>(
    () =>
      researchEffortFor({
        cost: isAuto ? null : (resolved?.cost ?? null),
        reasoningEffort: resolved ? clampReasoningEffort(resolved, reasoningEffort) : reasoningEffort,
        proMode,
      }),
    [isAuto, resolved, reasoningEffort, proMode]
  );
  const researchAvailable = !privateMode && modality === "chat";
  /*
   * ── Skills ────────────────────────────────────────────────────────────────
   *
   * Available in private mode, unlike research. A skill is the
   * reader's own stored instructions; nothing about applying one persists a row
   * or reaches a third party, which is the whole of what private mode withholds.
   * A voice turn is excluded because a skill's method is written to be read, and
   * an image model has no method to shape.
   */
  const skillsAvailable = !voiceActive && modality === "chat";
  // `loading` is deliberately not read: the flyout below distinguishes its
  // states on `skillLibrary === null` instead, which is also true for the frame
  // before the fetch this hook starts has begun — and that frame is the one a
  // `loading` flag gets wrong.
  const { skills: skillLibrary, failed: skillsFailed, reload: reloadSkills } =
    useChatSkills(skillsAvailable && (skillsWanted || skillSlug !== null));
  /**
   * The armed skill as a row, or null.
   *
   * Resolved against the library every render rather than stored, so a skill
   * switched off in another tab stops being armed here the moment the list
   * reloads — the pill cannot go on naming something the route would refuse.
   * `undefined` while the library is still in flight is deliberately treated as
   * "not yet known" rather than "gone": the slug still goes out, and the server
   * is the thing that decides.
   */
  const armedSkill: ClientWorkSkill | null =
    skillSlug === null ? null : (skillLibrary ?? []).find((entry) => entry.slug === skillSlug) ?? null;
  const skillArmed = skillsAvailable && skillSlug !== null;
  const sendOptions = React.useMemo<SendOptions | undefined>(
    () => {
      const armed = skillArmed && skillSlug ? { skillSlug } : null;
      if (modality !== "chat" && mediaParams.request) return { ...armed, mediaParams: mediaParams.request };
      if (research && researchAvailable) return { deepResearch: true, researchEffort, ...armed };
      return armed ?? undefined;
    },
    [modality, mediaParams.request, research, researchAvailable, researchEffort, skillArmed, skillSlug],
  );
  const outgoingOptions = React.useMemo<SendOptions | undefined>(
    () =>
      quote?.mode === "modify"
        ? { artifactEdit: artifactEditRequestFromQuote(quote) }
        : sendOptions,
    [quote, sendOptions],
  );
  // Research lives in the + menu now, so the trigger carries its armed state —
  // otherwise a per-send mode would be on with nothing on screen saying so.
  /**
   * Deep research is ARMED only while it is also available.
   *
   * This used to be `research && planAllowsResearch`, where the second operand
   * was a hard-coded `true` — a plan gate that had been flattened but left in,
   * along with a "paid plan" note and a Pro branch that no state could ever
   * reach. What the expression never checked was `researchAvailable`, so
   * switching to an image model (or into incognito) with research on left the
   * pill sitting on the row, armed, for a send that would silently drop the
   * flag.
   */
  const researchArmed = research && researchAvailable;

  const placeholder = pendingClarification
    ? "Or type your own answer…"
    : quote
      ? quote.mode === "modify"
        ? "Describe the change…"
        : quote.source === "document"
          ? quote.kind === "area"
            ? "Ask about this area…"
            : "Ask about this passage…"
          : "Ask about this selection…"
      : (customPlaceholder ??
        (modality === "image"
          ? "Describe an image to generate…"
          : modality === "video"
            ? "Describe a video to generate…"
            : modality === "audio"
              ? "Describe a song or a sound to generate…"
              : // An invitation, not a syntax lesson: @ and / are taught by
              // the + menu and the palette (gallery revision 2). The first
              // message is asked for; after it, the next one follows up.
              frame === "dock"
              ? "Ask a follow-up"
              : "How can I help you today?"));
  const [text, setText] = React.useState("");

  // Huge pastes stay in `text` for send, but we collapse the textarea DOM so
  // multi-10k curricula don't freeze / blank the tab. Expand to edit inline.
  const [draftExpanded, setDraftExpanded] = React.useState(false);
  // The user's raw draft as it was when a send got intercepted by a
  // clarification — restored on cancel (originalUserMessage may be the
  // serialized quote block, which must not go back into the textarea).
  const interceptedDraftRef = React.useRef("");
  const [clarificationAnswers, setClarificationAnswers] = React.useState<
    PreflightClarificationAnswer[]
  >([]);
  const [plusOpen, setPlusOpen] = React.useState(false);
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  const [projects, setProjects] = React.useState<
    { id: string; name: string; conversationCount: number }[]
  >([]);
  const [loadingProjects, setLoadingProjects] = React.useState(false);
  // The whole account list, not just the linked apps: "@notion" on an unlinked
  // Notion must be able to say so instead of matching nothing. `configured`
  // gates out apps this deployment has no OAuth credentials for — those can
  // never be connected, so offering them would be a dead end.
  const [allConnectors, setAllConnectors] = React.useState<
    { id: string; label: string; connected: boolean; configured?: boolean }[]
  >([]);
  const connectors = React.useMemo(
    () => allConnectors.filter((c) => c.connected),
    [allConnectors],
  );
  const [connectorsLoading, setConnectorsLoading] = React.useState(false);
  /**
   * Whether the last connector fetch failed.
   *
   * Without this the catch below was an empty block, so a failed request left
   * `connectors` empty and the flyout rendered "Connect an app" — the exact
   * same thing it renders for an account that genuinely has none. A network
   * failure told the user they had connected nothing, which for anyone who had
   * is simply false.
   */
  const [connectorsFailed, setConnectorsFailed] = React.useState(false);
  const [connectorQuery, setConnectorQuery] = React.useState("");
  const enabledConnectorIdsRef = React.useRef(connectorsEnabled);
  enabledConnectorIdsRef.current = connectorsEnabled;
  const textareaRef = React.useRef<ContextFieldElement>(null);
  const [contextTokens, setContextTokens] = React.useState<ContextToken[]>([]);
  /*
   * ── The field tier's bookkeeping ──────────────────────────────────────────
   *
   * `leadWidth` is how wide the marks drawn over the start of the field are
   * (a skill, Deep Field: what this one message runs as); it becomes the
   * field's `text-indent`, so the first word lands after them. Measured, never
   * assumed: a mark holds a skill's name.
   *
   * `leadRef` is written to directly while the draft scrolls, because doing it
   * through state would re-render this component on every frame of a scroll.
   */
  const [leadWidth, setLeadWidth] = React.useState(0);
  const leadRef = React.useRef<HTMLSpanElement>(null);
  const onFieldScroll = React.useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    if (leadRef.current) leadRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`;
  }, []);
  const rootRef = React.useRef<HTMLDivElement>(null);
  /** The composer surface: every layer it opens is placed outside this box. */
  const shellRef = React.useRef<HTMLDivElement>(null);
  /*
   * Focus from the keyboard draws one ring in the presence ink around the
   * whole composer; focus from a pointer only darkens its edge (C1). A text
   * field matches :focus-visible on every focus, so the composer remembers
   * whether a pointer pressed it just before.
   */
  const pointerFocus = React.useRef(false);
  const [keyboardFocus, setKeyboardFocus] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  /** Which side of the composer its layers open toward: below on the home, above in the dock. */
  const layerSide = preferredLayerSide(frame);
  /** The side a layer is open on right now (the home moves its suggestions aside for one below). */
  const [fieldLayer, setFieldLayer] = React.useState<LayerSide | null>(null);

  /*
   * ── The unsent draft, kept while the composer is not mounted (C21) ────────
   *
   * One per chat (the home's under "new"), with its tokens, so moving between
   * chats, a remount or a reload never loses what was being written. Saved
   * `draftSave` after the last change and once more on the way out; a send
   * forgets it at once, so a sent message never comes back as a draft. Never
   * in incognito, and not while the field is steering a run.
   */
  const draftKey = privateMode || steering?.active ? null : (conversationId ?? "new");
  const latestDraft = React.useRef({ text: "", tokens: [] as ContextToken[] });
  latestDraft.current = { text, tokens: contextTokens };
  React.useEffect(() => {
    if (!draftKey) return;
    const stored = readComposerDraft(draftKey);
    const field = textareaRef.current;
    if (stored && field && !field.getDraft().text) field.setDraft(stored);
  }, [draftKey]);
  React.useEffect(() => {
    if (!draftKey) return;
    const timer = window.setTimeout(() => writeComposerDraft(draftKey, latestDraft.current), TIMING.draftSave);
    return () => window.clearTimeout(timer);
  }, [draftKey, text, contextTokens]);
  React.useEffect(() => {
    if (!draftKey) return;
    return () => writeComposerDraft(draftKey, latestDraft.current);
  }, [draftKey]);
  /** A send that went: the draft it carried is not kept for later. */
  const forgetDraft = React.useCallback(() => {
    if (draftKey) forgetStoredDraft(draftKey);
    latestDraft.current = { text: "", tokens: [] };
  }, [draftKey]);
  const {
    uploads,
    addFiles,
    addAttachments,
    remove,
    clear,
    readyAttachments,
    isUploading,
  } = useUploads(privateMode ? null : conversationId);
  // Memoized: a fresh `[]` every private-mode render would churn every hook
  // that lists sendAttachments as a dependency.
  const sendAttachments = React.useMemo(
    () => (privateMode ? [] : readyAttachments),
    [privateMode, readyAttachments],
  );
  const uploading = privateMode ? false : isUploading;
  /* Whether the files on the row can actually be read — polled until indexing
     settles, so "Juno could not read this PDF" arrives before the send rather
     than inside the reply to it. */

  const addComposerFiles = React.useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      // A document reaches the model as resolved text, which every provider
      // can receive. Only a picture needs a provider that can see — so that
      // is the only thing a sightless provider takes away.
      const matching =
        voiceActive && !voiceCanSeeImages
          ? list.filter((file) => !file.type.startsWith("image/"))
          : list;
      if (voiceActive && matching.length !== list.length)
        toast.error("This voice provider can’t view images. Files still work.");
      const remaining = voiceActive
        ? Math.max(0, VOICE_ATTACHMENT_LIMIT - uploads.length)
        : matching.length;
      const allowed = matching.slice(0, remaining);
      if (voiceActive && matching.length > remaining) {
        toast.error(
          `Voice mode accepts up to ${VOICE_ATTACHMENT_LIMIT} attachments in one turn.`,
        );
      }
      if (allowed.length > 0) addFiles(allowed);
    },
    [addFiles, uploads.length, voiceActive, voiceCanSeeImages],
  );

  // Sketch (components/chat/sketch): a drawing that lands on the row as an
  // ordinary image upload, and reopens from its tile to keep drawing.
  const sketch = useComposerSketch({
    addFiles: addComposerFiles,
    removeUpload: remove,
    imageModel: modality === "image",
  });

  /*
   * Files dropped on the composer, through the Library's depth-counted hook
   * (library-drop-zone.tsx). The boolean this replaced was set on dragover and
   * cleared on every dragleave, and dragleave fires each time the pointer
   * crosses into one of the composer's own children, so "Drop to attach"
   * blinked at every chip and button edge. It also lit up for a dragged link
   * or a text selection; the hook only answers a drag that carries files.
   * Private mode and a deployment without storage refuse drops, the same two
   * rules a paste and a file handed over by another surface keep.
   */
  const { dragging, handlers: fileDropHandlers } = useFileDrop({
    onFiles: addComposerFiles,
    enabled: features.storage && !privateMode,
  });

  // Screen capture, resolved after mount so the server render and the first
  // paint agree on whether the row exists. iOS Safari and most mobile browsers
  // have no getDisplayMedia at all, and it needs a secure context.
  const [canScreenshot, setCanScreenshot] = React.useState(false);
  React.useEffect(() => {
    setCanScreenshot(typeof navigator.mediaDevices?.getDisplayMedia === "function");
  }, []);

  // getDisplayMedia → hidden <video> → <canvas>.drawImage, the same path
  // use-realtime-voice.ts already proves in production. Not ImageCapture
  // .grabFrame(): Safari does not have it.
  const captureScreenshot = React.useCallback(async () => {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const frame = document.createElement("canvas");
      frame.width = video.videoWidth;
      frame.height = video.videoHeight;
      frame.getContext("2d")?.drawImage(video, 0, 0);
      video.pause();
      video.srcObject = null;
      const blob = await new Promise<Blob | null>((resolve) => frame.toBlob(resolve, "image/png"));
      if (!blob) return;
      // sanitizeFileName (lib/uploads.ts) strips ":", so keep the stamp
      // dash-only or every screenshot lands as "Screenshot 2026-09-12T14_31_08".
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      addComposerFiles([new File([blob], `Screenshot ${stamp}.png`, { type: "image/png" })]);
    } catch (error) {
      // Cancelling the OS picker is a decision, not a failure.
      if ((error as DOMException)?.name !== "NotAllowedError")
        toast.error("Couldn’t capture the screen.");
    } finally {
      // A leaked capture track leaves a permanent "sharing your screen"
      // indicator on the tab — the worst failure this row could have.
      for (const track of stream?.getTracks() ?? []) track.stop();
    }
  }, [addComposerFiles]);
  const addComposerAttachments = React.useCallback(
    (attachments: ClientAttachment[]) => {
      const matching =
        voiceActive && !voiceCanSeeImages
          ? attachments.filter((attachment) => attachment.kind !== "IMAGE")
          : attachments;
      if (voiceActive && matching.length !== attachments.length)
        toast.error("This voice provider can’t view images. Files still work.");
      const remaining = voiceActive
        ? Math.max(0, VOICE_ATTACHMENT_LIMIT - uploads.length)
        : matching.length;
      const allowed = matching.slice(0, remaining);
      if (voiceActive && matching.length > remaining) {
        toast.error(
          `Voice mode accepts up to ${VOICE_ATTACHMENT_LIMIT} attachments in one turn.`,
        );
      }
      if (allowed.length > 0) addAttachments(allowed);
    },
    [addAttachments, uploads.length, voiceActive, voiceCanSeeImages],
  );

  // Enforce the per-chat connector limit even for conversations saved by an
  // older client that may contain duplicate or excess connector IDs.
  React.useEffect(() => {
    if (voiceActive || !onToggleConnector) return;
    const excess = Array.from(new Set(connectorsEnabled)).slice(
      MAX_CHAT_CONNECTORS,
    );
    excess.forEach((id) => onToggleConnector(id));
  }, [connectorsEnabled, onToggleConnector, voiceActive]);

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
    [onDictatingChange],
  );

  // Quote chip exit: play pop-out before the quote leaves state.
  const [quoteRemoving, setQuoteRemoving] = React.useState(false);
  // The timer is held so it can be cancelled. It was a bare `setTimeout`, so
  // dismissing a quote and then navigating away fired a state update and a
  // parent callback on an unmounted component — and the delay was the literal
  // `120`, the value of `--dur-fast`, copied out of the scale it should read.
  const quoteExitTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (quoteExitTimer.current !== null) window.clearTimeout(quoteExitTimer.current);
    },
    [],
  );
  const dismissQuote = React.useCallback(() => {
    if (!onClearQuote) return;
    setQuoteRemoving(true);
    if (quoteExitTimer.current !== null) window.clearTimeout(quoteExitTimer.current);
    quoteExitTimer.current = window.setTimeout(() => {
      quoteExitTimer.current = null;
      setQuoteRemoving(false);
      onClearQuote();
    }, duration.fast * 1000);
  }, [onClearQuote]);

  // A fresh selection lands the user straight in the textarea, ready to type.
  React.useEffect(() => {
    if (!quote) return;
    setQuoteRemoving(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [quote]);

  // Empty-state suggestions seed the real composer rather than navigating to a
  // fake flow or auto-sending a side effect. The event keeps the greeting
  // independent from the composer's sizeable transport contract.
  React.useEffect(() => {
    const seed = (event: Event) => {
      const value =
        event instanceof CustomEvent && typeof event.detail === "string"
          ? event.detail
          : "";
      if (!value) return;
      setText(value);
      requestAnimationFrame(() => {
        const field = textareaRef.current;
        field?.focus();
        field?.setSelectionRange(value.length, value.length);
      });
    };
    window.addEventListener("juno:composer-seed", seed);
    return () => window.removeEventListener("juno:composer-seed", seed);
  }, []);

  // A home suggestion that names a thing ("Use GitHub") puts it in the
  // sentence as a token, after whatever is already written, and hands the
  // caret back. Through the field's draft, so the token keeps its data.
  React.useEffect(() => {
    const insert = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as { token?: ContextToken; item?: MentionItem }) : undefined;
      const field = textareaRef.current;
      if (!field || !detail?.token) return;
      if (detail.item) rememberContextItem(detail.item);
      const current = field.getDraft();
      const lead = current.text.trimEnd() ? `${current.text.trimEnd()} ` : "";
      const label = detail.token.label;
      field.setDraft(
        {
          text: `${lead}${label} `,
          tokens: [...tokensForText(lead, current.tokens), { ...detail.token, range: { start: lead.length, end: lead.length + label.length } }],
        },
        { focus: true },
      );
    };
    window.addEventListener("juno:composer-insert-token", insert);
    return () => window.removeEventListener("juno:composer-insert-token", insert);
  }, []);

  // "Message" on an agent's profile: the one invitation there is to talk.
  React.useEffect(() => {
    const focus = () => requestAnimationFrame(() => textareaRef.current?.focus());
    window.addEventListener("juno:composer-focus", focus);
    return () => window.removeEventListener("juno:composer-focus", focus);
  }, []);

  // Files handed over by another surface — the document viewer's "ask about
  // this area" crop. Through the same door a drop or a paste uses, so the
  // private-mode, voice and storage rules apply to it unchanged.
  React.useEffect(() => {
    const add = (event: Event) => {
      const files = event instanceof CustomEvent && Array.isArray(event.detail) ? (event.detail as unknown[]) : [];
      const list = files.filter((f): f is File => f instanceof File);
      if (!list.length) return;
      if (privateMode || !features.storage) {
        toast.error("Files can’t be attached here.");
        return;
      }
      addComposerFiles(list);
    };
    window.addEventListener("juno:composer-add-files", add);
    return () => window.removeEventListener("juno:composer-add-files", add);
  }, [addComposerFiles, features.storage, privateMode]);

  // The pre-flight check and a hard send lock disable the textarea, which
  // silently drops keyboard focus to <body>. Hand it back the moment the
  // composer re-enables so Enter-to-send flows straight into typing the
  // follow-up — but never steal focus from a field the user moved to in
  // the meantime (only reclaim it from <body> or from within the composer).
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
      if (
        !active ||
        active === document.body ||
        rootRef.current?.contains(active)
      )
        el.focus();
    });
  }, [isBusy, status, dictating, pendingClarification]);

  // Esc stops a running generation from anywhere on the page. The field is
  // disabled while busy, so this cannot live in its own onKeyDown; it defers
  // to any nearer layer (a menu, the find bar) that already claimed the key.
  React.useEffect(() => {
    if (!isBusy || status === "checking" || status === "stopping") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]')) return;
      e.preventDefault();
      onStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isBusy, status, onStop]);

  // One line at rest, eight before it scrolls, on the composer spring. A
  // clarification keeps the free-text path short (three lines); a huge paste
  // that has been expanded to edit gets a taller window so it can be read.
  const autoresize = useComposerAutosize(textareaRef, text, {
    maxLines: pendingClarification ? 3 : 8,
    maxHeight: text.length > COMPOSER_INLINE_SOFT_CHARS ? 448 : undefined,
    minHeight: text.length > COMPOSER_INLINE_SOFT_CHARS ? 120 : 0,
  });

  React.useEffect(() => {
    // The drop overlay clears itself: `useFileDrop` resets when private mode
    // switches it off mid-drag.
    if (privateMode) clear();
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
   * Steering mode: a run is going, and typing has somewhere to go.
   *
   * A deep-research run is gated on `isBusy` as well as on the caller's flag,
   * because that run and the generation narrating it are the same turn from the
   * reader's side and the field is only taken over while the answer is
   * arriving. That argument holds for research and only for research: a
   * delegated task was dispatched minutes ago, nothing is streaming, and
   * `isBusy` is false for its whole life — so a caller whose run is not this
   * conversation's generation says `standalone` and is taken at its word. See
   * the prop.
   *
   * A clarification owns the composer outright while it is up, so it wins over
   * steering either way — answering the question is the only thing that moves
   * anything forward.
   */
  const steerMode =
    !!steering?.active &&
    (isBusy || steering.standalone === true) &&
    status !== "checking" &&
    !pendingClarification;
  /**
   * A run that is going while nothing is streaming.
   *
   * This is what makes Stop mean the run rather than the generation: with a
   * delegated task there IS no generation, so `isBusy` is false and the primary
   * action would otherwise sit on its send face over an empty field, offering
   * the one verb that does nothing. The caller's `onStop` cancels the run.
   */
  const standaloneRun = !!steering?.active && steering.standalone === true;
  const controlsLocked = isBusy || sendLocked || uploading || !!quotaReached;
  /**
   * What the "+" menu is locked by, which is much less than the send button is.
   *
   * The menu used to take `controlsLocked` wholesale, so while a file was
   * uploading you could not open the menu to attach ANOTHER file, and while an
   * answer streamed you could not pick a project or turn Memory on. None of
   * those touch the request in flight — they apply to the next send. The two
   * that genuinely cannot proceed are a hard send lock and a spent quota,
   * because there is no next send to configure.
   */
  const plusLocked = sendLocked || !!quotaReached;
  /**
   * What blocks a SEND, as opposed to what dims the row. A generation in
   * flight is not on this list any more: the field stays live while a reply
   * streams, because typing the next message during the answer is the most
   * ordinary thing a person does in a chat, and Enter hands the draft to
   * the chat hook, which queues it for the moment the reply ends — or
   * refuses it, in which case the draft simply stays where it was.
   */
  const sendBlocked = sendLocked || uploading || !!quotaReached;
  const canSend = steerMode
    ? // No attachments and no clarification answers: direction is words, and a
      // file cannot be handed to a run that is already reading.
      text.trim().length > 0 && !sendLocked && !quotaReached
    : (text.trim().length > 0 ||
        sendAttachments.length > 0 ||
        clarificationAnswers.length > 0) &&
      !sendBlocked;

  /*
   * VOICE IS BACK IN THE SEND SLOT, under one condition: there is nothing to
   * send.
   *
   * It sat there once and was moved out to a ghost button beside the mic,
   * because it took over the ACCENT circle on an empty field — so the one
   * saturated control on the row meant "call" until you typed and "send"
   * afterwards, and people pressed it by accident. That objection was about the
   * COLOUR, not the position, and the move answered it by giving up the
   * position too. What it left behind is a disabled grey disc with an arrow in
   * it, on the most prominent control on the page, in the state the composer is
   * in every time it opens: a dead button as the default.
   *
   * So the slot is live again and the colour does the work. `voice` draws in
   * the quiet secondary disc — the fill the dead button already wore — and only
   * send, stop and busy wear the accent (`ComposerPrimaryAction`). The accent
   * still means exactly one verb, so the misfire cannot return, and the first
   * keystroke morphs the quiet disc into the accent one.
   *
   * NOT IN STEER MODE. Steering a research run is words handed to something
   * already reading; a call is not one of the things you can do to it, and
   * putting one in the slot there would offer an action that has no meaning on
   * that surface.
   */
  const voiceAvailable = !!onOpenVoiceMode && !steerMode && !dictating && !sendLocked;

  // The primary button's faces: checking, stop (when busy), voice (when there
  // is nothing to send and a call is available), or send.
  const primaryFace: "checking" | "stop" | "send" | "voice" =
    status === "checking"
      ? "checking"
      : steerMode && text.trim().length > 0
        ? "send"
        : isBusy || standaloneRun
          ? "stop"
          : canSend || !voiceAvailable
            ? "send"
            : "voice";
  // The effort control the model popover draws under its panes. Absent when
  // Auto picks the depth or the model has a single tier, so the footer only
  // appears when there is a choice to make — which also retires the empty
  // popover a single-tier model used to open.
  const thinkingControl =
    isAuto || !resolved || effortOptions.length < 2 ? null : (
      <ReasoningSlider
        variant="panel"
        defaultValue={defaultReasoning(resolved)}
        options={effortOptions}
        // Clamped as the chip's label is, so the slider and the chip name the
        // same rung (an unclamped value missing from the options read as the first).
        value={clampReasoningEffort(resolved, reasoningEffort)}
        onChange={onReasoningChange}
        disabled={controlsLocked}
        fastMode={fastMode}
        onFastModeChange={
          canFastMode && onToggleFastMode ? onToggleFastMode : undefined
        }
        proMode={proMode}
        onProModeChange={
          canProMode && onToggleProMode ? toggleProMode : undefined
        }
      />
    );

  // Never split() multi-MB drafts just to count lines — sample the head only.
  const longText =
    text.trim().length > COMPOSER_LONG_TEXT_CHARS || sampleLineCount(text) > 30;
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

      // The connection list is loaded on mount by the refresh effect below.
      // This used to fetch it here on a cold composer, which put a network
      // round-trip BEFORE `onSend` and before any busy state — on a slow API
      // the send button simply looked dead for a second or two. Nothing
      // network-bound may sit between Enter and the request going out.
      const available = connectors.map((c) => ({ id: c.id, label: c.label }));
      if (available.length === 0) return connectorsEnabled;

      const merged = detectConnectorsFromPrompt(
        prompt,
        available,
        connectorsEnabled,
      );
      const fresh = newlyDetectedConnectors(
        prompt,
        available,
        connectorsEnabled,
      );
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
        if (labels.length === 1)
          toast.message(`Enabled ${labels[0]} for this chat`);
        else if (labels.length > 1)
          toast.message(`Enabled ${labels.join(", ")} for this chat`);
      }
      return merged.length > 0 ? merged : connectorsEnabled;
    },
    [
      connectors,
      connectorsEnabled,
      onEnableConnectors,
      onToggleConnector,
      privateMode,
    ],
  );

  const submit = async (overrideText?: string) => {
    const draft = overrideText !== undefined ? overrideText : text;
    const trimmedDraft = draft.trim();
    if (
      !trimmedDraft &&
      sendAttachments.length === 0 &&
      clarificationAnswers.length === 0
    )
      return;
    if (sendBlocked) return;
    try {
      // Direction into the live run, not a message into the thread. First,
      // because every path below this builds an outgoing chat turn.
      if (steerMode && steering) {
        if (!trimmedDraft) return;
        const accepted = await steering.onSteer(trimmedDraft);
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
      /*
       * `/slug …` typed straight into the draft.
       *
       * Converted HERE, in the client, into an armed skill plus the request
       * that follows it — which is what lets the route take an explicit
       * `skillSlug` and never parse a message for a leading slash (see
       * `chatBodySchema.skillSlug`). It only ever fires for a slug that names a
       * real skill on this account, so `/Users/liam/Downloads is a mess` and
       * `/usr/local` stay the sentences they are.
       *
       * The token itself does not go to the model: it is addressed to Juno, and
       * a message beginning with a command the model was never given is one it
       * has to decide what to do with. A bare `/slug` with nothing after it is
       * not a message at all — it arms the pill and leaves the cursor where it
       * was, which is the same thing picking the row out of the palette does.
       */
      const typedSkill = skillsAvailable ? readSkillInvocation(trimmedDraft, skillLibrary) : null;
      if (typedSkill && !typedSkill.remainder) {
        setSkillSlug(typedSkill.skill.slug);
        setText("");
        setDraftExpanded(false);
        requestAnimationFrame(autoresize);
        return;
      }
      const draftForSend = typedSkill ? typedSkill.remainder : trimmedDraft;
      if (typedSkill) setSkillSlug(typedSkill.skill.slug);
      // State set this tick is not readable this tick, so the send carries the
      // slug explicitly rather than through the memo above.
      const skillForSend = typedSkill ? typedSkill.skill.slug : skillArmed ? skillSlug : null;

      interceptedDraftRef.current = draftForSend;
      const outgoing = quote
        ? serializeQuote(quote, draftForSend)
        : draftForSend;
      const connectorsForSend = await resolveSendConnectors(outgoing);
      const result = await onSend(outgoing, sendAttachments, {
        ...outgoingOptions,
        // A canvas modify drops `outgoingOptions` wholesale — it is its own
        // output protocol and a skill would be a third one — so the skill is
        // spread only where the rest of the per-send options survive.
        ...(quote?.mode === "modify" || !skillForSend ? null : { skillSlug: skillForSend }),
        ...(connectorsForSend ? { connectors: connectorsForSend } : null),
        // Ranges are sent against the words that go. A typed "/skill" sends
        // only what follows it, so its tokens move back by the head it lost
        // (or the request schema would refuse the turn as label_mismatch).
        ...(contextTokens.length && !quote
          ? {
              context: typedSkill
                ? rangesForStoredText(draftForSend, tokensForRemainder(draft, draftForSend, contextTokens))
                : rangesForStoredText(draft, tokensForText(draft, contextTokens)),
            }
          : null),
      });
      if (result && result.accepted === false) return;
      forgetDraft();
      setText("");
      setDraftExpanded(false);
      setResearch(false); // per-send: research never sticks to the next message
      setSkillSlug(null); // per-send, for the same reason research is
      clear();
      onClearQuote?.();
      requestAnimationFrame(autoresize);
    } catch (err) {
      // Never let a large-paste / network failure navigate the SPA away.
      console.error("[composer] send failed", err);
      toast.error(
        err instanceof Error
          ? err.message
          : "Couldn’t send that message. Try again.",
      );
    }
  };

  // Dictate Mode hand-off: Stop lands the transcript in the textarea for
  // editing; Send merges + submits through the exact same path as typing.
  const closeDictation = React.useCallback(
    (transcript: string, sendNow: boolean) => {
      setDictating(false);
      // The words land after the draft, which keeps its start, so every token
      // already in it stays on its words (context-draft.ts, `appendToDraft`).
      const draft = appendToDraft({ text, tokens: contextTokens }, transcript);
      const merged = draft.text;
      const restore = () => {
        const field = textareaRef.current;
        if (field) field.setDraft(draft, { focus: true });
        else setText(merged);
      };
      if (!sendNow || !merged || controlsLocked) {
        restore();
        requestAnimationFrame(autoresize);
        return;
      }
      interceptedDraftRef.current = merged;
      const outgoing = quote ? serializeQuote(quote, merged) : merged;
      void (async () => {
        const connectorsForSend = await resolveSendConnectors(outgoing);
        const result = await onSend(outgoing, sendAttachments, {
          ...outgoingOptions,
          ...(connectorsForSend ? { connectors: connectorsForSend } : null),
          ...(draft.tokens.length && !quote ? { context: rangesForStoredText(merged, draft.tokens) } : null),
        });
        if (result && result.accepted === false) {
          restore(); // keep the words and their tokens: nothing is lost on a refusal
          return;
        }
        forgetDraft();
        setText("");
        setResearch(false); // per-send: research never sticks to the next message
        setSkillSlug(null);
        clear();
        onClearQuote?.();
        requestAnimationFrame(autoresize);
      })();
    },
    [
      text,
      contextTokens,
      controlsLocked,
      quote,
      onSend,
      sendAttachments,
      outgoingOptions,
      clear,
      onClearQuote,
      autoresize,
      setDictating,
      resolveSendConnectors,
      forgetDraft,
    ],
  );

  // ——— Composer palette: "/" for commands, "@" for tools + connectors ———

  const toggleMemory = React.useCallback(
    (v: boolean) => {
      setSettings({ memoryEnabled: v });
      fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryEnabled: v }),
      }).catch(() => {});
    },
    [setSettings],
  );

  // The per-chat cap is a rule about connectors, not about one menu — the +
  // submenu and the "@" palette both go through here so they can't drift.
  const pickConnector = React.useCallback(
    (id: string) => {
      if (!onToggleConnector) return;
      const selected = connectorsEnabled.includes(id);
      if (!selected && new Set(connectorsEnabled).size >= MAX_CHAT_CONNECTORS) {
        toast.error(
          `You can use up to ${MAX_CHAT_CONNECTORS} connectors at once. Turn one off before adding another.`,
        );
        return;
      }
      onToggleConnector(id);
    },
    [connectorsEnabled, onToggleConnector],
  );

  // Group order is also the keyboard order, so "commands" stays first: "/" then
  // Enter has always landed on /model and should keep doing so.
  const commands = React.useMemo<SlashCommand[]>(
    () => [
      {
        id: "model",
        key: "model",
        label: "/model",
        hint: "Switch the AI model",
        group: "commands",
        icon: SettingsIcons.models,
      },
      {
        id: "artifact",
        key: "artifact",
        label: "/artifact",
        hint: "Ask for an artifact",
        group: "commands",
        icon: ComposerIcons.canvas,
      },
      ...(features.storage && !privateMode
        ? [
            {
              id: "sketch",
              key: "sketch",
              label: "/sketch",
              hint: "Draw a sketch to attach",
              group: "commands" as const,
              icon: Pencil,
              run: sketch.openSketch,
            },
          ]
        : []),
      ...(onOpenVoiceMode
        ? [
            {
              id: "voice",
              key: "voice",
              label: "/voice",
              hint: "Start voice mode",
              group: "commands" as const,
              icon: AudioLines,
              run: onOpenVoiceMode,
            },
          ]
        : []),
      {
        id: "new",
        key: "new",
        label: "/new",
        hint: "Start a new chat",
        group: "commands",
        // The same mark the sidebar's New chat row and ⌘K's draw
        // (`AppIcons.new`) — it was a third drawing of one action here.
        icon: AppIcons.new,
        run: () => {
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
          router.push("/chat");
        },
      },
      /*
       * One row per skill, typed the way it is stored.
       *
       * Right after the commands and before the tools: `/model` and
       * `/tidy-inbox` are the same gesture, and a skill is a tool for this one
       * message in the way `/search` is. Picking one ARMS it rather than
       * sending — the reader still has a request to type — which is the same
       * thing the typed `/slug` form does at submit.
       *
       * `match` carries the name as well as the slug, because a skill called
       * "File the invoices" is stored as `file-the-invoices` and somebody
       * hunting for it types "invoice", which shares no prefix with the slug.
       * An untrusted skill is listed like any other: trust gates whether Juno
       * may REACH for a skill unasked, and this is the reader naming one.
       *
       * The library arrives yours-first and then one repository at a time
       * (`chatSkillsFromLibrary`), so an unfiltered "/" already lists them by
       * source; the trailing note names it ("Yours", or owner/repo). The armed
       * row keeps its note and adds the tick beside it: the armed row is the
       * one the reader comes back to check, and it used to lose the only line
       * saying which repository it came from at exactly that moment. The
       * repository also joins `match`, so "/anthropics" finds its skills.
       */
      ...(skillsAvailable
        ? (skillLibrary ?? []).map((entry) => ({
            id: `skill:${entry.slug}`,
            key: entry.slug,
            label: `/${entry.slug}`,
            hint: entry.description || entry.name,
            group: "skills" as const,
            icon: AppIcons.skills,
            on: skillSlug === entry.slug,
            note: entry.yours ? YOURS_SOURCE_LABEL : (entry.sourceLabel ?? undefined),
            match: `${entry.name.toLowerCase()} ${entry.description.toLowerCase()} ${(entry.sourceLabel ?? "").toLowerCase()}`,
            run: () => setSkillSlug((current) => (current === entry.slug ? null : entry.slug)),
          }))
        : []),
      {
        id: "search",
        key: "search",
        label: "/search",
        hint: `Let ${PRODUCT_NAME} search the web`,
        group: "tools",
        icon: ComposerIcons.web,
        on: webSearchEnabled,
        run: () => onToggleWebSearch?.(!webSearchEnabled),
      },
      ...(researchAvailable
        ? [
            {
              id: "research",
              key: "research",
              label: "/research",
              hint: "Deep-research the next message",
              group: "tools" as const,
              icon: ComposerIcons.research,
              on: research,
              run: toggleResearch,
            },
          ]
        : []),
      {
        id: "projects",
        key: "projects",
        label: "/projects",
        hint: "Open your projects",
        group: "navigate",
        icon: AppIcons.projects,
        run: () => router.push("/projects"),
      },
      {
        id: "library",
        key: "library",
        label: "/library",
        hint: "Open your library",
        group: "navigate",
        icon: AppIcons.library,
        run: () => router.push("/library"),
      },
      {
        id: "memory",
        key: "memory",
        label: "/memory",
        hint: "Open memory",
        group: "navigate",
        icon: ComposerIcons.memory,
        run: () => router.push("/memory"),
      },
    ],
    [
      features.storage,
      privateMode,
      sketch.openSketch,
      webSearchEnabled,
      onToggleWebSearch,
      researchAvailable,
      research,
      toggleResearch,
      onOpenVoiceMode,
      router,
      skillsAvailable,
      skillLibrary,
      skillSlug,
    ],
  );

  // "/" is anchored at the start of the draft and closes on any character a
  // command cannot contain (a space is how you type a literal "/"). "@" is the
  // context field's own palette (context-composer-field.tsx): it names a
  // thing in the sentence, and tools live in "/" and the + menu.
  const slash = React.useMemo((): SlashState => {
    if (text.startsWith("/")) {
      const modelMatch = text.match(/^\/model(?:\s+(.*))?$/i);
      if (modelMatch) {
        const q = (modelMatch[1] ?? "").toLowerCase().trim();
        const items = models
          .filter(
            (m) =>
              !q ||
              m.name.toLowerCase().includes(q) ||
              (PROVIDERS[m.provider]?.label ?? "").toLowerCase().includes(q),
          )
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
    return null;
  }, [text, models, commands]);

  /*
   * The first "/" is what asks for the skill library.
   *
   * The palette is built from `commands`, and a skill row can only be in it if
   * the list has been read — so the read has to start before the palette opens
   * rather than when it does. Typing a slash is the earliest honest signal that
   * somebody is looking for one, and it costs a chat that never types a slash
   * nothing at all. The rows appear when the fetch lands, which is how every
   * other filtered list in this composer behaves.
   */
  React.useEffect(() => {
    if (!skillsAvailable || skillsWanted) return;
    if (/^\s*\//.test(text)) setSkillsWanted(true);
  }, [text, skillsAvailable, skillsWanted]);

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
    document
      .getElementById(`composer-palette-${slashIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [slashIndex]);
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  const slashOpen =
    !controlsLocked && !!slash && !slashDismissed && slash.items.length > 0;

  /*
   * Where the "/" palette goes: outside the composer, at the field's start,
   * below on the home and above in the dock (`placeComposerLayer`), its height
   * capped to the room it actually has so a short window scrolls the list
   * instead of pushing it over the draft. Sampled per frame while open: what
   * moves the composer (the greeting, a voice panel mounting) leaves its own
   * box the same size, so no observer would hear it. React bails out when the
   * placement is unchanged.
   */
  const [slashPlacement, setSlashPlacement] = React.useState<LayerPlacement | null>(null);
  React.useLayoutEffect(() => {
    if (!slashOpen) {
      setSlashPlacement(null);
      return;
    }
    let raf = 0;
    let last = "";
    const tick = () => {
      const box = shellRef.current?.getBoundingClientRect();
      if (box) {
        const next = placeComposerLayer({
          composer: box,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          anchorX: box.left + 16,
          inset: 4,
          width: 420,
          need: 300,
          prefer: layerSide,
        });
        const key = JSON.stringify(next);
        if (key !== last) {
          last = key;
          setSlashPlacement(next);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [slashOpen, layerSide]);

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
      // Text only. This used to flip a canvas preference on the way past;
      // whether an answer belongs in a canvas is the model's call now, so the
      // command does the one thing its name promises — it writes the prompt.
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
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
      if (
        (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) ||
        e.key === "Tab"
      ) {
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
    // ↑ in an empty field edits your last message (the newest user turn
    // listens for this in message-item.tsx). Only when there is nothing typed:
    // with a draft, ↑ moves the caret as it always has.
    if (e.key === "ArrowUp" && text.length === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("juno:edit-last-user-message"));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      // "Send with ⌘ Enter" (Settings › Keyboard): a plain Enter is a new
      // line, which the field inserts when this leaves the event alone.
      if (uiPref("sendKey") === "mod-enter" && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      void submit(e.currentTarget.value);
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
    if (!plusOpen) setConnectorQuery("");
  }, [plusOpen, privateMode, voiceActive, loadProjects]);

  const refreshConnectors = React.useCallback(
    // `maxAgeMs`: opening a conversation reuses a list read in the last 30 s
    // (lib/client-cache.ts; a connection change invalidates it). The + menu
    // and the retry button ask for a fresh one, as before.
    async (signal?: AbortSignal, maxAgeMs = 0) => {
      if (privateMode || !onToggleConnector) return;
      setConnectorsLoading(true);
      setConnectorsFailed(false);
      try {
        const data = await cachedJson<{
          connectors?: {
            id: string;
            label: string;
            connected: boolean;
            configured?: boolean;
          }[];
        }>("/api/connectors", { maxAgeMs });
        if (signal?.aborted) return;
        setAllConnectors(data.connectors ?? []);
        const connected = (data.connectors ?? []).filter(
          (connector) => connector.connected,
        );

        // Reconcile the conversation's saved IDs against the live account
        // connections, removing disconnected apps and anything over the limit.
        const availableIds = new Set(
          connected.map((connector) => connector.id),
        );
        const enabledIds = Array.from(new Set(enabledConnectorIdsRef.current));
        const removals = enabledIds.filter(
          (id, index) => !availableIds.has(id) || index >= MAX_CHAT_CONNECTORS,
        );
        if (removals.length > 0) {
          const removeSet = new Set(removals);
          enabledConnectorIdsRef.current = enabledIds.filter(
            (id) => !removeSet.has(id),
          );
          removals.forEach((id) => onToggleConnector(id));
        }
      } catch (error) {
        // A non-2xx answer was always ignored quietly here; only a transport
        // failure marks the list stale.
        if (!(error instanceof DOMException && error.name === "AbortError") && !(error instanceof CachedJsonError)) {
          // Keep the last known list on a transient failure — a stale list is
          // more useful than an empty one — but record that it IS stale.
          setConnectorsFailed(true);
        }
      } finally {
        if (!signal?.aborted) setConnectorsLoading(false);
      }
    },
    [onToggleConnector, privateMode],
  );

  // Reconcile on mount, when returning from Connections, and when the normal
  // + menu opens in case another tab changed an app connection.
  React.useEffect(() => {
    if (privateMode || voiceActive || !onToggleConnector) return;
    const controller = new AbortController();
    void refreshConnectors(controller.signal, 30_000);
    const handleConnectionsChanged = () =>
      void refreshConnectors(controller.signal);
    window.addEventListener(
      "juno:connections-changed",
      handleConnectionsChanged,
    );
    return () => {
      controller.abort();
      window.removeEventListener(
        "juno:connections-changed",
        handleConnectionsChanged,
      );
    };
  }, [onToggleConnector, privateMode, refreshConnectors, voiceActive]);

  React.useEffect(() => {
    if (plusOpen && !privateMode && !voiceActive && onToggleConnector)
      void refreshConnectors();
  }, [
    onToggleConnector,
    plusOpen,
    privateMode,
    refreshConnectors,
    voiceActive,
  ]);

  React.useEffect(() => {
    if (
      selectedProjectId &&
      projects.length === 0 &&
      !privateMode &&
      !voiceActive
    )
      loadProjects();
  }, [
    selectedProjectId,
    projects.length,
    privateMode,
    voiceActive,
    loadProjects,
  ]);

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
      if (!r.ok || !d?.id)
        throw new Error(d?.error ?? "Couldn’t create project.");
      // Optimistically seed the list so the composer chip has a name to show
      // before the sidebar's reload lands.
      setProjects((prev) => [
        { id: d.id, name: "New project", conversationCount: 0 },
        ...prev,
      ]);
      window.dispatchEvent(new CustomEvent("projects:sync"));
      onPickProject?.(d.id);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn’t create project.",
      );
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
      const clampValue = (
        v: PreflightClarificationAnswerValue,
      ): PreflightClarificationAnswerValue =>
        typeof v === "string"
          ? v.slice(0, 1000)
          : Array.isArray(v)
            ? v.slice(0, 12).map((s) => s.slice(0, 500))
            : v;
      const finalAnswers = answers.map((a) =>
        a.value === undefined ? a : { ...a, value: clampValue(a.value) },
      );
      // Text typed in the main textarea while the popover is open still counts,
      // but as a custom answer for the first UNANSWERED question — it must
      // never overwrite an option the user clicked or the popover's own
      // "Other" input. Clamped to the server's 1000-char answer limit.
      const trimmedText = text.trim().slice(0, 1000);
      if (trimmedText && pendingClarification) {
        const target = pendingClarification.result.questions.find(
          (q) => !finalAnswers.some((a) => a.questionId === q.id),
        );
        finalAnswers.push(
          target
            ? {
                questionId: target.id,
                question: target.question,
                source: "else",
                value: trimmedText,
              }
            : {
                questionId: "additional_context",
                question: "Additional context",
                source: "else",
                value: trimmedText,
              },
        );
      }
      const result = await onSubmitClarification(finalAnswers);
      if (!result || result.accepted !== false) clearComposerDraft();
      return !result || result.accepted !== false;
    },
    [clearComposerDraft, onSubmitClarification, pendingClarification, text],
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
    if (pendingClarification)
      setText(
        interceptedDraftRef.current || pendingClarification.originalUserMessage,
      );
    onCancelClarification?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [onCancelClarification, pendingClarification]);

  const selectedProject = selectedProjectId
    ? (projects.find((p) => p.id === selectedProjectId) ?? null)
    : null;
  /** The home's tray (composer-tray.tsx): a brand-new chat on the landing frame only. */
  const showTray = frame === "landing" && !conversationId && !privateMode && !voiceActive && !steerMode;
  const canAttach = features.storage && !privateMode;
  // One reason, three rows: whichever of the two gates is shut is the one the
  // row should name. Never a row that silently vanishes.
  const attachNote = privateMode
    ? "Incognito"
    : !features.storage
      ? "Unavailable"
      : undefined;
  // Renders "⌘U" on the server and corrects itself after mount (platform.ts),
  // so the hint is right on a PC without a hydration mismatch.
  const modifierKey = useModifierKeyLabel();
  const attachShortcut = modifierKey === "⌘" ? "⌘U" : "Ctrl+U";

  // ⌘U is the one attach shortcut, and the + menu's first row prints it. Bound
  // here rather than in use-global-shortcuts because it needs THIS composer's
  // file input and its canAttach gate — the projects page and Compare mount
  // their own, and a global binding would fire the wrong one.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "u" || !canAttach || plusLocked) return;
      // Ctrl+U is View Source in Chrome and Firefox on Windows and Linux.
      event.preventDefault();
      fileInputRef.current?.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canAttach, plusLocked]);

  /**
   * The connected apps attached to THIS chat, in the account's own order.
   *
   * Derived from `connectors` (the fetched list) rather than from
   * `connectorsEnabled` (a list of ids) because a mark needs a label and a
   * logo, and because an id the account no longer has connected must not draw
   * a row: `connectorsEnabled` is chat state and outlives a disconnection.
   */
  const attachedConnectors = React.useMemo(
    () => connectors.filter((connector) => connectorsEnabled.includes(connector.id)),
    [connectors, connectorsEnabled],
  );
  const activeConnectorCount = attachedConnectors.length;

  const connectorSearch = connectorQuery.trim().toLocaleLowerCase();
  const visibleConnectors = connectorSearch
    ? connectors.filter((connector) =>
        `${connector.label} ${connector.id}`
          .toLocaleLowerCase()
          .includes(connectorSearch),
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
    skillArmed ? `the ${armedSkill?.name ?? skillSlug} skill` : null,
    researchArmed ? "research" : null,
    canWebSearch && webSearchEnabled ? "web search" : null,
    settings.memoryEnabled ? "memory" : null,
  ].filter((label): label is string => label !== null);
  // Connectors sit in the ADD group, not TOOLS, so they must not inflate the
  // disclosure's count — but they are still armed state the + trigger owes the user.
  const armedConnectors =
    showConnectors && activeConnectorCount > 0
      ? `${activeConnectorCount} connector${activeConnectorCount === 1 ? "" : "s"}`
      : null;
  const armedTools = armedConnectors
    ? [...armedToolsInGroup, armedConnectors]
    : armedToolsInGroup;
  const activeToolCount = armedTools.length;
  const armedSummary = activeToolCount > 0 ? `${armedTools.join(", ")} on` : "";

  /**
   * ── What THIS message runs as, at the head of the sentence ────────────────
   *
   * Only the per-message modes are drawn in the field: a skill and Deep Field,
   * the two things that change how this one message is answered and clear
   * themselves after it is sent (C11 puts a command token at the head of the
   * message; these are that token). They are drawn in the token family, where
   * the first word would go.
   *
   * Standing settings are NOT drawn here (C19: nothing is drawn as an armed
   * chip). Web search, memory and the apps attached to this chat are true of
   * every message until changed, so a chip for them would be permanent
   * furniture that teaches the reader to stop reading the field; the + menu
   * shows them checked, and the + button's accessible name lists what is on.
   * An app named for one message is a context token in the sentence instead.
   */
  const armedMarks: ArmedMark[] = [
    /* The skill first: it changes the method rather than the reach. An
       untrusted skill says so on the mark, at the moment of sending. */
    ...(skillArmed
      ? [{
          id: "skill",
          icon: <AppIcons.skills className="size-4" />,
          label: armedSkill?.name ?? `/${skillSlug}`,
          detail: armedSkill && !trustPermitsAutoSelection(armedSkill.trust) ? "not trusted" : undefined,
          tooltip: armedSkill
            ? armedSkill.description || `Sent under /${armedSkill.slug}.`
            : `Sent under /${skillSlug}.`,
          openLabel: `This message is sent under the ${armedSkill?.name ?? skillSlug} skill. Opens the add menu.`,
          removeLabel: "Don’t use this skill for this message",
          remove: () => setSkillSlug(null),
        }]
      : []),
    ...(researchArmed
      ? [{
          id: "research",
          icon: <ComposerIcons.research className="size-4" />,
          label: FEATURE_NAMES.research.label,
          // No depth word: Deep Field sizes itself.
          tooltip: <>{`${FEATURE_NAMES.research.description}: plans, reads the web and writes a cited report. Usually 5–15 minutes.`}</>,
          openLabel: `${FEATURE_NAMES.research.accessibleLabel} on. Opens the add menu.`,
          removeLabel: `Turn off ${FEATURE_NAMES.research.label}`,
          remove: () => setResearch(false),
        }]
      : []),
  ];
  /*
   * Two marks with words is ~260px, and a phone composer is 350 wide, which
   * would leave the sentence a third of its own line. Below a 30rem COMPOSER
   * (the composer is the `@container`, see composer-shell.tsx) two marks keep
   * their glyphs and drop their words; one mark always keeps its words. A
   * literal class: Tailwind scans source text.
   */
  const armedLabelClass = armedMarks.length > 1 ? "hidden @[30rem]:inline" : undefined;
  /* The indent the field owes the marks, and ZERO the moment they are gone:
     nothing re-measures a group that has unmounted. */
  const leadMarks = armedMarks.map((mark) => (
    <ComposerArmedMark
      key={mark.id}
      icon={mark.icon}
      label={mark.label}
      labelClassName={armedLabelClass}
      detail={mark.detail}
      tooltip={mark.tooltip}
      onOpen={() => setPlusOpen(true)}
      onRemove={mark.remove}
      openLabel={mark.openLabel}
      removeLabel={mark.removeLabel}
      disabled={controlsLocked}
    />
  ));
  const leadIndent = leadMarks.length > 0 ? leadWidth : 0;

  /**
   * The + menu, as data. Three sections in Claude's order: what you bring in,
   * where this chat sits and what it can reach, and what is armed for the
   * message — see composer-plus-menu.tsx for the box itself. A row that
   * cannot be used right now stays visible with the reason on it rather than
   * vanishing, so "why is web search missing" never has to be asked.
   */
  const projectPanel = () => (
    <>
      <MenuLabel>Projects</MenuLabel>
      {loadingProjects && projects.length === 0 ? (
        <MenuSkeleton rows={2} />
      ) : projects.length === 0 ? (
        <MenuEmpty
          icon={AppIcons.projects}
          title="No projects yet"
          hint="A project keeps chats, files and instructions together."
        />
      ) : (
        <ScrollFade className="min-h-0 flex-1" viewportClassName="max-h-64">
          {projects.map((project) => (
            <PlusMenuRow
              key={project.id}
              selected={selectedProjectId === project.id}
              icon={AppIcons.projects}
              onSelect={() => onPickProject?.(project.id)}
            >
              {project.name}
            </PlusMenuRow>
          ))}
        </ScrollFade>
      )}
      <PlusMenuSeparator />
      <PlusMenuRow
        icon={Plus}
        disabled={creatingProject}
        onSelect={() => void createProjectAndPick()}
      >
        {creatingProject ? "Creating…" : "New project"}
      </PlusMenuRow>
      {selectedProjectId ? (
        <PlusMenuRow icon={ActionIcons.dismiss} onSelect={() => onPickProject?.(null)}>
          Remove from project
        </PlusMenuRow>
      ) : null}
    </>
  );

  const connectorsPanel = () => (
    <>
      {connectors.length > 5 ? (
        <MenuSearch value={connectorQuery} onChange={setConnectorQuery} placeholder="Search apps" label="Search apps" />
      ) : (
        <MenuLabel>Apps in this chat</MenuLabel>
      )}
      <div className="max-h-56 overflow-y-auto overscroll-contain">
        {connectorsLoading && connectors.length === 0 ? (
          <MenuSkeleton rows={3} />
        ) : connectorsFailed && connectors.length === 0 ? (
          <MenuEmpty
            icon={AppIcons.connections}
            title="Couldn’t load your apps"
            action={
              <button type="button" onClick={() => void refreshConnectors()} className="cmenu-empty__action">
                Try again
              </button>
            }
          />
        ) : connectors.length === 0 ? (
          <MenuEmpty
            icon={AppIcons.connections}
            title="No apps connected"
            hint="Connect Gmail, GitHub, Drive and more so chats can use them."
          />
        ) : visibleConnectors.length === 0 ? (
          <MenuEmpty icon={Search} title={`No apps match “${connectorQuery.trim()}”`} />
        ) : (
          visibleConnectors.map((connector) => (
            <PlusMenuRow
              key={connector.id}
              checked={connectorsEnabled.includes(connector.id)}
              onSelect={() => pickConnector(connector.id)}
              leading={
                <span className="cmenu-tile">
                  <ConnectorMark id={connector.id} className="size-3.5 shrink-0 text-foreground" />
                </span>
              }
            >
              {connector.label}
            </PlusMenuRow>
          ))
        )}
      </div>
      <PlusMenuSeparator />
      <PlusMenuRow
        icon={connectors.length > 0 ? AppIcons.connections : Plus}
        detail={connectors.length > 0 ? `${activeConnectorCount} of ${MAX_CHAT_CONNECTORS} on` : undefined}
        onSelect={() => router.push("/connections")}
      >
        {connectors.length > 0 ? "Manage connections" : "Connect an app"}
      </PlusMenuRow>
    </>
  );

  /**
   * The skills flyout (`ComposerSkillsPanel`): grouped by source while
   * browsing, flat with a source label while filtering, with a filter once the
   * library is longer than a glance.
   *
   * Radio-ish rows: picking one arms it, picking the armed one again clears
   * it. Not checkboxes, because a message runs under one skill — Claude Code
   * stacks up to six, which makes sense for a shell agent composing a pipeline
   * and does not for a single chat turn, where two sets of method for one
   * answer is a contradiction the model resolves silently.
   *
   * The failure state is carried rather than swallowed, on the same argument
   * the connectors panel beside it makes: "you have no skills" and "Juno could
   * not find out" are different sentences and only the second deserves a Retry.
   */
  const skillsPanel = () => (
    <ComposerSkillsPanel
      skills={skillLibrary}
      failed={skillsFailed}
      onRetry={reloadSkills}
      armedSlug={skillSlug}
      onPick={(slug) => setSkillSlug((current) => (current === slug ? null : slug))}
      onManage={() => router.push("/skills")}
    />
  );

  const skillRow: PlusMenuItem | null = skillsAvailable
    ? {
        kind: "sub",
        id: "skill",
        label: "Run a skill",
        icon: AppIcons.skills,
        // Only while one is armed, like the research row's depth: a name on an
        // unarmed row reads as the state rather than as what it would be.
        detail: skillArmed ? armedSkill?.name ?? `/${skillSlug}` : undefined,
        render: skillsPanel,
        onOpenChange: (open: boolean) => {
          if (open) setSkillsWanted(true);
        },
      }
    : null;

  const researchRow: PlusMenuItem | null =
    researchAvailable
      ? {
          kind: "toggle",
          id: "research",
          label: FEATURE_NAMES.research.label,
          // A branded mode carries its plain descriptor (D-038).
          description: FEATURE_NAMES.research.description,
          ariaLabel: FEATURE_NAMES.research.accessibleLabel,
          icon: ComposerIcons.research,
          checked: research,
          onToggle: toggleResearch,
        }
      : null;

  /** The + menu's "Mention" row: an "@" at the caret, and the palette opens on it. */
  const mentionRow: PlusMenuItem | null =
    !privateMode && !voiceActive && modality === "chat"
      ? {
          kind: "action",
          id: "mention",
          label: "Mention a file, app or agent",
          icon: AtSign,
          detail: "@",
          onSelect: () => {
            // After the menu has handed focus back, so the "@" lands in the field.
            window.setTimeout(() => textareaRef.current?.openMention(), 0);
          },
        }
      : null;

  const plusSections: PlusMenuSection[] = voiceActive
    ? [
        [
          // Files reach a live call as resolved text and photos as frames, so
          // the voice sheet offers the same row the chat sheet does — narrowed
          // to photos only where the provider has no eyes to use them.
          {
            kind: "action",
            id: voiceCanSeeImages ? "files" : "voice-files",
            label: voiceCanSeeImages ? "Add photos and files" : "Add files",
            icon: ComposerIcons.attach,
            detail: attachShortcut,
            disabled: !canAttach,
            note: attachNote,
            onSelect: () => fileInputRef.current?.click(),
          },
          {
            kind: "action",
            id: "library",
            label: "Add from Library",
            icon: AppIcons.library,
            disabled: !canAttach,
            note: attachNote,
            onSelect: () => setLibraryOpen(true),
          },
        ],
        researchRow ? [researchRow] : [],
      ]
    : [
        // Bring something in (the gallery's order). One row for photos and
        // files: ACCEPT_ATTRIBUTE (lib/uploads.ts) carries every image mime,
        // and the row is the one place in the product that teaches ⌘U.
        [
          {
            kind: "action",
            id: "files",
            label: "Add photos and files",
            icon: ComposerIcons.attach,
            detail: attachShortcut,
            disabled: !canAttach,
            note: attachNote,
            onSelect: () => fileInputRef.current?.click(),
          },
          // Omitted, not disabled, where the browser has no getDisplayMedia
          // (iOS Safari, most mobile): a row that can never work is furniture.
          ...(canScreenshot
            ? [
                {
                  kind: "action" as const,
                  id: "screenshot",
                  label: "Take a screenshot",
                  icon: Scan,
                  disabled: !canAttach,
                  note: attachNote,
                  onSelect: () => void captureScreenshot(),
                },
              ]
            : []),
          {
            kind: "action",
            id: "sketch",
            label: "Sketch",
            icon: Pencil,
            detail: "/sketch",
            disabled: !canAttach,
            note: attachNote,
            // After the menu has handed focus back, so the sheet keeps it.
            onSelect: () => window.setTimeout(sketch.openSketch, 0),
          },
          {
            kind: "action",
            id: "library",
            label: "Add from Library",
            icon: AppIcons.library,
            disabled: !canAttach,
            note: attachNote,
            onSelect: () => setLibraryOpen(true),
          },
        ],
        // Name things in the sentence: what "@" and "/" do, taught here so the
        // placeholder never has to be a syntax lesson.
        [...(mentionRow ? [mentionRow] : []), ...(skillRow ? [skillRow] : [])],
        // How this message is answered: the Deep Field mode, then the two
        // switches people actually flip (C19).
        [
          ...(researchRow ? [researchRow] : []),
          {
            kind: "toggle",
            id: "search",
            label: "Web search",
            icon: ComposerIcons.web,
            checked: canWebSearch && webSearchEnabled,
            disabled: !canWebSearch,
            note: canWebSearch ? undefined : modality === "chat" ? "Not on this model" : "Chat only",
            onToggle: () => onToggleWebSearch?.(!webSearchEnabled),
          },
          {
            kind: "toggle",
            id: "memory",
            label: FEATURE_NAMES.memory.label,
            icon: ComposerIcons.memory,
            checked: settings.memoryEnabled,
            onToggle: () => toggleMemory(!settings.memoryEnabled),
          },
        ],
        // Where this chat sits and what it can reach.
        [
          ...(!privateMode
            ? [
                {
                  kind: "sub" as const,
                  id: "project",
                  label: "Add to project",
                  icon: AppIcons.projects,
                  detail: selectedProject?.name,
                  render: projectPanel,
                },
              ]
            : []),
          ...(showConnectors
            ? [
                {
                  kind: "sub" as const,
                  id: "connectors",
                  label: FEATURE_NAMES.apps.label,
                  icon: AppIcons.connections,
                  detail: activeConnectorCount > 0 ? String(activeConnectorCount) : undefined,
                  render: connectorsPanel,
                  onOpenChange: (open: boolean) => {
                    if (!open) setConnectorQuery("");
                  },
                },
              ]
            : []),
        ],
      ];

  /*
   * The + menu, the model chip, the tray's and the generation row's menus
   * open at their own trigger, over the composer when that is where the room
   * is (composer-menu.tsx, "Where they open"). Only the typed layers (the "/"
   * and @ palettes) still open outside the box, at the caret.
   */
  /** The effort, in words, only when it is not the model's usual one (C17: "Opus Deep"). */
  const effortLabel =
    !isAuto && resolved && effortOptions.length >= 2 && reasoningEffort !== defaultReasoning(resolved)
      ? effortOptions.find((option) => option.value === clampReasoningEffort(resolved, reasoningEffort))?.label
      : undefined;

  /** The field's accessible name (C1). The placeholder is a hint, never the name. */
  const fieldLabel =
    steerMode && steering
      ? steering.placeholder
      : customPlaceholder?.startsWith("Message ")
        ? customPlaceholder.replace(/…$/, "")
        : `Message ${PRODUCT_NAME}`;
  /** A layer is open below the composer (the home's suggestions step aside for it). */
  const layerBelow =
    fieldLayer === "below" || (slashOpen && slashPlacement?.side === "below");

  return (
    <div
      ref={rootRef}
      // What the home reads (composer.css): a draft makes its suggestions moot,
      // and a layer opened below covers them.
      data-composer-draft={text.trim() || uploads.length > 0 ? "" : undefined}
      data-layer-below={layerBelow ? "" : undefined}
      className={cn(
        "w-full",
        frame === "dock" && "page-gutter mx-auto transcript-column",
        // The generation shelf tucks under the dock with z-index -1; without
        // its own stacking context this wrapper would sit on top of it and
        // take its clicks (composer-media-params.css).
        frame === "dock" && mediaParams.caps && "isolate",
        // With a footnote the line takes the inset's 16 / 24px itself (see
        // the slot below), so only the home indicator stays as padding.
        frame === "dock" &&
          (dockFootnote
            ? "pb-[env(safe-area-inset-bottom)]"
            : "pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]"),
        // The dock's content width (48rem less a gutter each side), read from
        // the gutter the landing column already applies. See the prop.
        frame === "landing" && "isolate mx-auto max-w-[calc(48rem-2*var(--page-gutter,0px))]"
      )}
    >
      {quotaReached && (
        <div
          role="status"
          className="mb-2 rounded-control border border-primary/30 bg-primary/5 px-3 py-2 text-center text-ui text-foreground"
        >
          {freeAllowanceUsed ? (
            <>
              You&apos;ve used this month&apos;s free allowance.{" "}
              <a
                href="/upgrade"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                Upgrade to keep chatting
              </a>
            </>
          ) : (
            <>
              You&apos;ve reached your monthly limit.{" "}
              <a
                href="/upgrade"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                Upgrade to keep chatting
              </a>
            </>
          )}
        </div>
      )}

      {/* Existing chats get the persistent scope bar at the top of the chat
          instead; the chip only announces where a brand-new chat will land. */}
      {selectedProject && !privateMode && !conversationId && !showTray && (
        <div className="mb-2 flex">
          {/* Muted glyph on the caption rung (14px, gap-1.5): the folder is a
              label on the chip, not a state, so it does not take the accent. */}
          <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-card pl-2.5 pr-1 text-caption text-muted-foreground motion-safe:animate-rise-in">
            <AppIcons.projects aria-hidden="true" className="size-3.5" />
            <span>
              {"New chat in "}
              <span className="font-medium text-foreground">
                {selectedProject.name}
              </span>
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => pickProject(null)}
                  aria-label="Remove from project"
                  className="pressable ml-0.5 grid size-6 place-items-center rounded-full text-muted-foreground/70 hover:bg-accent hover:text-foreground motion-reduce:active:scale-100 coarse:size-8"
                >
                  <ActionIcons.dismiss aria-hidden="true" className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Remove from project</TooltipContent>
            </Tooltip>
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
      <DictationSwap
        active={dictating}
        draft={text}
        onCancel={() => setDictating(false)}
        onClose={(transcript, sendNow) => closeDictation(transcript, sendNow)}
      >
        <div
          {...fileDropHandlers}
          // The cross-fade, `inert` and pointer handling all live in
          // DictationSwap; this wrapper only carries the drop target.
          className="w-full"
        >
        <VoiceComposerGlow call={voiceCall}>
        <ComposerShell
          // The box every layer the composer opens is placed outside of.
          ref={shellRef}
          frame={frame === "landing" ? "home" : "dock"}
          keyboardFocus={keyboardFocus}
          onPointerDownCapture={() => {
            pointerFocus.current = true;
          }}
          dimmed={controlsLocked && !steerMode}
          className={cn(
            "max-h-[600px]",
            // In a call the glow's layers sit under the shell's contents.
            voiceCall && "voice-glow-host",
            // Private mode redraws the edge dashed; every other state's border
            // and focus lift come from `.composer-surface` itself.
            privateMode && "border-dashed border-foreground/25",
            dragging && "border-primary/55 ring-2 ring-primary/20",
          )}
          above={
            <>
              {/* Whatever the run needs said directly above the field — for a
                  task, the instructions it has been given and not yet taken a
                  turn on. It sits here rather than in the transcript because the
                  question it answers ("did my redirect land?") is asked at the
                  moment of typing the next one. */}
              {modeControl}
              {steerMode && steering?.above}
              {dragging && !privateMode && (
                <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-inherit border-2 border-dashed border-primary/45 bg-primary/10 backdrop-blur-sm animate-fade-in">
                  <ComposerIcons.files aria-hidden="true" className="size-6 text-primary" />
                  <span className="font-mono text-label text-primary">
                    Drop to attach
                  </span>
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

            {!privateMode && (
              <ComposerAttachmentRow
                uploads={uploads}
                onRemove={remove}
                labelFor={sketch.sketchLabel}
                openerFor={(upload) => (sketch.canReopen(upload) ? () => sketch.openUpload(upload) : undefined)}
              />
            )}

            {quote && (
              <div
                className={cn(
                  // `rounded-control`, the one inner radius the composer uses:
                  // the same rung as the chips below and the tiles beside it.
                  //
                  // NEUTRAL, on the argument the armed marks settled
                  // (PREMIUM_AUDIT.md §2d): what this message is about is a
                  // fact about the draft, not an alert about it. A coral card,
                  // coral tile and coral label were the loudest object in the
                  // composer — louder than the send circle — for a quotation.
                  "mx-4 mt-3.5 flex items-start gap-2.5 rounded-control border border-border/70 bg-secondary px-3 py-2",
                  quoteRemoving
                    ? "pointer-events-none motion-safe:animate-pop-out"
                    : "motion-safe:animate-rise-in",
                )}
              >
                {/* A 24px tile on the `xs` rung — the one small plate in the
                    composer, holding a 14px mark beside caption text. */}
                <span
                  aria-hidden
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-xs border border-border/70 bg-card text-muted-foreground"
                >
                  {quote.kind === "element" ? (
                    <SquareDashedMousePointer className="size-3.5" />
                  ) : quote.kind === "area" ? (
                    <Crop className="size-3.5" />
                  ) : (
                    <TextQuote className="size-3.5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="shrink-0 font-mono text-label text-muted-foreground">
                      {quote.mode === "modify" ? "Modify" : "Ask"}
                    </span>
                    <span className="min-w-0 truncate text-ui font-medium">
                      {quote.title}
                    </span>
                    {quoteLocationLabel(quote) && (
                      <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
                        {quoteLocationLabel(quote)}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 break-all font-mono text-caption leading-relaxed text-muted-foreground">
                    {quote.text.trim()
                      ? quote.text.replace(/\s+/g, " ").trim().slice(0, 220)
                      : quote.kind === "area"
                        ? "The area is attached as an image."
                        : ""}
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={dismissQuote}
                      aria-label="Remove quoted selection"
                      // No transition-* beside `.pressable`: it would replace
                      // the class's list and leave the dip untimed.
                      className="pressable -mr-1 mt-0.5 shrink-0 rounded-full p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground motion-reduce:active:scale-100 coarse:p-2"
                    >
                      <ActionIcons.dismiss aria-hidden="true" className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Remove quote</TooltipContent>
                </Tooltip>
              </div>
            )}

            {showCollapsedDraft && (
              <div
                className="mx-4 mt-3.5 flex flex-col gap-2 rounded-control border border-border/70 bg-secondary px-3 py-3"
                tabIndex={0}
                role="group"
                aria-label="Large paste ready to send. Press Enter to send."
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-ui font-medium">
                      Large paste ready to send
                    </p>
                    <p className="mt-0.5 font-mono text-caption text-muted-foreground">
                      {text.length.toLocaleString()} characters · full text is
                      kept and will be sent · Enter to send
                    </p>
                    <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-caption text-muted-foreground/90">
                      {text.slice(0, 280)}
                      {text.length > 280 ? "…" : ""}
                    </p>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
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
                        <ActionIcons.dismiss aria-hidden="true" className="size-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Clear paste</TooltipContent>
                  </Tooltip>
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
                    <ActionIcons.edit aria-hidden="true" className="size-3.5" /> Expand to edit
                  </Button>
                  {features.storage && !privateMode && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={attachAsFile}
                      className="h-7 gap-1.5"
                    >
                      <ComposerIcons.files aria-hidden="true" className="size-3.5" /> Attach as file
                    </Button>
                  )}
                </div>
              </div>
            )}

            {longText &&
              !showCollapsedDraft &&
              features.storage &&
              !privateMode && (
                <div className="flex items-center justify-between gap-3 px-4 pt-3">
                  <span className="text-caption text-muted-foreground">
                    That’s a long one. Attach it as a file to keep the chat
                    tidy?
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={attachAsFile}
                    className="h-7 shrink-0 gap-1.5"
                  >
                    <ComposerIcons.files aria-hidden="true" className="size-3.5" /> Attach as file
                  </Button>
                </div>
              )}

            {/* The "/" palette: the composer layer recipe on the shared
                material, placed outside the composer (SlashLayer). Options,
                not tab stops: the caret never leaves the field, so this is a
                combobox popup, and each row's state is its `aria-checked`. */}
            {slashOpen && slash && (
              <SlashLayer placement={slashPlacement}>
                <div
                  id="composer-palette-listbox"
                  role="listbox"
                  aria-label={slash.kind === "model" ? "Switch model" : "Commands"}
                  className="composer-layer__scroll"
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
                          onMouseMove={() => {
                            if (i !== slashIndex) setSlashIndex(i);
                          }}
                          onClick={() => applySlash(m)}
                          className={PALETTE_ROW_CLASS}
                        >
                          <PaletteIcon>
                            <ProviderLogo provider={m.provider} className="size-4" />
                          </PaletteIcon>
                          <span className="min-w-0 flex-1 truncate">{m.name}</span>
                          <span className="shrink-0 text-caption text-muted-foreground">
                            {PROVIDERS[m.provider].label.split(" · ")[0]}
                          </span>
                          {m.id === model && (
                            <StatusIcons.success aria-hidden className="size-3.5 shrink-0 text-foreground" />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    groupRows(slash.items).map(({ group, rows }) => (
                      <div key={group} role="group" aria-label={GROUP_LABELS[group]} className="composer-layer__group">
                        <PaletteEyebrow label={GROUP_LABELS[group]} />
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
                              // the tool's own state (its tick is aria-hidden).
                              aria-checked={item.on}
                              onMouseMove={() => {
                                if (!selected) setSlashIndex(index);
                              }}
                              onClick={() => applySlash(item)}
                              className={PALETTE_ROW_CLASS}
                            >
                              <PaletteIcon>
                                {Icon ? (
                                  <Icon
                                    aria-hidden
                                    motion="none"
                                    className={cn("size-4", item.on || selected ? "text-foreground" : "text-muted-foreground")}
                                  />
                                ) : null}
                              </PaletteIcon>
                              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                                <span className="max-w-[55%] shrink-0 truncate font-mono text-ui">{item.label}</span>
                                <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{item.hint}</span>
                              </span>
                              {(item.note || item.on) && (
                                // One trailing slot, note then tick, so an armed
                                // skill keeps its source beside the tick.
                                <span className="flex shrink-0 items-center gap-1.5">
                                  {item.note && (
                                    <span className="whitespace-nowrap text-caption text-muted-foreground">{item.note}</span>
                                  )}
                                  {item.on && <StatusIcons.success aria-hidden className="size-3.5 shrink-0 text-foreground" />}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
              </SlashLayer>
            )}

            {/* Huge drafts render as a compact card above; keep the textarea out of
            the DOM so React never diffs multi-10k controlled values every key. */}
            </>
          }
          field={
            !showCollapsedDraft && (
              /*
               * ── THE FIELD TIER ───────────────────────────────────────────
               *
               * The field is the contenteditable sentence with its context
               * tokens (context-composer-field.tsx); the marks for what this
               * message runs as (a skill, Deep Field) are laid over its head,
               * with `text-indent` reserving exactly their width. Its layers
               * (the @ palette, a token's popover) open outside this box.
               */
              <div className="relative">
                <ContextComposerField
                  conversationId={conversationId}
                  privateMode={privateMode}
                  mentionsDisabled={voiceActive || modality !== "chat"}
                  onTokensChange={setContextTokens}
                  anchorRef={shellRef}
                  layerSide={layerSide}
                  onLayerChange={setFieldLayer}
                  loadMentions={loadMentions}
                  ref={textareaRef as React.Ref<HTMLTextAreaElement>}
                  id={CHAT_COMPOSER_FIELD_ID}
                  // The field's name (C1): "Message Alevr", "Message Mira" in
                  // an agent's thread, or what a live run asks for.
                  aria-label={fieldLabel}
                  value={text}
                  onChange={(e) => setDraftText(e.target.value)}
                  onFocus={() => {
                    setKeyboardFocus(!pointerFocus.current);
                    pointerFocus.current = false;
                  }}
                  onBlur={() => setKeyboardFocus(false)}
                  onScroll={onFieldScroll}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                  // Live through a generation: the draft for the next message is
                  // typed while the reply streams (see `sendBlocked`). Only a hard
                  // send lock and the pre-flight check take the field away.
                  disabled={sendLocked || status === "checking"}
                  /*
                   * NO PLACEHOLDER WHILE A MARK IS IN THE LINE: on a phone the
                   * mark and the hint would split one line and the prompt would
                   * wrap under its own hint. The field is still named.
                   */
                  placeholder={
                    leadMarks.length > 0
                      ? ""
                      : steerMode && steering
                        ? steering.placeholder
                        : placeholder
                  }
                  // The "/" palette is driven from here (focus never moves to
                  // it), so the field names the row the arrows are on. The @
                  // palette is the field's own and sets these itself.
                  aria-expanded={slashOpen}
                  aria-controls={slashOpen ? "composer-palette-listbox" : undefined}
                  aria-activedescendant={
                    slashOpen && slash
                      ? `composer-palette-${Math.min(slashIndex, slash.items.length - 1)}`
                      : undefined
                  }
                  // 16px in EVERY state (composerFieldClass): iOS Safari zooms
                  // into a focused field below 16px. The home's field is taller
                  // at rest; density elsewhere comes from the autosize caps.
                  className={cn(composerFieldClass, frame === "landing" && "min-h-[3.5rem] max-[760px]:min-h-[3.25rem]")}
                  // The marks drawn over the head of the field, as a hole in
                  // the first line: `text-indent` indents one line, not a block.
                  style={leadIndent ? { textIndent: leadIndent } : undefined}
                />
                {leadMarks.length > 0 && (
                  <ComposerFieldLead onWidth={setLeadWidth} spanRef={leadRef}>
                    {leadMarks}
                  </ComposerFieldLead>
                )}
              </div>
            )
          }
          leading={
            <>
              <PlusMenu
                open={plusOpen}
                onOpenChange={setPlusOpen}
                disabled={plusLocked}
                label={armedSummary ? `Add files and more: ${armedSummary}` : "Add files and more"}
                tooltip="Add files and more"
                sections={plusSections}
              />
              {voiceCall?.status}
            </>
          }
          trailing={
            voiceCall ? voiceCall.controls : <>
              {/* The model chip — and, inside its popover, the thinking effort
                  for that model (`thinkingControl`). One chip for one decision. */}
              <div className={cn("min-w-0", controlsLocked && "pointer-events-none")}>
                <ModelSelector
                  value={model}
                  onChange={changeModel}
                  disabled={controlsLocked}
                  thinking={thinkingControl}
                  effortLabel={effortLabel}
                  inComposer
                />
              </div>
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
                      className={composerIconButtonClass}
                    >
                      <Mic className="size-[18px]" motion="none" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Dictate</TooltipContent>
                </Tooltip>
              )}
              {/* No voice button here any more: it is the primary slot's face
                  whenever there is nothing to send. Two ways to start the same
                  call, eight pixels apart, is one more than the row can spend —
                  and this one costs nothing, because the slot it moved into was
                  otherwise disabled. */}
            </>
          }
          action={
                voiceCall && !canSend ? voiceCall.end : <Tooltip>
                  <TooltipTrigger asChild>
                    <ComposerPrimaryAction
                      face={PRIMARY_FACES[primaryFace]}
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
                          : // Voice is never short of something to do; only the
                            // send face can have an empty draft behind it.
                            primaryFace !== "voice" && !canSend
                      }
                      aria-label={
                        primaryFace === "stop"
                          ? status === "stopping"
                            ? "Stopping generation"
                            : // The caller names what Stop ends. A delegated run
                              // and a streaming answer are both "stop" on this
                              // button and they end very different things, and
                              // the one word the button can afford has to be the
                              // right one.
                              (steerMode && steering ? steering.stopLabel : "Stop generating")
                          : primaryFace === "voice"
                            ? "Start voice conversation"
                            : uploading
                              ? "Send (waiting for the attachment to finish uploading)"
                              : steerMode && steering
                                ? steering.sendLabel
                                : "Send message"
                      }
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {/* Send is disabled while an attachment uploads, and used
                        to say nothing about it: pressing Enter did nothing,
                        silently, and the only clue was a progress ring on a
                        56px tile. The button now names its own blocker. */}
                    {primaryFace === "stop"
                      ? steerMode && steering
                        ? steering.stopLabel
                        : "Stop"
                      : primaryFace === "voice"
                        ? "Voice conversation"
                        : uploading
                          ? "Waiting for the upload to finish"
                          : steerMode && steering
                            ? steering.sendLabel
                            : "Send"}
                  </TooltipContent>
                </Tooltip>
          }
        />
        </VoiceComposerGlow>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={(e) => {
                if (!privateMode && e.target.files?.length)
                  addComposerFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {!privateMode && features.storage && (
              <LibraryPicker
                open={libraryOpen}
                onOpenChange={setLibraryOpen}
                onAttach={addComposerAttachments}
                existingCount={uploads.length}
              />
            )}
            {sketch.dialog}
        </div>
      </DictationSwap>
      {showTray && (
        <ComposerTray
          projectName={selectedProject?.name ?? null}
          connectors={attachedConnectors}
          onOpenProjects={loadProjects}
          onOpenApps={() => void refreshConnectors()}
          onOpenSkills={() => setSkillsWanted(true)}
          projectPanel={projectPanel}
          appsPanel={showConnectors ? connectorsPanel : null}
          skillsPanel={skillRow ? skillsPanel : null}
          disabled={plusLocked}
          params={
            mediaParams.caps ? (
              <ComposerMediaParams modelId={model} state={mediaParams} disabled={plusLocked} side="top" />
            ) : null
          }
        />
      )}
      {/* In a thread the generation row gets the shelf to itself. */}
      {!showTray && mediaParams.caps && !voiceActive && !steerMode && (
        <div className="composer-tray composer-tray--params">
          <ComposerMediaParams modelId={model} state={mediaParams} disabled={plusLocked} side="top" />
        </div>
      )}
      {/* The dock's bottom inset, with the line in it: 16px under `sm` and
          24px from there, the same heights the padding it replaces had, so a
          chat with a footnote and one without dock at the same height. A
          caller whose line is too much for a phone hides it under `sm` and
          the empty inset keeps its height. */}
      {dockFootnote && (
        <div className="flex min-h-4 select-none items-center justify-center text-center text-caption leading-4 text-muted-foreground sm:min-h-6">
          {dockFootnote}
        </div>
      )}
    </div>
  );
}

/**
 * Memoised: the chat view re-renders on every streamed token, and the composer
 * has nothing to show for any of them. Its handler props come through
 * `useLatestHandler` in chat-view.tsx so the comparison holds while a reply is
 * written (measured in PERFORMANCE.md).
 */
export const Composer = React.memo(ComposerImpl);
