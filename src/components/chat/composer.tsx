"use client";

import * as React from "react";
import type { VoiceCallParts } from "@/components/voice/realtime-voice";
import { VoiceComposerGlow } from "@/components/voice/voice-composer-glow";
import nextDynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import {
  AudioLines,
  Crop,
  Loader2,
  Mic,
  Plus,
  Scan,
  Search,
  SquareDashedMousePointer,
  TextQuote,
} from "@/components/ui/icons";
import type { IconComponent } from "@/components/ui/icons";
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
  ComposerFieldMirror,
  ComposerShell,
  composerFieldClass,
  composerIconButtonClass,
  useComposerAutosize,
  type ComposerFieldSegment,
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
import { PLANS } from "@/lib/plans";
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
import { duration, reducedVariants, variants } from "@/lib/motion";
import { cn } from "@/lib/utils";
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
  /** The plan grants no messages at all, rather than having exhausted them. */
  planIncludesNoMessages?: boolean;
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
  | { kind: "mention"; items: SlashCommand[] }
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
// Mirrors COMPOSIO_APP_PREFIX in lib/composio, which pulls in prisma and so
// cannot be imported from a client component.
const COMPOSIO_ID_PREFIX = "composio:";

/** The token an app answers to after "@": "composio:googlecalendar" → "googlecalendar". */
const connectorKey = (id: string) =>
  (id.startsWith(COMPOSIO_ID_PREFIX)
    ? id.slice(COMPOSIO_ID_PREFIX.length)
    : id
  ).toLowerCase();

/**
 * What an app is called INSIDE a draft: "@GitHub", "@AppleCalendar".
 *
 * The app's own label closed up into one word, not `connectorKey` — the key is
 * an id (`googlecalendar`, `composio:` stripped) and this is a word in a
 * sentence the reader is writing. Both still MATCH, below; only one is
 * written.
 *
 * EVERY non-word character goes, not just spaces, because the tokenizer's
 * `[A-Za-z0-9_-]+` would stop at the first one: an app called "X.com" written
 * as "@X.com" would match as "@X", find nothing, and draw as plain text. What
 * is written has to be what can be read back.
 */
const mentionText = (label: string) => `@${label.replace(/[^\w]/g, "")}`;

/**
 * Split a draft into plain runs and the apps it mentions.
 *
 * `lookup` holds only the apps that are actually attached to this chat, so the
 * paint follows the state: detach GitHub and the "@GitHub" you typed stays in
 * the sentence as the eight characters it always was. A mention must start a
 * word — "foo@github" is an email address, not a mention.
 *
 * The plain runs are returned verbatim, including their whitespace, because
 * the mirror has to reproduce the string EXACTLY or the caret drifts.
 */
function draftSegments(
  text: string,
  lookup: Map<string, { id: string; label: string }>,
): ComposerFieldSegment[] {
  if (!text || lookup.size === 0) return [{ kind: "text", value: text }];
  const out: ComposerFieldSegment[] = [];
  const re = /@([A-Za-z0-9_-]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text[m.index - 1];
    if (before !== undefined && /[\w@]/.test(before)) continue;
    const hit = lookup.get(m[1].toLowerCase());
    if (!hit) continue;
    if (m.index > last) out.push({ kind: "text", value: text.slice(last, m.index) });
    out.push({
      kind: "mention",
      value: m[1],
      icon: <ConnectorMark id={hit.id} />,
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}

// Prefix match only, exactly as the slash list has always filtered — `match`
// widens connector rows without changing how commands behave.
const filterRows = (rows: SlashCommand[], query: string) =>
  query
    ? rows.filter(
        (row) =>
          row.key.startsWith(query) || (row.match?.includes(query) ?? false),
      )
    : rows;

// Selection is carried by the neutral accent fill + a coral hairline, never a
// coral wash: the mouse moves the cursor here, so a filled coral row would read
// as a hover colour rather than as "this is what Enter picks". The fill
// cross-fades between rows on --dur-fast as the cursor moves.
//
// `rounded-control`, by the same arithmetic DropdownMenuItem documents: the
// palette shell is a 16px `rounded-popover` with p-1.5, so 16 − 6 leaves 10px
// for the rows. At rounded-md these were drawn 2px too round for their shell —
// and 2px rounder than the + menu's rows one trigger to the left, which are the
// same object.
const paletteRowClass = (selected: boolean) =>
  cn(
    // `px-2.5` inside the list's `p-1.5` puts the glyph on 16 and `gap-2.5`
    // carries the label to 46 — the shell's grid, shared with ⌘K and the
    // sidebar behind it.
    // No `motion-reduce:transition-none`: the fill and the hairline are a
    // tonal cross-fade, not travel, and reduced motion keeps fades on their
    // timing (ICONS_AND_MOTION.md §2.2, rule 10).
    "flex w-full cursor-pointer select-none items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-body transition-[background-color,box-shadow] duration-fast ease-out-soft",
    selected
      ? "bg-accent ring-1 ring-inset ring-primary/20"
      : "hover:bg-accent/50",
  );

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
    if (style.overflowY !== "visible" || style.overflowX !== "visible")
      out.push(node);
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
function PaletteEyebrow({
  label,
  counter,
}: {
  label: string;
  counter?: string;
}) {
  return (
    <div
      aria-hidden
      className="flex items-baseline justify-between gap-2 px-2.5 pb-1 pt-1.5"
    >
      {/* The command palette's group-heading voice, not a mono eyebrow. Both
          are filtered, arrow-driven lists and the codebase calls them "one
          vocabulary"; mono is the machine voice a settings page heads its
          groups with, and these head a list of the reader's own skills and
          connectors. The counter beside it stays mono, because a count IS
          machine metadata and tabular figures are why. */}
      <span className="text-ui font-medium text-muted-foreground">
        {label}
      </span>
      {counter && (
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {counter}
        </span>
      )}
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
 * The palette's floating shell, kept mounted through its exit.
 *
 * It arrives the way every floating layer does (the `pop` pair: 4px toward
 * the anchor and 0.96, in on the spring curve) and now leaves the same way,
 * faster and on the accelerate curve, instead of vanishing in a frame when
 * the token is completed, dismissed or stops matching.
 *
 * It sits under an `AnimatePresence` with ONE fixed key, which is what keeps
 * the listbox id and `paletteListRef` honest: a palette reopened while the
 * old one is still leaving is the same element turning back, not a second
 * copy beside it, so there is never a duplicate `composer-palette-listbox`,
 * and the ref only goes to null when the one element really unmounts (the
 * measuring effect reads it only while the palette is open anyway).
 *
 * While leaving it renders the rows it last showed, which is the point, and
 * it is `inert` and `aria-hidden` with no pointer events: the field already
 * reports it collapsed (`aria-expanded` false, no active descendant), and a
 * row caught by a click mid-fade must not fire.
 *
 * Reduced motion: the travel and scale drop out and the fade keeps its timing.
 */
function PaletteLayer({ children }: { children: React.ReactNode }) {
  const isPresent = useIsPresent();
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.div
      variants={reduce ? reducedVariants.pop : variants.pop}
      initial="hidden"
      animate="visible"
      exit="exit"
      inert={!isPresent}
      aria-hidden={isPresent ? undefined : true}
      // `.surface-float` draws the throw (no `shadow-*` beside it, or the
      // utility would replace it). origin-bottom rather than .origin-popper:
      // this is pinned to the composer's top edge, not Radix popper content,
      // so the pop scales out of that edge. `z-popper`, the named rung every
      // floating list in the product stacks on.
      className={cn(
        "surface-float overlay-glass absolute bottom-full left-2 right-2 z-popper mb-2 origin-bottom overflow-hidden rounded-popover p-1.5",
        !isPresent && "pointer-events-none",
      )}
    >
      {children}
    </motion.div>
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

export function Composer({
  initialResearch = false,
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
  voiceCall,
  quotaReached,
  planIncludesNoMessages,
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
      if (research && researchAvailable) return { deepResearch: true, researchEffort, ...armed };
      return armed ?? undefined;
    },
    [research, researchAvailable, researchEffort, skillArmed, skillSlug],
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
            : "Message Juno…"));
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
  /* id → label, for the apps "@" can actually switch on. A row for an app that
     is not linked yet goes to Connections instead of writing a word into the
     draft, so only linked apps are here. */
  const connectorLabels = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const connector of connectors) map.set(connector.id, connector.label);
    return map;
  }, [connectors]);
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
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  /*
   * ── The field tier's three pieces of bookkeeping ──────────────────────────
   *
   * `caret` is what lets "@" open its palette in the middle of a sentence
   * rather than only at character zero — see `mentionAt`. It is read off the
   * textarea on every change and every selection move, which is the only place
   * the truth lives.
   *
   * `leadWidth` is how wide the armed marks drawn over the start of the field
   * are; it becomes the textarea's `text-indent`, so the first word lands
   * after them. Measured, never assumed: the marks hold a connector's label.
   *
   * `mirrorRef` / `leadRef` are written to directly while the draft scrolls,
   * because doing it through state would re-render this component on every
   * frame of a scroll.
   */
  const [caret, setCaret] = React.useState(0);
  const [leadWidth, setLeadWidth] = React.useState(0);
  const mirrorRef = React.useRef<HTMLDivElement>(null);
  const leadRef = React.useRef<HTMLSpanElement>(null);
  const onFieldScroll = React.useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const top = e.currentTarget.scrollTop;
    if (mirrorRef.current) mirrorRef.current.scrollTop = top;
    if (leadRef.current) leadRef.current.style.transform = `translateY(${-top}px)`;
  }, []);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const paletteAnchorRef = React.useRef<HTMLDivElement>(null);
  const paletteListRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
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

  // The other half of that conversation: the starter chips step aside while
  // there is a draft (starter-chips.tsx). Typing reaches them as a native
  // `input` event, but a seed, dictation or the clear after a send writes
  // `text` without one, so the draft announces its emptiness here, once per
  // flip rather than per keystroke. `/\S/` rather than `trim()` because it
  // stops at the first non-space character instead of copying the whole
  // draft, and a pasted curriculum is 50k of them.
  const draftEmpty = !/\S/.test(text);
  React.useEffect(() => {
    window.dispatchEvent(new CustomEvent("juno:composer-draft", { detail: { empty: draftEmpty } }));
  }, [draftEmpty]);

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
        options={effortOptions}
        value={reasoningEffort}
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
      });
      if (result && result.accepted === false) return;
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
        setSkillSlug(null);
        clear();
        onClearQuote?.();
        requestAnimationFrame(autoresize);
      })();
    },
    [
      text,
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
    ],
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
        hint: "Let Juno search the web",
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
              run: () => setResearch((v) => !v),
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
      webSearchEnabled,
      onToggleWebSearch,
      researchAvailable,
      research,
      onOpenVoiceMode,
      router,
      skillsAvailable,
      skillLibrary,
      skillSlug,
    ],
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
        note: canWebSearch
          ? undefined
          : modality === "chat"
            ? "not on this model"
            : "chat only",
        run: canWebSearch
          ? () => onToggleWebSearch?.(!webSearchEnabled)
          : () =>
              toast.error(
                `Web search isn’t available ${modality === "chat" ? "on this model" : "for this modality"}.`,
              ),
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
              on: research,
              run: researchAvailable
                ? () => setResearch((v) => !v)
                : () =>
                    toast.error("Research is available on paid plans."),
            },
          ]
        : []),
      {
        id: "tool:memory",
        key: "memory",
        label: "@memory",
        hint: "Remember things across chats",
        group: "tools",
        icon: ComposerIcons.memory,
        on: settings.memoryEnabled,
        run: () => toggleMemory(!settings.memoryEnabled),
      },
      // No "@python" row: the sandbox is always on, and a switch that cannot
      // be switched was the one fake control in this list.
      {
        id: "tool:assistants",
        key: "assistants",
        label: "@assistants",
        hint: "Browse & switch Juno Assistants",
        group: "navigate",
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
          on: connector.connected
            ? connectorsEnabled.includes(connector.id)
            : undefined,
          note: connector.connected ? undefined : "not connected",
          // Not connected is not a failure — it's a missing setup step, so say
          // what's wrong and go to the one place that can fix it.
          run: connector.connected
            ? () => pickConnector(connector.id)
            : () => {
                toast.info(
                  `${connector.label} isn’t connected yet. Opening Connections.`,
                );
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
    research,
    settings.memoryEnabled,
    toggleMemory,
    showConnectors,
    allConnectors,
    connectorsEnabled,
    pickConnector,
    router,
  ]);

  /**
   * The "@" fragment the caret is sitting in the middle of, if any.
   *
   * "@" USED TO BE ANCHORED AT CHARACTER ZERO, like "/", and the two are not
   * the same kind of thing. "/" is a command: it takes the whole line, it is
   * the first thing you type, and there is nothing else in the draft when you
   * type it. "@" names something INSIDE a sentence — "look on my @GitHub and
   * push the branch" — which is the only way anyone has ever written a
   * mention, in any product that has them. Anchored at zero it could not be
   * written at all: the palette simply never opened, so the feature existed
   * only for a draft you had not started.
   *
   * A mention starts a word, so the fragment has to be preceded by the start
   * of the draft or by whitespace — otherwise every email address in a pasted
   * paragraph opens a connector list.
   */
  const mentionAt = React.useMemo(() => {
    const head = text.slice(0, caret);
    const m = head.match(/(?:^|\s)@([\w-]*)$/);
    if (!m) return null;
    return { start: caret - m[1].length - 1, end: caret, query: m[1] };
  }, [text, caret]);

  // Both triggers close on any character the token can't contain — typing a
  // space is how you get a literal "@" or "/". "/" is anchored at the start of
  // the draft; "@" is anchored at the caret (see `mentionAt`).
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
    if (mentionAt) {
      const items = filterRows(mentions, mentionAt.query.toLowerCase());
      return items.length ? { kind: "mention", items } : null;
    }
    return null;
  }, [text, models, commands, mentions, mentionAt]);

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
        ceiling = Math.max(
          ceiling,
          clipper.getBoundingClientRect().top + clipper.clientTop,
        );
      }
      const room =
        anchor.getBoundingClientRect().top - ceiling - PALETTE_CHROME;
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
    if (!text.startsWith("/") && !text.startsWith("@"))
      setSlashDismissed(false);
  }, [text]);

  /**
   * Put the caret at `at` and give the field back the focus.
   *
   * A palette row is a mouse target as well as a keyboard one, so a click has
   * taken focus out of the textarea by the time this runs — without the
   * `focus()` the next keystroke goes nowhere, which is the bug people
   * describe as "it ate my typing".
   */
  const restoreCaret = React.useCallback((at: number) => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
      setCaret(at);
      autoresize();
    });
  }, [autoresize]);

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
    /*
     * A MENTION IS EDITED IN PLACE; IT DOES NOT TAKE THE DRAFT WITH IT.
     *
     * Every row here used to end in `setText("")` — so picking GitHub out of
     * the "@" list deleted the sentence you were writing it into. That was
     * survivable only because "@" could not be typed past character zero,
     * which is to say the feature was safe because it was unreachable.
     *
     * An app becomes WORDS: the fragment you typed is replaced by "@GitHub"
     * and a space, so the mention is in the clause it qualifies and the mirror
     * draws it there with the app's own logo. A tool (research, web, memory)
     * becomes a MARK at the head of the field instead — "@research" is not
     * English in the middle of a request — so its fragment is simply removed.
     */
    if (mentionAt && slash?.kind === "mention") {
      const connector = "connectorId" in item ? item.connectorId : undefined;
      const before = text.slice(0, mentionAt.start);
      const after = text.slice(mentionAt.end);
      const label = connector ? connectorLabels.get(connector) : undefined;
      // The space is what ends the mention, so it is only owed when the draft
      // does not already carry one — inserting into "… @gi| and push" must not
      // leave two.
      const gap = /^\s/.test(after) ? "" : " ";
      const insert = label ? `${mentionText(label)}${gap}` : "";
      item.run?.();
      setDraftText(before + insert + after);
      restoreCaret(before.length + insert.length);
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
    async (signal?: AbortSignal) => {
      if (privateMode || !onToggleConnector) return;
      setConnectorsLoading(true);
      setConnectorsFailed(false);
      try {
        const response = await fetch("/api/connectors", { signal });
        if (!response.ok) return;
        const data = (await response.json()) as {
          connectors?: {
            id: string;
            label: string;
            connected: boolean;
            configured?: boolean;
          }[];
        };
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
        if (!(error instanceof DOMException && error.name === "AbortError")) {
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
    void refreshConnectors(controller.signal);
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

  /*
   * ── What the draft itself says ────────────────────────────────────────────
   *
   * An app attached to this chat can be named INSIDE the sentence — "look on
   * my @GitHub and …" — which is where "@" put it, and where it belongs: it
   * qualifies that clause, not the whole message. `lookup` answers both the
   * word the reader typed (`@GitHub`) and the app's id (`@github`), because
   * "@" offers the id and prose wants the label.
   */
  const mentionLookup = React.useMemo(() => {
    const map = new Map<string, { id: string; label: string }>();
    for (const connector of attachedConnectors) {
      const row = { id: connector.id, label: connector.label };
      map.set(mentionText(connector.label).slice(1).toLowerCase(), row);
      map.set(connectorKey(connector.id), row);
    }
    return map;
  }, [attachedConnectors]);
  const draft = React.useMemo(() => draftSegments(text, mentionLookup), [text, mentionLookup]);
  /* Which apps the sentence already names. They are drawn there and must not
     ALSO be drawn as a mark at the head of the field — one state, one mark. */
  const mentionedConnectorIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const segment of draft) {
      if (segment.kind !== "mention") continue;
      const hit = mentionLookup.get(segment.value.toLowerCase());
      if (hit) ids.add(hit.id);
    }
    return ids;
  }, [draft, mentionLookup]);
  /* The mirror only paints while it has something the textarea cannot draw. */
  const mirrored = mentionedConnectorIds.size > 0;
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
   * ── What the composer SHOWS is armed ──────────────────────────────────────
   *
   * The same states the summary above names, as objects this time, in one
   * ordered list so the render site is a `.map` rather than five hand-written
   * branches that can each drift. Order is fixed and is the menu's: how this
   * message is answered (a skill, research, web), then what it can reach (the
   * apps). Fixed order matters more than it looks — a list that
   * re-sorted itself as you armed things would move the mark you were about to
   * press out from under the pointer.
   *
   * MEMORY IS DELIBERATELY ABSENT, though the summary counts it. It is an
   * account setting, on by default, that applies to every message in the
   * product — a mark for it would be permanent furniture stating something
   * true of the whole app rather than of this message, and a row where one
   * mark is always lit teaches the reader to stop reading the row.
   */
  const armedMarks: ArmedMark[] = [
    /* The skill, first among the "how this is answered" marks, because it is
       the one that changes the method rather than the reach. An untrusted
       skill says so on the mark: it is the fact that decides how its
       instructions reach the model, and the reader deserves to see it at the
       moment they send rather than only on the skill's page. */
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
          label: "Research",
          // No depth word: Research sizes itself, and a level name told people
          // to pick a model to get a "deeper" run it did not give them.
          tooltip: <>Plans, reads the web and writes a cited report. Usually 5–15 minutes.</>,
          openLabel: "Research on. Opens the add menu.",
          removeLabel: "Turn off research",
          remove: () => setResearch(false),
        }]
      : []),
    ...(canWebSearch && webSearchEnabled
      ? [{
          id: "web",
          icon: <ComposerIcons.web className="size-4" />,
          label: "Web search",
          openLabel: "Web search is on for this chat. Opens the add menu.",
          removeLabel: "Turn off web search",
          remove: () => onToggleWebSearch?.(false),
        }]
      : []),
    /* Each connected app under its OWN logo — a GitHub mark says "GitHub"
       faster than the word does, and an app with no drawing falls back to the
       same plug the Connections destination uses. `pickConnector`, not
       `onToggleConnector`: the per-chat cap is a rule about connectors, not
       about one menu. */
    ...(showConnectors
      ? attachedConnectors
          .filter((connector) => !mentionedConnectorIds.has(connector.id))
          .map((connector) => ({
          id: `connector:${connector.id}`,
          icon: <ConnectorMark id={connector.id} className="size-4" />,
          label: connector.label,
          openLabel: `${connector.label} is attached to this chat. Opens the add menu.`,
          removeLabel: `Detach ${connector.label}`,
          remove: () => pickConnector(connector.id),
        }))
      : []),
  ];
  /**
   * TWO, THEN A COUNT.
   *
   * The worst case is eight marks: a skill, deep research, web search and five
   * connectors. The marks now sit in the FIELD, at the
   * draft's own 16px, and every pixel they take is a pixel the sentence starts
   * further in — so the number that fits is smaller here than it would be on
   * the controls row, not larger. Two named marks and a count is ~380px of a
   * 760px composer; a third would leave less room for the prompt than for the
   * things qualifying it.
   *
   * Most drafts never reach two. An app named in the sentence is drawn THERE
   * and is not a mark at all (`mentionedConnectorIds`), so this list is a
   * skill, research, web search, and whatever was armed from the `+` menu
   * without being mentioned.
   *
   * The tail collapses into one mark that names the rest in its tooltip and
   * opens the menu where they are changed; pressing its ✕ clears exactly the
   * states it stands for.
   */
  const ARMED_MARK_LIMIT = 2;
  const shownArmedMarks = armedMarks.slice(0, ARMED_MARK_LIMIT);
  const restArmedMarks = armedMarks.slice(ARMED_MARK_LIMIT);
  /*
   * Two marks with words is ~260px, and a phone composer is 350 wide — which
   * would leave the sentence a third of its own line. Below a 30rem COMPOSER
   * (not window; the composer is the `@container`, see composer-shell.tsx) the
   * marks keep their icons and drop their words.
   *
   * ONE mark always keeps its words, because one mark has never been the
   * problem: a lone telescope at the head of a field says nothing, where "Deep
   * research" says all of it. What that case gives up instead is the `detail`
   * — which the mark drops at this width on its own, at every count. The count
   * mark is exempt at every width and in both directions: its label IS its
   * information, and "⋯" alone says nothing at all.
   *
   * A literal, not a computed string: Tailwind scans source text, so a class
   * assembled at runtime would never be generated.
   */
  const armedLabelClass = armedMarks.length > 1 ? "hidden @[30rem]:inline" : undefined;

  /**
   * The marks, drawn into the head of the draft (`ComposerFieldLead`).
   *
   * They are built here rather than in the JSX below because the field slot is
   * three layers deep and the one thing it must not also be is the place this
   * list is decided.
   */
  /*
   * The indent the two layers below the marks owe them — and ZERO the moment
   * the marks are gone. `leadWidth` is the last measurement the group made;
   * reading it directly would leave a 180px hole at the head of the field
   * after the last mark was disarmed, because nothing re-measures a group that
   * has unmounted.
   */
  const leadMarks = [
    ...shownArmedMarks.map((mark) => (
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
    )),
    ...(restArmedMarks.length > 0
      ? [
          <ComposerArmedMark
            key="more"
            /* The overflow glyph, not a `+`: a plus in this composer means
               "add something" — it is the button to the left — and this mark
               removes rather than adds. */
            icon={<ActionIcons.more className="size-4" />}
            label={`${restArmedMarks.length} more`}
            /* `shrink-0`, and no container query: this label IS the
               information — "⋯" alone says nothing, and "2 mo…" says it
               wrong. */
            labelClassName="shrink-0"
            tooltip={restArmedMarks.map((mark) => mark.label).join(", ")}
            onOpen={() => setPlusOpen(true)}
            onRemove={() => restArmedMarks.forEach((mark) => mark.remove())}
            openLabel={`Also on for this message: ${restArmedMarks.map((mark) => mark.label).join(", ")}. Opens the add menu.`}
            removeLabel={`Turn off ${restArmedMarks.map((mark) => mark.label).join(", ")}`}
            disabled={controlsLocked}
          />,
        ]
      : []),
  ];
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
      <PlusMenuRow
        selected={!selectedProjectId}
        icon={AppIcons.projects}
        onSelect={() => onPickProject?.(null)}
      >
        No project
      </PlusMenuRow>
      <PlusMenuSeparator />
      <ScrollFade className="min-h-0 flex-1" viewportClassName="max-h-64">
        {loadingProjects && projects.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          </div>
        ) : projects.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-caption text-muted-foreground">
            No projects yet.
          </p>
        ) : (
          projects.map((project) => (
            <PlusMenuRow
              key={project.id}
              selected={selectedProjectId === project.id}
              icon={AppIcons.projects}
              onSelect={() => onPickProject?.(project.id)}
            >
              {project.name}
            </PlusMenuRow>
          ))
        )}
      </ScrollFade>
      <PlusMenuSeparator />
      <PlusMenuRow
        icon={Plus}
        disabled={creatingProject}
        onSelect={() => void createProjectAndPick()}
        className="text-primary"
      >
        {creatingProject ? "Creating…" : "New project"}
      </PlusMenuRow>
    </>
  );

  const connectorsPanel = () => (
    <>
      <div className="px-0.5 pb-1.5 pt-0.5">
        <label className="relative block">
          {/* Raw `Search`: this filters the connector list in place.
              `AppIcons.search` is the app's search destination, which this
              never opens. Key events stay in the field — the menu's typeahead
              and arrow handling must not see them. */}
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={connectorQuery}
            onChange={(event) => setConnectorQuery(event.target.value)}
            // ArrowUp passes through too. The list was reachable with
            // ArrowDown and then had no way back out of it: every other key was
            // stopped here, so ArrowUp from the first row died in the input and
            // the flyout became a one-way trip for a keyboard user. Character
            // keys are still stopped, or the menu's typeahead would fight the
            // field for every letter typed into it.
            onKeyDown={(event) => { if (!["Escape", "ArrowDown", "ArrowUp", "Tab"].includes(event.key)) event.stopPropagation(); }}
            placeholder="Search apps…"
            aria-label="Search apps"
            autoFocus
            className="surface-inset h-8 w-full rounded-control border border-input pl-8 pr-2 text-ui outline-none transition-[border-color] duration-fast ease-out-soft placeholder:text-muted-foreground focus:border-foreground/60"
          />
        </label>
      </div>
      <div className="max-h-56 overflow-y-auto overscroll-contain">
        {connectorsLoading && connectors.length === 0 ? (
          <div className="flex flex-col gap-1 p-1">
            {[0, 1, 2].map((row) => (
              <span key={row} className="skeleton h-9 rounded-control" />
            ))}
          </div>
        ) : connectorsFailed && connectors.length === 0 ? (
          <div className="px-2.5 py-3 text-center">
            <p className="text-caption text-muted-foreground">Couldn’t load your apps.</p>
            <button
              type="button"
              onClick={() => void refreshConnectors()}
              className="mt-1 text-caption font-medium text-primary underline-offset-2 hover:underline"
            >
              Try again
            </button>
          </div>
        ) : connectors.length === 0 ? (
          <PlusMenuRow icon={AppIcons.connections} onSelect={() => router.push("/connections")}>
            Connect an app
          </PlusMenuRow>
        ) : visibleConnectors.length === 0 ? (
          <p className="px-2.5 py-3 text-center text-caption text-muted-foreground">
            No apps match “{connectorQuery.trim()}”.
          </p>
        ) : (
          visibleConnectors.map((connector) => (
            <PlusMenuRow
              key={connector.id}
              checked={connectorsEnabled.includes(connector.id)}
              onSelect={() => pickConnector(connector.id)}
              leading={
                <ConnectorMark id={connector.id} className="size-4 shrink-0 text-foreground" />
              }
            >
              {connector.label}
            </PlusMenuRow>
          ))
        )}
      </div>
      {connectors.length > 0 && (
        <>
          <PlusMenuSeparator />
          <PlusMenuRow
            icon={AppIcons.connections}
            detail={`${activeConnectorCount} of ${MAX_CHAT_CONNECTORS} on`}
            onSelect={() => router.push("/connections")}
          >
            Manage connections
          </PlusMenuRow>
        </>
      )}
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
        label: "Use a skill",
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
          label: "Research",
          icon: ComposerIcons.research,
          checked: research,
          onToggle: () => setResearch((on) => !on),
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
            label: voiceCanSeeImages ? "Add files or photos" : "Add files",
            icon: ComposerIcons.attach,
            detail: attachShortcut,
            disabled: !canAttach,
            note: attachNote,
            onSelect: () => fileInputRef.current?.click(),
          },
          {
            kind: "action",
            id: "library",
            label: "Add from library",
            icon: AppIcons.library,
            disabled: !canAttach,
            note: attachNote,
            onSelect: () => setLibraryOpen(true),
          },
        ],
        researchRow ? [researchRow] : [],
      ]
    : [
        // Bring something in. "Attach files" and "Photos" used to be two rows
        // for one job: ACCEPT_ATTRIBUTE (lib/uploads.ts) already carries every
        // image mime, so one sheet has always offered both. The merged row is
        // also the only place in the product that teaches ⌘U.
        [
          {
            kind: "action",
            id: "files",
            label: "Add files or photos",
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
            id: "library",
            label: "Add from library",
            icon: AppIcons.library,
            disabled: !canAttach,
            note: attachNote,
            onSelect: () => setLibraryOpen(true),
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
                  label: "Connectors",
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
        // Armed for this message. Canvas is not here and has no row anywhere:
        // whether an answer belongs in an artifact is the model's decision now
        // (src/lib/chat/system-prompt.ts), so there is nothing for a user to
        // switch and nothing that can be left switched off by accident.
        [
          // First in the group: a skill decides HOW the answer is made, which
          // the rows under it then modify. It is also the only row here that
          // can carry somebody else's instructions, and burying it under three
          // toggles is how a reader stops noticing which one is lit.
          ...(skillRow ? [skillRow] : []),
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
            label: "Memory",
            icon: ComposerIcons.memory,
            checked: settings.memoryEnabled,
            onToggle: () => toggleMemory(!settings.memoryEnabled),
          },
        ],
      ];

  return (
    <div
      ref={rootRef}
      className={cn(
        "w-full",
        frame === "dock" && "page-gutter mx-auto max-w-3xl",
        // With a footnote the line takes the inset's 16 / 24px itself (see
        // the slot below), so only the home indicator stays as padding.
        frame === "dock" &&
          (dockFootnote
            ? "pb-[env(safe-area-inset-bottom)]"
            : "pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-[calc(1.5rem+env(safe-area-inset-bottom))]"),
        // The dock's content width (48rem less a gutter each side), read from
        // the gutter the landing column already applies. See the prop.
        frame === "landing" && "mx-auto max-w-[calc(48rem-2*var(--page-gutter,0px))]"
      )}
    >
      {quotaReached && (
        <div
          role="status"
          className="mb-2 rounded-control border border-primary/30 bg-primary/5 px-3 py-2 text-center text-ui text-foreground"
        >
          {planIncludesNoMessages ? (
            <>
              The Free plan doesn&apos;t include any messages.{" "}
              <a
                href="/upgrade"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                Upgrade to start chatting
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
      {selectedProject && !privateMode && !conversationId && (
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
          // The palette's containing block: it carries `relative`, so this — not
          // the surface — is what its `bottom-full` resolves against, and so this
          // is the top edge the room above it must be measured from.
          fieldTierRef={paletteAnchorRef}
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
              <ComposerAttachmentRow uploads={uploads} onRemove={remove} />
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

            {/* Matches the DropdownMenu/Popover surface exactly — this is the same
            kind of object as the + menu and shouldn't read as its own species.
            `PaletteLayer` carries the shell and its enter/exit pair; the one
            fixed key is what lets it leave without a second copy ever sharing
            the listbox id (see its note). */}
            <AnimatePresence>
            {slashOpen && slash && (
              <PaletteLayer key="composer-palette">
                {/* Options, not tab stops: the caret never leaves the textarea, so this
                is a combobox popup, and each row's state is its `aria-checked`
                rather than a control of its own. */}
                <div
                  ref={paletteListRef}
                  id="composer-palette-listbox"
                  role="listbox"
                  aria-label={
                    slash.kind === "model"
                      ? "Switch model"
                      : slash.kind === "mention"
                        ? "Tools and connectors"
                        : "Commands"
                  }
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
                          // The arrow-key cursor plays the glyph's hover
                          // gesture, as a Radix menu's highlighted row does.
                          data-highlighted={i === slashIndex ? "" : undefined}
                          onMouseEnter={() => setSlashIndex(i)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => applySlash(m)}
                          className={paletteRowClass(i === slashIndex)}
                        >
                          <PaletteIcon>
                            <ProviderLogo
                              provider={m.provider}
                              className="size-4"
                            />
                          </PaletteIcon>
                          <span className="min-w-0 flex-1 truncate text-ui font-medium">
                            {m.name}
                          </span>
                          <span className="shrink-0 text-caption text-muted-foreground">
                            {PROVIDERS[m.provider].label.split(" · ")[0]}
                          </span>
                          {m.id === model && (
                            <StatusIcons.success aria-hidden className="size-3.5 shrink-0 text-primary" />
                          )}
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
                          counter={
                            group === "connectors"
                              ? `${activeConnectorCount}/${MAX_CHAT_CONNECTORS}`
                              : undefined
                          }
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
                              // the tool's own state. The tick that draws it is
                              // aria-hidden, so without this the state is visual only.
                              aria-checked={item.on}
                              data-highlighted={selected ? "" : undefined}
                              onMouseEnter={() => setSlashIndex(index)}
                              // Keeps the caret (and the draft's selection) in the
                              // textarea when a row is picked with the mouse.
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => applySlash(item)}
                              className={paletteRowClass(selected)}
                            >
                              <PaletteIcon>
                                {item.connectorId ? (
                                  <ConnectorMark
                                    id={item.connectorId}
                                    className="size-4 text-foreground"
                                  />
                                ) : Icon ? (
                                  // Coral marks a tool that is ON — the one state worth
                                  // colouring. Selection is the ring, not the colour;
                                  // an off tool's mark is muted at rest and takes the
                                  // row's ink under the cursor.
                                  <Icon
                                    aria-hidden
                                    className={cn(
                                      "size-4",
                                      item.on
                                        ? "text-primary"
                                        : selected
                                          ? "text-foreground"
                                          : "text-muted-foreground",
                                    )}
                                  />
                                ) : null}
                              </PaletteIcon>
                              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                                <span className="max-w-[55%] shrink-0 truncate font-mono text-ui">
                                  {item.label}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                                  {item.hint}
                                </span>
                              </span>
                              {(item.note || item.on) && (
                                // One trailing slot, note then tick, so an armed
                                // skill keeps its source beside the mark. No
                                // other row carries both: a row with a note
                                // ("not connected") has no state to show.
                                <span className="flex shrink-0 items-center gap-1.5">
                                  {item.note && (
                                    <span className="whitespace-nowrap text-caption text-muted-foreground">
                                      {item.note}
                                    </span>
                                  )}
                                  {item.on && (
                                    // The same tick the + menu draws, for the same
                                    // rows. These two surfaces are deliberately one
                                    // vocabulary; they drifted once before, when one
                                    // hand-rolled a track and the other rendered the
                                    // real Switch, and the fix was to make them agree.
                                    <StatusIcons.success
                                      aria-hidden
                                      className="size-3.5 shrink-0 text-primary"
                                    />
                                  )}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>
              </PaletteLayer>
            )}
            </AnimatePresence>

            {/* Huge drafts render as a compact card above; keep the textarea out of
            the DOM so React never diffs multi-10k controlled values every key. */}
            </>
          }
          field={
            !showCollapsedDraft && (
              /*
               * ── THE FIELD TIER, THREE LAYERS DEEP ────────────────────────
               *
               * Bottom: the mirror, which paints the draft a second time so an
               * app the sentence mentions can carry its logo. It only paints
               * text while there IS such a mention; the rest of the time the
               * textarea draws its own, exactly as it always has.
               *
               * Middle: the textarea. It keeps the caret, the selection, IME
               * composition, undo and the native mobile keyboard — everything
               * a rich-text rewrite of this control would have had to
               * reimplement and get wrong.
               *
               * Top: the armed marks, laid into the start of the draft, with
               * `text-indent` on the two layers below reserving exactly their
               * width. They are the only part of this stack that takes a
               * click.
               */
              <div className="relative">
                {mirrored && (
                  <ComposerFieldMirror segments={draft} indent={leadIndent} viewportRef={mirrorRef} />
                )}
                <textarea
                  ref={textareaRef}
                  id={CHAT_COMPOSER_FIELD_ID}
                  aria-label={
                    steerMode && steering
                      ? steering.placeholder
                      : placeholder || "Ask Juno"
                  }
                  value={text}
                  onChange={(e) => {
                    setDraftText(e.target.value);
                    setCaret(e.target.selectionStart ?? e.target.value.length);
                  }}
                  // Arrow keys, clicks and drags move the caret without
                  // changing a character, and "@" has to know where it is —
                  // `onSelect` is the one event a textarea fires for all of
                  // them.
                  onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
                  onScroll={onFieldScroll}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                  // Live through a generation: the draft for the next message is
                  // typed while the reply streams (see `sendBlocked`). Only a hard
                  // send lock and the pre-flight check take the field away.
                  disabled={sendLocked || status === "checking"}
                  rows={1}
                  /*
                   * NO PLACEHOLDER WHILE A MARK IS IN THE LINE. The marks sit
                   * at the head of the field and the placeholder starts after
                   * them, so on a phone "Deep research" and "Message Juno…"
                   * split one line between them and the prompt wraps under its
                   * own hint. The field is still named — `aria-label` above —
                   * and a composer holding an armed tool is not a composer
                   * anyone needs told what to do with.
                   */
                  placeholder={
                    leadMarks.length > 0
                      ? ""
                      : steerMode && steering
                        ? steering.placeholder
                        : placeholder
                  }
                  // The palette is driven from here — focus never moves to it — so the
                  // textarea has to name the row the arrow keys are sitting on, and
                  // aria-controls ties that row's listbox back to this field while it
                  // is showing (activedescendant alone leaves AT to guess which list).
                  //
                  // The three attributes below are what makes that legible rather
                  // than merely present. The field was setting `aria-controls` and
                  // `aria-activedescendant` on a PLAIN TEXTAREA: an active
                  // descendant pointing into a list that, as far as assistive
                  // technology was concerned, did not exist and had never opened.
                  // Typing "/" announced nothing, and the first arrow key moved a
                  // selection the user had not been told about. A combobox that
                  // reports whether it is expanded is the difference between a
                  // palette and a trap.
                  role="combobox"
                  aria-expanded={slashOpen}
                  aria-autocomplete="list"
                  aria-haspopup="listbox"
                  aria-controls={
                    slashOpen ? "composer-palette-listbox" : undefined
                  }
                  aria-activedescendant={
                    slashOpen && slash
                      ? `composer-palette-${Math.min(slashIndex, slash.items.length - 1)}`
                      : undefined
                  }
                  // 16px in EVERY state, and composerFieldClass is the only thing
                  // that sets it: iOS Safari zooms the whole page into a focused
                  // field below 16px and does not zoom back out on blur. The
                  // clarification and expanded-huge-draft states used to step
                  // down to the body rung right here — which re-opened exactly
                  // the zoom the base class exists to prevent, on the two states
                  // where the field is longest. Their density comes from
                  // useComposerAutosize's maxLines / maxHeight instead.
                  className={cn(
                    composerFieldClass,
                    // Hands the text to the mirror behind, and takes the caret
                    // and the selection colour back — see globals.css. Only
                    // while there is something the textarea cannot draw.
                    mirrored && "composer-field--mirrored no-scrollbar",
                  )}
                  // The marks drawn over the head of the field, as a hole in
                  // the first line. `text-indent` is the only property that
                  // indents one line rather than a block, which is exactly the
                  // shape of what is being reserved.
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
                label={armedSummary ? `Add: ${armedSummary}` : "Add"}
                tooltip={armedSummary ? `Add: ${armedSummary}` : "Add files, tools and context"}
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
                      <Mic className="size-4" />
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
        </div>
      </DictationSwap>
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
