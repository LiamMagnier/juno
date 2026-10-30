"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ChevronLeft, ChevronRight, CornerDownRight, GitBranch, GitFork, Link2, Loader2, ListMinus, ListPlus, Square, TextQuote, Volume2 } from "@/components/ui/icons";
import { ExportChatMenuSection } from "@/components/chat/conversation-export-menu";
import { ActionIcons, AppIcons, SettingsIcons, StatusIcons } from "@/lib/app-icons";
import { extractSkillMarkdown, PENDING_SKILL_MARKDOWN_KEY } from "@/components/skills/skill-library-model";
import { IconSwap } from "@/components/ui/icon-swap";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
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
import { MENU_W } from "@/components/ui/menu-recipe";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { useApp } from "@/components/app/app-provider";
import { PROVIDERS } from "@/lib/providers";
import { useComposerAutosize } from "@/components/ui/composer-shell";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { useModifierKeyLabel } from "@/components/ui/platform";
import { StreamingMarkdown } from "@/components/chat/stream-text";
import { LiveUIHostProvider } from "@/components/chat/live-ui/host";
import { AutoReceipt } from "@/components/chat/auto-receipt";
import { AnswerMemory } from "@/components/chat/answer-memory";
import { receiptLine, receiptSummary, type RoutingReceipt } from "@/lib/router/receipt";
import { ArtifactInlineCard } from "@/components/chat/artifact-inline-card";
import { AttachmentTile, MessageAttachments } from "@/components/chat/attachment-tile";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { ActivityTimeline } from "@/components/chat/activity-timeline";
import { MessageFeedback } from "@/components/chat/message-feedback";
import type { FeedbackDetail } from "@/lib/feedback-reasons";
import { codeLiveCopy } from "@/components/code/code-activity";
import { writtenPaths } from "@/lib/chat/tool-receipt";
/**
 * Split: a card that appears only while the tool loop in src/lib/mcp.ts is
 * holding for a decision — `message.approvals?.length` guards it — and 24 kB
 * of source that every other transcript was carrying.
 */
const ApprovalCard = nextDynamic(
  () => import("@/components/chat/approval-card").then((m) => m.ApprovalCard),
  { ssr: false },
);
const AgentChangeCard = nextDynamic(
  () => import("@/components/chat/agent-change-card").then((m) => m.AgentChangeCard),
  { ssr: false },
);
const RoutineProposalList = nextDynamic(
  () => import("@/components/chat/routine-proposal-card").then((m) => m.RoutineProposalList),
  { ssr: false },
);
const SkillDraftList = nextDynamic(
  () => import("@/components/skills/skill-draft-card").then((m) => m.SkillDraftList),
  { ssr: false },
);
import { SourcesPill } from "@/components/chat/sources-pill";
import { isAuditableAnswer, useCitationAudit } from "@/components/chat/citation-audit";

/**
 * Split, and gated on the phase rather than only imported lazily.
 *
 * The panel returns null for `idle` and `none` — which is every answer that is
 * not a checked research report — so rendering it unconditionally behind a
 * dynamic import would fetch the chunk for every message in every transcript
 * to draw nothing. The condition below is exactly the panel's own early
 * return, moved up one level so the import can stay unfetched with it.
 */
const CitationAuditPanel = nextDynamic(
  () => import("@/components/chat/citation-audit-panel").then((m) => m.CitationAuditPanel),
  { ssr: false },
);
import { GenerationPlaceholder } from "@/components/chat/generation-placeholder";
import { GeneratedImage, GeneratedImageGrid, GeneratedVideo, useGenerationHandoff } from "@/components/chat/generated-media";
import { ImageGenerationCard, attachmentsForGeneration, imageGenerationsOf } from "@/components/chat/image-generation-card";
import { shellString } from "@/lib/strings";
import { useUiLocale } from "@/lib/i18n-format";
import { AudioAttachment } from "@/components/chat/audio-attachment";
/**
 * Split: a full-screen editor that mounts only once a reader has pressed Edit
 * on a generated image, and 31 kB of source that every transcript was loading
 * to render nothing. Its render site is already guarded on `editTarget`, so
 * the chunk is fetched by the same press that opens it.
 */
const ImageEditOverlay = nextDynamic(
  () => import("@/components/chat/image-edit-overlay").then((m) => m.ImageEditOverlay),
  { ssr: false },
);
import { LiveLine, useLiveSeconds } from "@/components/chat/live-line";
import { ConnectionStatus } from "@/components/chat/connection-status";
import { TIMING } from "@/lib/interaction";
import { AgentFace } from "@/components/agents/agent-face";
import { useAgentThread } from "@/components/agents/agent-thread-context";
import { splitMessageContent, stripMemoryTags } from "@/lib/message-content";
import { stripTrailingSourcesSection } from "@/components/chat/sources-section";
import { resolveModel } from "@/lib/models";
import { MESSAGE_DISPLAY_COLLAPSE_CHARS, sampleLineCount } from "@/lib/prompt-limits";
import { cn, formatTokens, formatUsd } from "@/lib/utils";
import { ContextReceiptLine, SentContextText } from "@/components/chat/context-receipt";
import type { ContextReceipt } from "@/lib/chat/context-tokens";
import { USER_BUBBLE_CLASS } from "@/components/chat/user-bubble";
import { parseQuotedMessage } from "@/lib/quote-context";
import { QuotedSelection } from "@/components/chat/quoted-selection";
import type { ChatMessage, ImageEditInput, RegenerateOptions, SendResult } from "@/hooks/use-chat";
import type { ClientArtifact, ClientAttachment, ClientMessageVersionDetail, GenerationStatus } from "@/types/chat";
import { resolveArtifactTag } from "@/lib/chat-client-state";
import { cardSuggestion, isTrashed, placeholderCount } from "@/lib/artifact-card-state";

/**
 * The line in the reply slot while the assistant works with nothing visible
 * yet (INTERACTION_SPEC M1): the Continuum mark, the truthful phase in words,
 * and real seconds once the wait passes three. Drawn by `LiveLine`, the one
 * component every live row in the transcript uses (live-line.tsx).
 *
 * The copy is the phase until the wait is long enough to need explaining. The
 * two later rungs say why nothing has happened and that leaving is safe,
 * because on hidden-reasoning models the wait before the first token runs to
 * minutes, and a line that only ever says "Thinking" starts to read as hung.
 */
function StreamStatus({
  status,
  recovering,
  recoveryNote,
  label,
}: {
  status?: GenerationStatus;
  /** A surface's own sentence for the live row, when it knows better than
   *  the generic rungs (a Code run names the command it is on). */
  label?: string;
  /**
   * The stream dropped and the client is polling for the persisted answer.
   *
   * This is NOT thinking, and saying "Thinking" through it is the bug this
   * parameter exists to kill: the connection is already gone, the
   * global status has gone back to idle, the composer is usable again — and the
   * bubble was still counting up a timer as though a model were working. A
   * reader watched that for minutes and reasonably concluded the app was hung.
   */
  recovering?: boolean;
  /** What `beginDropRecovery` already wrote onto the turn, shown verbatim. */
  recoveryNote?: string;
}) {
  // One clock for the whole wait: a phase change is not a new wait.
  const elapsedSec = useLiveSeconds(!recovering);

  const writing = status === "writing";
  const checking = status === "checking";
  const submitting = status === "submitting";
  let statusCopy = "Thinking";
  // Recovery wins over every status rung. The global status is `idle` by this
  // point (the stream ended), so the rungs below would all describe work that
  // is not happening.
  if (recovering) {
    statusCopy = recoveryNote || "Reconnecting…";
  } else if (label) statusCopy = label;
  else if (writing) statusCopy = "Writing";
  else if (checking) statusCopy = "Checking your message";
  else if (submitting) statusCopy = "Sending";
  else if (elapsedSec >= 600) {
    statusCopy = "Still working. You can leave; the answer will be here.";
  } else if (elapsedSec >= 120) {
    statusCopy = "Still thinking. This can take a few minutes.";
  }

  // Only the model reasoning is "thinking"; everything else is work with a
  // name (MOTION_AND_THINKING.md: the mark follows the truthful row).
  const reasoning = !recovering && !label && !writing && !checking && !submitting;
  const showClock = !recovering && !writing && !checking && !submitting;
  // In an agent's thread the agent is the one thinking: its face leads, not
  // the mark, and the sentence names it.
  const agentThread = useAgentThread();
  if (agentThread && !recovering && !label && statusCopy === "Thinking") statusCopy = `${agentThread.name} is thinking`;
  if (agentThread && !recovering && !label && writing) statusCopy = `${agentThread.name} is writing`;

  return (
    <div className="flex min-h-10 items-center py-1.5">
      <LiveLine
        text={statusCopy}
        phase={reasoning ? "thinking" : "working"}
        seconds={showClock ? elapsedSec : null}
        lead={
          agentThread ? (
            <AgentFace avatar={agentThread.avatar} state={recovering ? "blocked" : writing || label || checking ? "working" : "thinking"} size={20} />
          ) : undefined
        }
      />
    </div>
  );
}

// `stripTrailingSourcesSection` (the research report's trailing "## Sources"
// list, dropped once the sources pill shows it) is in sources-section.ts, shared
// with the conversation export.

/**
 * ChatGPT-style "‹ 2/3 ›" pager, shown whenever a message has alternatives: the
 * branches an edit or a regenerate made (`message.branch`, which switch the
 * whole continuation below), or, on a message that has never branched, the
 * older wordings kept before branches existed (`message.versions`, text
 * only). It sits in the action-toolbar row but OUTSIDE the hover-revealed
 * cluster so the existence of history stays discoverable at a glance.
 */
function VersionPager({
  index,
  total,
  loading,
  onStep,
}: {
  index: number;
  total: number;
  loading?: boolean;
  onStep: (dir: -1 | 1) => void;
}) {
  // The arrows sit immediately beside the IconAction cluster in the same
  // toolbar. They used to be 24px, 8px-radius, hover-by-ink-only controls next
  // to 32px, 10px-radius controls that light up — two idioms, one row. Both are
  // bare glyph affordances, so both are `kind="icon"`; `sm` keeps the pager
  // visually subordinate to the actions without inventing a rung. Tooltips
  // because every glyph in this row names itself on hover — the pager was the
  // one pair that stayed mute. (A disabled arrow shows none; Radix cannot hover
  // a pointer-events-none target, and a control that cannot act needs no name.)
  return (
    <div className="mr-1 flex items-center font-mono text-caption text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable kind="icon" size="sm" onClick={() => onStep(-1)} disabled={loading || index === 0} aria-label="Previous version">
            <ChevronLeft className="size-3.5" />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent>Previous version</TooltipContent>
      </Tooltip>
      <span className="min-w-[3ch] text-center tabular-nums" aria-live="polite">
        {index + 1}/{total}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Pressable kind="icon" size="sm" onClick={() => onStep(1)} disabled={loading || index === total - 1} aria-label="Next version">
            <ChevronRight className="size-3.5" />
          </Pressable>
        </TooltipTrigger>
        <TooltipContent>Next version</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * The message toolbar's glyph — seven of these per assistant turn, the most
 * repeated affordance in the product. It was `<Button variant="ghost"
 * size="icon-sm">`, i.e. a 10px-radius square, where pressable.tsx records the
 * house idiom for a bare glyph as a circle. `selected` also gives the toggled
 * state a ground: a thumbs-up that was ON used to differ from one that was OFF
 * by ink alone.
 */
function IconAction({
  label,
  onClick,
  children,
  active,
  busy,
  buttonRef,
  shortcut,
}: {
  label: string;
  /** The chord that does the same thing, printed in the tooltip as a keycap. */
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  /** The button itself, for a caller that has to hand focus back to it. */
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** In flight. Shows a spinner and blocks a second press. */
  busy?: boolean;
  // No celebration here: the thumbs live in message-feedback.tsx, where up
  // swells and down never does.
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          kind="icon"
          size="md"
          selected={active}
          onClick={onClick}
          disabled={busy}
          aria-label={label}
          aria-pressed={active}
          aria-busy={busy || undefined}
          className={cn(active && "text-primary")}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            children
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent className={cn(shortcut && "flex items-center gap-2 pr-1.5")}>
        {label}
        {shortcut && <Kbd className="h-4 min-w-4 px-1">{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The answer's receipt: which model wrote it, how many tokens, what it cost.
 *
 * At the END of the action row, in the metadata voice, and only while the row
 * is being looked at (hover or focus on the turn). It used to live one level
 * down in the More menu, which made "which model answered this?" a two-click
 * question after a mid-thread switch; printing it under every answer at rest
 * would bill the reader per paragraph. Revealed with the pointer, it is there
 * for the person who asks and absent for the one reading.
 *
 * No middle dots between the three: they are spaced as three facts, not
 * punctuated as one sentence. The in/out split is the tooltip.
 */
function TurnMeta({
  modelName,
  receipt,
  promptTokens,
  completionTokens,
  costUsd,
}: {
  modelName: string | null;
  /** Auto's receipt, when Auto routed this turn: the model reads "Auto · model · effort". */
  receipt?: RoutingReceipt | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costUsd?: number | null;
}) {
  const hasUsage = promptTokens != null || completionTokens != null;
  const total = (promptTokens ?? 0) + (completionTokens ?? 0);
  const hasCost = costUsd != null && costUsd > 0;
  if (!modelName && !hasUsage && !hasCost) return null;
  const numbers = (hasUsage || hasCost) && (
    <span className="flex shrink-0 items-center gap-2.5">
      {hasUsage && <span className="shrink-0 font-mono tabular-nums">{formatTokens(total)} tokens</span>}
      {hasCost && <span className="shrink-0 font-mono tabular-nums">{formatUsd(costUsd ?? 0)}</span>}
    </span>
  );
  return (
    <span className="flex min-w-0 items-center gap-2.5 text-caption text-muted-foreground">
      {modelName &&
        (receipt ? (
          // Its own control, beside (never inside) the numbers' tooltip: one
          // focus stop for "why this model", one for the in/out split.
          <AutoReceipt modelName={modelName} receipt={receipt} className="min-w-0" />
        ) : (
          <span className="min-w-0 truncate">{modelName}</span>
        ))}
      {numbers &&
        (hasUsage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Focusable so the split is reachable without a pointer; it names
                  itself, so a screen reader hears the numbers rather than a button. */}
              <span tabIndex={0} className="min-w-0 rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${modelName ?? "Model"}, ${formatTokens(promptTokens ?? 0)} tokens in, ${formatTokens(completionTokens ?? 0)} out${hasCost ? `, ${formatUsd(costUsd ?? 0)}` : ""}`}>
                {numbers}
              </span>
            </TooltipTrigger>
            <TooltipContent className="font-mono tabular-nums">
              {formatTokens(promptTokens ?? 0)} in, {formatTokens(completionTokens ?? 0)} out
            </TooltipContent>
          </Tooltip>
        ) : (
          numbers
        ))}
    </span>
  );
}

/**
 * Regenerate ▾ — Try again · Switch model ▸ · More concise · Add details.
 *
 * The model list is the live catalog, with the one that wrote this answer
 * marked. A one-shot override rides `RegenerateOptions`; the composer's own
 * pick is untouched, so trying an answer once with another model does not
 * silently become the model for every turn after.
 */
function RegenerateMenu({ onRegenerate, currentModelId }: { onRegenerate: (o?: RegenerateOptions) => void; currentModelId?: string | null }) {
  const { models } = useApp();
  const grouped = React.useMemo(() => {
    const chat = models.filter((m) => (m.modality ?? "chat") === "chat" && !m.comingSoon && !m.legacy);
    const byProvider = new Map<string, typeof chat>();
    for (const m of chat) {
      const list = byProvider.get(m.provider) ?? [];
      list.push(m);
      byProvider.set(m.provider, list);
    }
    return [...byProvider.entries()];
  }, [models]);
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Pressable kind="icon" size="md" aria-label="Regenerate" className="gap-0.5 data-[state=open]:control-neu data-[state=open]:text-foreground">
              <ActionIcons.refresh className="size-4" />
              <ChevronDownMini />
            </Pressable>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Regenerate</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className={MENU_W}>
        <DropdownMenuItem onSelect={() => onRegenerate()}>
          <ActionIcons.refresh className="size-4" /> Try again
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {/* The models mark (a processor), the same one Settings › Models
                wears — this row picks which machine answers. */}
            <SettingsIcons.models className="size-4" /> Switch model
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={cn(MENU_W, "max-h-[min(24rem,60vh)]")}>
            {grouped.map(([provider, list]) => (
              <React.Fragment key={provider}>
                <DropdownMenuLabel className="flex items-center gap-1.5 font-mono text-caption">
                  <ProviderLogo provider={list[0].provider} className="size-3" />
                  {PROVIDERS[list[0].provider]?.label.split(" · ")[0] ?? provider}
                </DropdownMenuLabel>
                {list.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => onRegenerate({ modelId: m.id })}>
                    <span className="min-w-0 flex-1 truncate">{m.name}</span>
                    {m.id === currentModelId && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </React.Fragment>
            ))}
            {grouped.length === 0 && <p className="px-2 py-3 text-center text-caption text-muted-foreground">No other models available.</p>}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onRegenerate({ instruction: "Make the answer more concise: keep the substance, cut the length by at least half." })}>
          <ListMinus className="size-4" /> More concise
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onRegenerate({ instruction: "Add more detail: expand the answer with the specifics, examples and caveats that were left out." })}>
          <ListPlus className="size-4" /> Add details
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The set's caret at its smallest rung, riding beside a glyph inside a
 *  circular action to say the press opens a menu rather than acting. */
function ChevronDownMini() {
  return <ChevronDown className="-mr-1 size-3 opacity-60" />;
}

/** Copy ⇄ check, cross-faded in one box (see IconSwap). */
function CopyGlyph({ copied }: { copied: boolean }) {
  return (
    <IconSwap
      curve="spring"
      swapped={copied}
      from={<ActionIcons.copy className="size-4" />}
      to={<StatusIcons.success className="size-4 text-success-ink" />}
    />
  );
}

/** What holds focus as the bubble editor opens, so it can have it back; not <body>. */
function focusedOpener(): HTMLElement | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

/**
 * EDITING A SENT MESSAGE HAPPENS IN THE BUBBLE.
 *
 * It used to swap the bubble for a bare 80px `Textarea` in a narrower column:
 * a different shape, a different size of type, no Esc and no Enter, so the
 * message you were changing stopped looking like the message you sent. Claude
 * and ChatGPT edit in place, and so does this: the same tonal fill, radius,
 * padding and `reading` type as `USER_BUBBLE_CLASS`, opened out to the full
 * column so there is room to rewrite, growing with the text on the composer's
 * own autosize.
 *
 * Keys are the composer's: Enter (or ⌘/Ctrl+Enter) sends, Shift+Enter is a
 * new line, Esc puts the message back as it was. An IME composition is left
 * alone, since its Enter confirms a candidate rather than sending. That takes
 * the composer's two checks, not one: Safari fires the confirming Enter after
 * `compositionend`, so `isComposing` is already false on it and only its
 * keyCode, 229, says it belonged to the IME.
 *
 * Focus is the text field's accent edge and halo (see `Input`), because a
 * bubble with a caret in it is otherwise the same object as the bubble at
 * rest. It arrives on a fast fade; nothing about it travels.
 */
function BubbleEditor({
  value,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  useComposerAutosize(ref, value, { maxLines: 14 });

  // The caret lands at the END of what was said, which is where an edit most
  // often starts, not at the first character where `autoFocus` puts it.
  React.useEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const empty = value.trim().length === 0;

  return (
    <div className="w-full duration-fast motion-safe:animate-fade-in">
      {/* It opens focused, so focus is an edge, not a ring: the keyboard's
          2px line only follows the keyboard (`kbd-focus-within:`). */}
      <div className="rounded-card rounded-br-md border border-transparent bg-secondary px-4 py-2.5 transition-[border-color,box-shadow] duration-fast ease-out-soft focus-within:border-foreground/30 kbd-focus-within:border-[hsl(var(--ring)/0.55)] kbd-focus-within:shadow-[0_0_0_1px_hsl(var(--ring)/0.55)] motion-reduce:transition-none">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          aria-label="Edit message"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!empty) onSubmit();
            }
          }}
          className="block w-full resize-none bg-transparent text-reading text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={empty} onClick={onSubmit}>
          Send
        </Button>
      </div>
    </div>
  );
}

interface MessageItemProps {
  contextReceipt?: ContextReceipt;
  message: ChatMessage;
  isLast: boolean;
  busy: boolean;
  /** See MessageListProps.surface. */
  surface?: "chat" | "code";
  /** Live generation phase — only meaningful for the streaming last message. */
  status?: GenerationStatus;
  animateIn?: boolean;
  artifactsByIdentifier: Map<string, ClientArtifact>;
  onOpenArtifact: (identifier: string, opts?: { fullscreen?: boolean }) => void;
  /**
   * An artifact card changed its artifact through a route — restored from
   * Recently deleted, a suggestion applied or dismissed — and this is the
   * server's copy. Absent on surfaces that cannot fold it back into their list,
   * which hides those controls. Must be stable — see the memo note below.
   */
  onArtifactChanged?: (artifact: ClientArtifact) => void;
  /** Chat-only turn actions. Omitted on surfaces without a chat pipeline
   *  (code sessions), which hides the corresponding buttons entirely —
   *  an action that cannot run must not render. */
  onRegenerate?: (options?: RegenerateOptions) => void;
  /** Regenerate an earlier answer as a new branch at its turn. Absent on
   *  surfaces where only the newest answer can be redone (Code, rooms). */
  onRegenerateAt?: (id: string, options?: RegenerateOptions) => void;
  /** Show another branch: the "‹ 2/3 ›" pager on a message with `branch`. */
  onSelectBranch?: (id: string) => Promise<unknown> | void;
  onContinue?: () => void;
  onEdit?: (id: string, content: string) => void;
  /** Re-send a user turn the server never received (`ChatMessage.unsent`),
   *  optionally with edited text. See use-chat's `resendUnsent`. */
  onResend?: (id: string, content?: string) => void;
  /** This is the newest user turn: `juno:edit-last-user-message` (↑ in an
   *  empty composer) opens it for editing. */
  editOnRequest?: boolean;
  onFeedback: (id: string, value: "UP" | "DOWN" | null, detail?: FeedbackDetail) => void;
  /** False for a bubble with no persisted Message row behind it (code sessions
   *  render optimistic ones): feedback is keyed by message id, so offering it
   *  would POST an id the server has never seen. Defaults to true. */
  canFeedback?: boolean;
  onFork?: (id: string) => void;
  onSpeak?: (id: string, text: string) => void;
  speaking?: boolean;
  privateMode?: boolean;
  /** Launches a region-based edit of a generated image (use-chat.sendImageEdit). */
  onImageEdit?: (input: ImageEditInput) => SendResult;
  /** Model currently selected in the composer — preferred for image edits. */
  currentModelId?: string;
  /**
   * Open a file in the side viewer. Absent on surfaces without one (code
   * sessions), where a file tile falls back to downloading. Must be stable —
   * see the memo note below.
   */
  onOpenAttachment?: (attachment: ClientAttachment) => void;
}

/**
 * ONE MESSAGE, AND IT DOES NOT RE-RENDER WHILE ITS NEIGHBOURS STREAM.
 *
 * `React.memo` here is worth more than anywhere else in the product. A reply
 * arrives as 30-60 SSE chunks a second, each one a `setMessages`, and without
 * a memo every chunk reconciled EVERY message in the transcript — forty turns
 * of Markdown, code blocks, artifact cards and action clusters, sixty times a
 * second. That is the jank in a long conversation, and it is also why the page
 * gets less responsive the longer you talk to it.
 *
 * It bails out for real, which is not automatic — a memo whose props change
 * identity every render costs a comparison and saves nothing. Three things
 * make it bite here, and all three have to stay true:
 *
 *   1. `use-chat` updates with `prev.map((m) => m.id === id ? { ...m } : m)`,
 *      so a chunk creates ONE new object and leaves the rest identical.
 *   2. Every handler reaching this component is a `useCallback` in `use-chat`
 *      or `ChatView`, and `artifactsByIdentifier` is a `useMemo`.
 *   3. The per-row props that vary — `status`, `speaking`, `canFeedback`,
 *      `isLast` — are booleans or undefined for all but the last row, so they
 *      compare equal by value.
 *
 * Break any of those and this silently goes back to doing nothing. The default
 * shallow comparison is deliberate: a custom comparator here would be a second
 * place to keep that list correct.
 */
export const MessageItem = React.memo(function MessageItem({
  surface = "chat",
  contextReceipt,
  message,
  isLast,
  busy,
  status,
  animateIn,
  artifactsByIdentifier,
  onOpenArtifact,
  onArtifactChanged,
  onRegenerate,
  onRegenerateAt,
  onSelectBranch,
  onContinue,
  onEdit,
  onResend,
  editOnRequest,
  onFeedback,
  canFeedback = true,
  onFork,
  onSpeak,
  speaking,
  privateMode,
  onImageEdit,
  currentModelId,
  onOpenAttachment,
}: MessageItemProps) {
  const router = useRouter();
  // The chat's title, for the live thinking row when a model streams no
  // readable reasoning ("Thinking about Lisbon vs Porto"). Read only while
  // streaming; incognito chats are not in the list and fall back to "Thinking".
  const { conversations } = useApp();
  const topic = message.streaming && message.conversationId
    ? conversations.find((c) => c.id === message.conversationId)?.title ?? null
    : null;
  // "⌘" or "Ctrl", for the shortcut keycaps in this turn's tooltips.
  const mod = useModifierKeyLabel();
  const [copied, setCopied] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(message.content);
  const [expanded, setExpanded] = React.useState(false);
  // Image-edit dialog target; kept mounted through the close animation.
  const [editTarget, setEditTarget] = React.useState<ClientAttachment | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  // Where the picture sat when Edit was pressed, so the editor opens out of it.
  const [editOrigin, setEditOrigin] = React.useState<DOMRect | null>(null);
  // The image model that made the picture being edited, when a chat model's
  // `generate_image` made it: the answer's own model writes, it does not draw.
  const [editSourceModel, setEditSourceModel] = React.useState<string | null>(null);
  const uiLocale = useUiLocale();
  // The shape this turn's generation asked for, kept past the placeholder so
  // the result lands in the same box and reveals (generated-media.tsx).
  const generationHandoff = useGenerationHandoff(message.error ? null : message.progress);
  // The long user bubble, for scrolling it back into view after "Show less".
  const bubbleRef = React.useRef<HTMLDivElement>(null);
  /*
   * Where the caret goes when the bubble editor closes. The editor takes focus
   * as it opens, and unmounting a focused field drops focus on <body>, which
   * sends a keyboard reader back to the top of the page after every Esc. So it
   * goes back to what opened the editor: the composer, for ↑ in an empty
   * field, or this turn's Edit button. The button that was pressed left with
   * the action row while the editor was open, so it is the new one the row
   * comes back with; and after a send, while the answer streams and Edit is
   * withheld, the row's first action takes it instead.
   *
   * Only when the editor was closed from the keyboard, though, which is when
   * focus inside it is `:focus-visible` (the field always is; a clicked
   * Cancel is not). Handing focus to Edit after a click on Cancel would open
   * Edit's tooltip over a bubble nobody is pointing at.
   */
  const editOpenerRef = React.useRef<HTMLElement | null>(null);
  const editButtonRef = React.useRef<HTMLButtonElement>(null);
  const actionRowRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusRef = React.useRef(false);
  const closeEditor = () => {
    restoreFocusRef.current = document.activeElement?.matches(":focus-visible") ?? false;
    setEditing(false);
  };
  React.useEffect(() => {
    if (editing) return;
    const restore = restoreFocusRef.current;
    const opener = editOpenerRef.current;
    restoreFocusRef.current = false;
    editOpenerRef.current = null;
    if (!restore) return;
    const target =
      (opener?.isConnected ? opener : null) ??
      editButtonRef.current ??
      actionRowRef.current?.querySelector<HTMLElement>("button:not(:disabled)");
    target?.focus({ preventScroll: true });
  }, [editing]);
  const isUser = message.role === "USER";
  const agentThread = useAgentThread();
  const isVoice = message.voice === true;

  // ---- Version carousel (regenerate / edit-and-resend history) ----
  // `message.versions` holds the PRESERVED older contents (metadata only,
  // oldest first); the message row itself is always the newest. The pager has
  // versions.length + 1 pages with the live message as the last page. Older
  // page contents are fetched lazily (decrypted server-side) on first step
  // back. Paging is purely presentational — the server row is untouched, and
  // regenerating always continues from the live thread whatever page is shown.
  const versionCount = message.versions?.length ?? 0;
  const totalVersions = versionCount + 1;
  const [versionIndex, setVersionIndex] = React.useState(versionCount);
  const [versionDetails, setVersionDetails] = React.useState<ClientMessageVersionDetail[] | null>(null);
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  React.useEffect(() => {
    // A regenerate/edit appended a version under the same message id — snap to
    // the newest page and drop the stale cache so history refetches on demand.
    setVersionIndex(versionCount);
    setVersionDetails(null);
  }, [versionCount]);

  const stepVersion = async (dir: -1 | 1) => {
    const next = Math.min(Math.max(versionIndex + dir, 0), versionCount);
    if (next === versionIndex) return;
    let details = versionDetails;
    if (next < versionCount && !details) {
      if (versionsLoading) return;
      setVersionsLoading(true);
      try {
        const res = await fetch(`/api/messages/${message.id}/versions`);
        if (!res.ok) throw new Error();
        details = ((await res.json()) as { versions?: ClientMessageVersionDetail[] }).versions ?? [];
        setVersionDetails(details);
      } catch {
        toast.error("Couldn’t load that version.");
        return;
      } finally {
        setVersionsLoading(false);
      }
    }
    if (next < versionCount && !details?.[next]) return; // server/client count drifted — stay put
    setVersionIndex(next);
  };

  // ---- Branch pager (src/lib/chat/branches.ts) ----
  // A message with alternatives steps through branches on the server: the
  // turn and everything after it switch, and this row stays where it is (the
  // new branch's first row takes over its render key). Held while a reply is
  // being written, so an answer never lands under a question no longer shown.
  const branch = message.branch && message.branch.siblingIds.length > 1 ? message.branch : null;
  const [switchingBranch, setSwitchingBranch] = React.useState(false);
  const stepBranch = async (dir: -1 | 1) => {
    const target = branch?.siblingIds[branch.index + dir];
    if (!target || !onSelectBranch || switchingBranch) return;
    setSwitchingBranch(true);
    try {
      await onSelectBranch(target);
    } finally {
      setSwitchingBranch(false);
    }
  };
  const pager = branch ? (
    onSelectBranch ? (
      <VersionPager index={branch.index} total={branch.siblingIds.length} loading={busy || switchingBranch} onStep={stepBranch} />
    ) : null
  ) : totalVersions > 1 ? (
    <VersionPager index={versionIndex} total={totalVersions} loading={versionsLoading} onStep={stepVersion} />
  ) : null;

  // What the bubble displays: an older read-only version, or the live message.
  const viewingOld = versionIndex < versionCount ? versionDetails?.[versionIndex] : undefined;
  const view: ChatMessage = viewingOld
    ? {
        ...message,
        content: viewingOld.content,
        reasoning: viewingOld.reasoning ?? null,
        // MUST be nulled, not inherited from `...message`. MessageVersion stores
        // only the flat reasoning, so an old version HAS no steps — spreading
        // the current message's would caption the old answer's thinking with the
        // new answer's steps. Same rule as `activity` below: this describes the
        // CURRENT answer only. The version degrades to collapsed reasoning.
        reasoningParts: null,
        model: viewingOld.model,
        sources: viewingOld.sources,
        promptTokens: viewingOld.promptTokens ?? null,
        completionTokens: viewingOld.completionTokens ?? null,
        costUsd: null,
        // Activity timeline, finish state and Auto's receipt describe the
        // CURRENT answer only: an old version was routed by a decision this
        // row no longer records.
        activity: undefined,
        routing: null,
        finishReason: null,
        errorMessage: null,
      }
    : message;

  // Branch from here: server-side fork — copies the thread up to this message
  // into a new saved conversation and navigates there. Self-contained (needs
  // only the message row), so it requires no plumbing through chat-view.
  const [branching, setBranching] = React.useState(false);
  const branchInNewChat = async () => {
    if (branching || !message.conversationId) return;
    setBranching(true);
    try {
      const res = await fetch(`/api/conversations/${message.conversationId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atMessageId: message.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { conversation?: { id: string }; error?: string };
      if (!res.ok || !data.conversation) throw new Error(data.error ?? "Couldn’t branch the conversation.");
      toast.success("Branched into a new chat.");
      router.push(`/chat/${data.conversation.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t branch the conversation.");
      setBranching(false);
    }
  };

  // For multi-MB pastes, never put the full string into the DOM while collapsed
  // (that freezes / blanks the tab). Expand loads the rest on demand.
  // Avoid content.split("\n") on huge strings — that alone can OOM the tab.
  const HUGE_PASTE = MESSAGE_DISPLAY_COLLAPSE_CHARS;
  /*
   * A turn sent with a quoted selection carries the whole block the model was
   * given — the quote fenced in triple quotes and an instruction written TO
   * the model. Drawn raw, the person's own question sat under a paragraph of
   * protocol they never typed. So the block is read back into a quote card and
   * only their words go in the bubble; anything the parser does not recognise
   * as a block it wrote is shown exactly as sent.
   */
  const quoted = React.useMemo(() => (isUser ? parseQuotedMessage(view.content) : null), [isUser, view.content]);
  const bubbleText = quoted ? quoted.request : view.content;
  // Counted over a sample so a pasted megabyte is not walked on every render,
  // which makes the count exact only when the sample held the whole text.
  // "Show more" states it only then, and only when it is more than one line:
  // one long paragraph is "1 lines" by this count however tall it wraps.
  const LINE_SAMPLE_CHARS = 4_000;
  const lineCount = sampleLineCount(bubbleText, LINE_SAMPLE_CHARS);
  const lineCountShown = bubbleText.length <= LINE_SAMPLE_CHARS && lineCount > 1;
  const isLong = bubbleText.length > 700 || lineCount > 14;
  const isHuge = bubbleText.length > HUGE_PASTE;
  const userDisplayContent =
    isUser && isHuge && !expanded
      ? `${bubbleText.slice(0, HUGE_PASTE)}\n\n… (${bubbleText.length.toLocaleString()} characters, expand to show all)`
      : bubbleText;

  /*
   * The clamp switches INSTANTLY, and only the fade at its foot cross-fades.
   * It used to tween `max-height` to 4000px on the slow rung, which is a
   * height animation (ICONS_AND_MOTION.md §2.2 rule 8), ran at a speed set by
   * a number that had nothing to do with the message, and started the collapse
   * with a dead pause while the tween climbed down from 4000 to the text's
   * real height. Claude and ChatGPT switch the clamp in a frame.
   *
   * Collapsing a bubble taller than the window can leave the reader below it
   * with nothing on screen, so its top is brought back into view when it is
   * not already there.
   */
  const toggleExpanded = () => {
    if (!expanded) {
      setExpanded(true);
      return;
    }
    setExpanded(false);
    requestAnimationFrame(() => bubbleRef.current?.scrollIntoView({ block: "nearest" }));
  };
  // Stable ref (message.sources / a version's sources) — safe as a memo dep and
  // as a prop into the memoized Markdown.
  const sources = view.sources;
  // Code only: files this turn's write receipts already carry, so the body
  // does not print the same file a second time in full.
  const writtenFiles = React.useMemo(
    () => (surface === "code" ? writtenPaths(view.activity) : undefined),
    [surface, view.activity],
  );
  const parts = React.useMemo(
    () =>
      isUser
        ? []
        : splitMessageContent(sources?.length ? stripTrailingSourcesSection(view.content) : view.content),
    [isUser, view.content, sources],
  );

  /*
   * The citation audit (§8.3) for THIS answer. Gated on the numbered-corpus
   * contract — the same `cited` flag that licenses the inline [n] chips — so an
   * ordinary reply issues no request and grows no footer. It is keyed on
   * message.id rather than the version being viewed: the audit was run against
   * the report that was persisted, and an older version's citations were never
   * checked.
   */
  const citationAudit = useCitationAudit(message.id, isAuditableAnswer(sources, message.streaming));


  // Whether this user turn can be edited. An ordinary turn edits through the
  // server (PATCH + regenerate), which private mode has no row for; a turn the
  // server never received edits locally and re-sends, which works anywhere.
  const canEdit = !busy && (message.unsent ? !!onResend : !!onEdit && !privateMode);
  const saveEdit = (content: string) => {
    if (message.unsent) onResend?.(message.id, content);
    else onEdit?.(message.id, content);
  };

  // ↑ in an empty composer edits the newest user turn (ChatGPT's convention).
  React.useEffect(() => {
    if (!editOnRequest || !canEdit) return;
    const handler = () => {
      editOpenerRef.current = focusedOpener();
      setDraft(view.content);
      setEditing(true);
    };
    window.addEventListener("juno:edit-last-user-message", handler);
    return () => window.removeEventListener("juno:edit-last-user-message", handler);
  }, [editOnRequest, canEdit, view.content]);

  // Copy -> check, held for `copiedHold` (INTERACTION_SPEC M11). The check is
  // drawn only once the clipboard write actually succeeded (MOTION_AND_THINKING:
  // a local confirmation verifies success); a refusal says so in the tooltip.
  // A second copy restarts the hold; unmount clears it.
  const copyTimer = React.useRef<number | null>(null);
  const [copyFailed, setCopyFailed] = React.useState(false);
  React.useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  const copy = async () => {
    // Stripped, not raw: the stored reply ends in the memory tags the model
    // wrote, and copying an answer must not paste the user's profile with it.
    const ok = await navigator.clipboard.writeText(stripMemoryTags(view.content).trimEnd()).then(() => true, () => false);
    // The button is its own receipt (the glyph swaps to a check and the
    // tooltip reads "Copied"), so no toast.
    setCopied(ok);
    setCopyFailed(!ok);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, TIMING.copiedHold);
  };

  if (isUser) {
    return (
      <div className={cn("group flex flex-col items-end", animateIn && "motion-safe:animate-turn-in")}>
        {/* Turn marker. On screen the alignment and bubble say who is speaking;
            in a screen reader nothing did, and a transcript with no headings is
            a wall of text with no way to move through it. */}
        <h2 className="sr-only">You said</h2>
        <MessageAttachments attachments={message.attachments} onOpen={onOpenAttachment} />
        {editing ? (
          <BubbleEditor
            value={draft}
            onChange={setDraft}
            onCancel={() => {
              closeEditor();
              setDraft(message.content);
            }}
            onSubmit={() => {
              // An unsent turn re-sends even when the words are unchanged:
              // sending a message that never went out IS the edit.
              if (draft.trim() && (message.unsent || draft.trim() !== message.content)) saveEdit(draft.trim());
              closeEditor();
            }}
          />
        ) : (
          view.content && (
            <div className="flex max-w-[85%] flex-col items-end">
              {quoted && <QuotedSelection quote={quoted} standalone={!bubbleText} />}
              {bubbleText && (
              <div
                ref={bubbleRef}
                data-no-auto-translate
                className={cn(
                  USER_BUBBLE_CLASS,
                  // break-words: pre-wrap alone only wraps at whitespace, so a
                  // pasted URL/token longer than the bubble overflows on phones.
                  "relative w-full scroll-mt-24 break-words",
                  // The clamp, on or off in one frame: see `toggleExpanded`.
                  isLong && !expanded && "max-h-60 overflow-hidden"
                )}
              >
                {contextReceipt ? <SentContextText text={userDisplayContent} receipt={contextReceipt} /> : userDisplayContent}
                {isLong && (
                  <div
                    className={cn(
                      // `from-secondary`: the bubble's own fill, so the clamp
                      // fades into the bubble rather than into a page-coloured
                      // band drawn across it.
                      "pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-card bg-gradient-to-t from-secondary to-transparent transition-opacity duration-base ease-out-soft",
                      expanded ? "opacity-0" : "opacity-100"
                    )}
                  />
                )}
              </div>
              )}
              {contextReceipt && <ContextReceiptLine receipt={contextReceipt} />}
              {isLong && (
                <button
                  type="button"
                  onClick={toggleExpanded}
                  aria-expanded={expanded}
                  // A control, so the interface face rather than the mono
                  // metadata voice; a 28px row (44px coarse) so it is a
                  // target rather than a line of type.
                  className="-mr-1.5 mt-1 inline-flex h-7 items-center rounded-control px-1.5 text-caption font-medium text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground coarse:h-11"
                >
                  {expanded ? "Show less" : lineCountShown ? <>Show more · {lineCount} lines</> : "Show more"}
                </button>
              )}
            </div>
          )
        )}
        {/* A turn that never went out says so, at rest — not behind a hover.
            The words are still here (the bubble above is the only copy) and
            this is the one control that gets them to the server. */}
        {!editing && message.unsent && onResend && (
          <div className="mt-1.5 flex items-center gap-2.5">
            <span className="font-mono text-caption text-destructive">Not sent</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onResend(message.id)}
              className="h-7 gap-1.5"
            >
              <ActionIcons.refresh className="size-3.5" /> Retry send
            </Button>
          </div>
        )}
        {!editing && !message.pending && !isVoice && (
          // The pager is LAST, flush with the bubble's edge: at rest the
          // hidden Copy and Edit keep their width, and with the pager first
          // that width pushed it ~115px in from the bubble, off its line.
          <div className="mt-1 flex items-center">
            <div ref={actionRowRef} className="flex opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100 motion-reduce:transition-none">
              <IconAction label={copied ? "Copied" : copyFailed ? "Couldn’t copy" : "Copy"} onClick={copy}>
                <CopyGlyph copied={copied} />
              </IconAction>
              {canEdit && (
                // Prefill from the DISPLAYED version, so paging back and editing
                // is a one-step "resend an earlier wording".
                <IconAction
                  label="Edit"
                  // ↑ in an empty composer edits this turn (ChatGPT's key),
                  // so the newest one says so.
                  shortcut={editOnRequest ? "↑" : undefined}
                  buttonRef={editButtonRef}
                  onClick={() => {
                    editOpenerRef.current = focusedOpener();
                    setDraft(view.content);
                    setEditing(true);
                  }}
                >
                  <ActionIcons.edit className="size-4" />
                </IconAction>
              )}
              {/* No branch glyph here: editing IS branching on a question
                  (the pager switches between wordings), and a new chat
                  is branched from an answer's More menu, one verb in one place. */}
            </div>
            {pager}
          </div>
        )}
      </div>
    );
  }

  // Assistant message
  const showCursor = message.streaming && message.content.length === 0;
  const hasRunTrace = !!view.reasoning?.trim() || !!view.activity?.length;
  // Generated media: image attachments + video and audio files (kind FILE, video/* or audio/* mime).
  const isPlayable = (a: ClientAttachment) => a.mimeType.startsWith("video/") || a.mimeType.startsWith("audio/");
  // Pictures the chat model made (`generate_image`, G04): drawn by their own
  // card from the activity row, so they are left out of the generic media
  // below — and out of `isMediaOnly`, because the turn is still a chat turn
  // that Regenerate asks again.
  const imageGenerations = imageGenerationsOf(view.activity);
  const imageCardIds = new Set(imageGenerations.flatMap(({ generation }) => generation.attachmentIds));
  const mediaAttachments = message.attachments.filter(
    (a) => (a.kind === "IMAGE" || isPlayable(a)) && !imageCardIds.has(a.id)
  );
  // Media from an image, video or audio model is AI output and is labelled as
  // such. A chart a chat model drew with code is not "generated" in that sense.
  const generatedMedia = (() => {
    const modality = view.model ? resolveModel(view.model)?.modality : undefined;
    return modality === "image" || modality === "video" || modality === "audio";
  })();
  // Anything else an answer carries is a document it produced — a tile that
  // opens in the viewer, the same object a sent file is.
  const fileAttachments = message.attachments.filter((a) => a.kind === "FILE" && !isPlayable(a));
  const hasTextContent = view.content.trim().length > 0;
  // A generated track carries its lyrics as text, but it is still a media
  // turn: regenerating it through the chat stream would ask a music model to talk.
  const isMediaOnly =
    mediaAttachments.length > 0 && (!hasTextContent || mediaAttachments.some((a) => a.mimeType.startsWith("audio/")));
  const hasPartialWithError = !!message.error && !!message.errorMessage && !!message.content && message.content !== message.errorMessage;
  // Finish state comes from `view`: paging back to an older version hides the
  // current answer's continue/finish chrome (it doesn't describe that version).
  const canContinue = !!onContinue && isLast && !busy && (view.finishReason === "length" || view.finishReason === "network_error");
  // Which model produced the DISPLAYED answer — matters after mid-thread model
  // switches and when paging across regenerations made with different models.
  const modelName = view.model ? resolveModel(view.model)?.name ?? view.model : null;
  const hasUsage = view.promptTokens != null || view.completionTokens != null;
  const hasCost = view.costUsd != null && view.costUsd > 0;
  const hasMeta = !!modelName || hasUsage || hasCost;
  // What the More menu can hold for this turn; the trigger renders only when
  // at least one of these is true, so a menu never opens onto nothing.
  const canBranchSaved = !!message.conversationId && !busy && !privateMode;
  const canForkPrivate = !!onFork && !busy && !privateMode;
  const canShare = !!message.conversationId && !privateMode;
  const canCopyLink = !!message.conversationId;
  // The whole chat, not this answer (conversation-export-menu.tsx): on a phone
  // this menu is the way to it, the header's More being desktop only. Settled
  // answers only, so an export never catches this one half-written.
  const canExport = !message.streaming;
  // Only on a settled answer: a streaming one would offer a half-written skill.
  // A plain call, not a memo: this sits past the component's early returns.
  const skillMarkdown = !message.streaming && hasTextContent ? extractSkillMarkdown(view.content) : null;
  const showMore = canBranchSaved || canForkPrivate || canShare || canExport || hasTextContent || canCopyLink || hasMeta;
  const finishNote =
    view.finishReason === "length"
      ? "The model stopped at its token limit."
      : view.finishReason === "network_error"
        ? "The stream was interrupted. The partial answer was preserved."
        : view.finishReason === "user_stopped"
          ? "Stopped by user."
          : view.finishReason === "tool_calls"
            ? "The model requested tools, but no tool flow is enabled for this request."
            : view.finishReason === "sensitive"
              ? "The provider stopped the response for safety reasons."
              : null;

  return (
    <div
      // NAMED, so the thought panel can find this turn's citation chips. A jump
      // from a source row queries `[data-juno-message="…"] [data-cite="n"]`, and
      // without the scope it would land on the first matching chip in the whole
      // transcript — a different answer's source, confidently scrolled to.
      data-juno-message={message.id}
      // …and the target must not land under the transcript's sticky header band.
      className={cn("group flex scroll-mt-24 flex-col gap-2", animateIn && "motion-safe:animate-turn-in")}
      // While the reply streams, each part of it (the run strip, an approval, a
      // tool card, the prose, an artifact, the sources) fades up as it mounts:
      // globals.css, "Turn parts".
      data-turn-streaming={message.streaming ? "" : undefined}
    >
      {/* Turn marker — see the note on the user branch. */}
      <h2 className="sr-only">{agentThread ? `${agentThread.name} replied` : `${PRODUCT_NAME} replied`}</h2>
      {agentThread && !showCursor ? (
        <div className="flex items-center gap-2 text-ui font-medium text-foreground" aria-hidden="true">
          <AgentFace avatar={agentThread.avatar} state="idle" size={20} live={false} />
          {agentThread.name}
        </div>
      ) : null}
      {/*
        NOT a live region. The turn's polite region is the answer body further
        down, and it used to be this root — which meant everything that lands
        after `streaming` flips false announced itself into a settled reply.
        The citation audit resolves idle → loading → ready seconds later (with
        a 6s retry), so its panel and the sources pill rewrote inside a live
        region on top of the aria-live spans citation-audit.tsx keeps for
        itself, and each change was spoken twice. The activity strip had to
        hide its own clock and reasoning from the region for the same reason.
        The bibliography, the audit and the toolbar are content a reader
        navigates to, not announcements.
      */}
      <div className="turn-body min-w-0 flex-1">
        {/* The run strip.
            Chat: full ActivityTimeline (research + tools + reasoning dock).
            Code: CodeActivity already draws commands/writes as cards beside the
            turn, so this strip only carries REASONING (one line + dock). Without
            it, Code turns hid thinking entirely while `hasRunTrace` suppressed
            StreamStatus — reasoning became invisible or leaked into the body. */}
        {surface !== "code" || view.reasoning?.trim() ? (
          <ActivityTimeline
            messageId={message.id}
            events={
              surface === "code"
                ? (view.activity ?? []).filter(
                    (e) => e.kind !== "tool" && e.kind !== "write" && e.kind !== "warning" && e.kind !== "done"
                  )
                : view.activity
            }
            reasoning={view.reasoning}
            reasoningParts={view.reasoningParts}
            topic={topic}
            // For a source step's citation chip only — see ActivityTimeline.
            sources={sources}
            streaming={message.streaming}
            // So the run strip does not draw a file twice: once the reply is
            // saved, its runs' files are this message's own attachments below.
            attachments={message.attachments}
            // Threaded down to the panel's Notice block. Resolved here, once, so
            // the inline finish row below and the panel cannot word it differently.
            finishNote={finishNote}
          />
        ) : null}
        {/*
          Above the answer, not below it. The turn is BLOCKED on this — the tool
          loop in src/lib/mcp.ts is holding — so the question has to sit where
          the reader's eye already is rather than under a partial answer they
          would have to scroll past to find out why nothing is happening.
        */}
        {message.approvals?.length ? (
          <div className="mb-3 space-y-2">
            {message.approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        ) : null}
        {view.activity?.some((evt) => Boolean(evt.agentChange)) ? (
          <div className="mb-3 space-y-2">
            {view.activity
              .filter((evt): evt is typeof evt & { agentChange: NonNullable<typeof evt.agentChange> } =>
                Boolean(evt.agentChange)
              )
              .map((evt) => (
                <AgentChangeCard key={evt.id} change={evt.agentChange} />
              ))}
          </div>
        ) : null}
        {imageGenerations.length > 0 ? (
          <div className="space-y-1">
            {imageGenerations.map(({ id, generation }) => (
              <ImageGenerationCard
                key={generation.callId || id}
                generation={generation}
                attachments={attachmentsForGeneration(generation, message.attachments)}
                live={!!message.streaming}
                onEdit={
                  onImageEdit && currentModelId && !privateMode && !busy
                    ? (attachment, origin, sourceModelId) => {
                        setEditOrigin(origin ?? null);
                        setEditSourceModel(sourceModelId);
                        setEditTarget(attachment);
                        setEditOpen(true);
                      }
                    : undefined
                }
                onVary={
                  onImageEdit && !privateMode && !busy
                    ? (attachment, modelId) => {
                        onImageEdit({
                          prompt: shellString("image.varyPrompt", {}, uiLocale),
                          model: modelId,
                          edit: { attachmentId: attachment.id },
                        });
                      }
                    : undefined
                }
              />
            ))}
          </div>
        ) : null}
        {message.progress && !message.error ? (
          <GenerationPlaceholder progress={message.progress} />
        ) : showCursor && !hasRunTrace && !message.connection ? (
          // `errorMessage` set while still streaming and NOT errored is exactly
          // the shape `beginDropRecovery` leaves behind — it is the only state
          // that writes an explanation onto a turn it expects to complete.
          <StreamStatus
            status={status}
            recovering={message.streaming && !message.error && !!message.errorMessage}
            recoveryNote={message.errorMessage ?? undefined}
            // "Running npm test", not "Thinking", while a
            // Code run is on a tool. The latest activity row is the truth.
            label={surface === "code" ? codeLiveCopy(view.activity?.[view.activity.length - 1]) ?? undefined : undefined}
          />
        ) : message.error && !hasPartialWithError ? (
          <div className="space-y-2.5 rounded-field border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-ui text-destructive dark:bg-destructive/[0.14]">
            {/* The failure mark sits on the first line of the sentence, not
                centred on a paragraph that may wrap to three. */}
            <p className="flex items-start gap-2">
              <StatusIcons.error className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{message.content || message.errorMessage || "Something didn't go well."}</span>
            </p>
            {onRegenerate && isLast && !busy && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRegenerate()}
                  className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <ActionIcons.refresh className="size-3.5" /> Try again
                </Button>
                {/* The error frame's one alternative (chat wire 1.1): a
                    different, healthy lab that does not train on prompts.
                    Clicking it is the reader's explicit choice for this
                    answer — the same one-shot override as Switch model — so
                    nothing is ever rerouted without them. */}
                {message.recovery?.suggestedModelId && !privateMode && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRegenerate({ modelId: message.recovery!.suggestedModelId! })}
                    className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <SettingsIcons.models className="size-3.5" />
                    {`Answer with ${message.recovery.suggestedModelName ?? message.recovery.suggestedModelId}`}
                  </Button>
                )}
              </div>
            )}
          </div>
        ) : (
          /*
            The turn's one live region: silent while streaming, polite once
            the turn is settled. Markdown re-renders the final block on every
            delta, so a polite region during streaming re-announces the
            growing paragraph token by token — which is noise, not access.
            MessageList's role="status" announcer says "Response complete,
            N words" on the finishing edge instead. This was already the
            behaviour for realtime voice; it is right for every turn. Scoped
            to the answer body, not the turn root — see the note there.
          */
          <div className="space-y-1" aria-live={message.streaming ? "off" : "polite"} aria-atomic="false">
            {fileAttachments.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-2">
                {fileAttachments.map((a) => (
                  <AttachmentTile key={a.id} attachment={a} onOpen={onOpenAttachment} />
                ))}
              </div>
            )}
            {mediaAttachments.length > 0 && (() => {
              const editFor = (a: ClientAttachment) =>
                onImageEdit && currentModelId && !privateMode && !busy
                  ? (origin?: DOMRect) => {
                      setEditOrigin(origin ?? null);
                      setEditSourceModel(null);
                      setEditTarget(a);
                      setEditOpen(true);
                    }
                  : undefined;
              const images = mediaAttachments.filter((a) => a.kind === "IMAGE" && !isPlayable(a));
              const others = mediaAttachments.filter((a) => !images.includes(a));
              return (
                // A track's lyrics read as their own block under the player, not as its caption.
                <>
                <div className={cn("flex flex-wrap gap-2", hasTextContent && mediaAttachments.some((a) => a.mimeType.startsWith("audio/")) ? "mb-4" : "mb-1")}>
                  {images.length > 1 ? (
                    // One request, several pictures: the grid the placeholder held.
                    <GeneratedImageGrid
                      attachments={images}
                      handoff={generationHandoff}
                      renderTile={(a, i) => <GeneratedImage key={a.id} attachment={a} handoff={generationHandoff} index={i} tile onEdit={editFor(a)} />}
                    />
                  ) : (
                    images.map((a) => <GeneratedImage key={a.id} attachment={a} handoff={generationHandoff} onEdit={editFor(a)} />)
                  )}
                  {others.map((a) =>
                    a.mimeType.startsWith("video/") ? (
                      <GeneratedVideo key={a.id} attachment={a} handoff={generationHandoff} />
                    ) : (
                      <AudioAttachment key={a.id} attachment={a} />
                    )
                  )}
                </div>
                {/* AI Act art. 50: what a generation model made says so, in
                    plain small words under it (never a pill). The files
                    themselves carry the machine-readable marking
                    (src/lib/ai-content-marking.ts). */}
                {generatedMedia && <p className="mb-2 text-caption text-muted-foreground">AI-generated</p>}
                </>
              );
            })()}
            {/* The streamed prose is paced and inked in by StreamingMarkdown
                (stream-text.tsx); a settled reply renders as plain Markdown. */}
            <LiveUIHostProvider value={{ messageId: message.id }}>
            {/* `data-answer-text`: a settled answer's prose, where a selection
                raises Ask / Quote / Explain (answer-selection-bar.tsx). */}
            <div className="space-y-1" data-answer-text={message.streaming ? undefined : message.id}>
            {parts.map((part, i) =>
              part.type === "text" ? (
                <StreamingMarkdown key={i} content={part.text} streaming={message.streaming} sources={sources} writtenFiles={writtenFiles} />
              ) : part.type === "artifact" ? (
                (() => {
                  const artifact = resolveArtifactTag(artifactsByIdentifier, part.identifier, message);
                  const trashed = isTrashed(artifact);
                  // The suggestion belongs to the answer as it stands: an older
                  // page of the version carousel is a reply that was replaced,
                  // and the proposals it made went STALE with it.
                  const suggestion = viewingOld ? null : cardSuggestion(artifact, message.id);
                  return (
                    <ArtifactInlineCard
                      key={i}
                      // The stored row's id: a design's card draws its poster
                      // from it, and shows its glyph until the row arrives.
                      artifactId={artifact?.id}
                      streaming={part.streaming && message.streaming}
                      title={artifact?.title ?? part.title ?? "Artifact"}
                      type={artifact?.type ?? part.artifactType ?? "CODE"}
                      language={artifact?.language ?? part.language}
                      // A held tag's body is empty (the suggestion lives in its
                      // own row), so the card shows the saved version — which
                      // is the truth about what the artifact is now.
                      // While this reply writes the block, the card shows what is
                      // being written (a revision's new source, which the live
                      // blueprint draws), not the saved version it will replace.
                      content={part.streaming && message.streaming ? (part.content ?? "") : (artifact?.content ?? part.content)}
                      version={artifact?.currentVersion}
                      // Not "Updated" while this reply's update is only waiting:
                      // the bar under the header says what did happen.
                      updated={!!artifact && !suggestion && artifact.messageId != null && artifact.messageId !== message.id}
                      // Nothing opens a trashed artifact: the canvas would sit
                      // on a row every route answers 404 for.
                      onOpen={part.identifier && artifact && !trashed ? () => onOpenArtifact(artifact.identifier, { fullscreen: false }) : undefined}
                      suggestion={suggestion}
                      trashed={trashed}
                      placeholderCount={placeholderCount(view.activity, part.identifier)}
                      onArtifactChanged={onArtifactChanged}
                    />
                  );
                })()
              ) : null
            )}
            </div>
            </LiveUIHostProvider>
            {/* No trailing dot. A coral ball parked under the text was the
                loudest thing on the page while a reply arrived, and it is
                redundant now: the tail fade already says "still writing", and
                the composer is showing its stop button throughout. */}
            {/* The stream dropped and Tether is bringing it back: one calm,
                worded line under whatever has arrived so far. */}
            {message.streaming && message.connection ? <ConnectionStatus connection={message.connection} /> : null}
            {(view.errorMessage || finishNote || canContinue) && (
              // Same rung, same fill logic and same `text-ui` register as the
              // error notice above — these two are siblings in the same slot
              // and were disagreeing about all three. `bg-muted/45` over black
              // resolved to ~4.3%, between the page and --card and equal to
              // neither.
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-field border border-border/70 bg-muted px-3.5 py-2.5 text-ui text-muted-foreground">
                {/* A partial answer that failed keeps the failure mark; a
                    finish note (token limit, stopped, interrupted) is information. */}
                {message.error ? (
                  <StatusIcons.error className="size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <StatusIcons.info className="size-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">{view.errorMessage ?? finishNote}</span>
                {canContinue && (
                  // Carry on from here, not "again": the refresh arrow is
                  // Retry, and this keeps the answer and writes past its end.
                  <Button type="button" variant="outline" size="xs" onClick={onContinue}>
                    <CornerDownRight className="size-3.5" /> Continue
                  </Button>
                )}
                {/* A reply that failed partway keeps what arrived, and the
                    notice offers the way forward it names ("Click Try again"):
                    same shape and place as Continue, which wins when the
                    finish reason allows writing past the kept text. */}
                {message.error && onRegenerate && isLast && !busy && !canContinue && (
                  <Button type="button" variant="outline" size="xs" onClick={() => onRegenerate()}>
                    <ActionIcons.refresh className="size-3.5" /> Try again
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Routines the model drafted (`propose_routine`), under the reply that
            says so: Schedule, Edit, Not now (routine-proposal-card.tsx). */}
        {view.activity?.some((evt) => Boolean(evt.routineProposal)) ? (
          <RoutineProposalList activity={view.activity} />
        ) : null}
        {/* Skills the person taught (`draft_skill`): Review opens the Teach
            page, where the only Save is (skill-draft-card.tsx). */}
        {view.activity?.some((evt) => Boolean(evt.skillDraft)) ? <SkillDraftList activity={view.activity} /> : null}

        {/* Footer, below the answer it backs — the inline chips are the citation,
            this is the bibliography. */}
        {sources && sources.length > 0 && (
          <SourcesPill sources={sources} audit={citationAudit.phase === "ready" ? citationAudit.audit : undefined} />
        )}
        {/* Which saved memories this answer was given, and what the turn
            saved or forgot, each with Edit, Forget or Undo, Not relevant,
            View, and the chat it was learned in. */}
        {!message.streaming && <AnswerMemory activity={view.activity} conversationId={message.conversationId} />}
        {/* Above the model/cost line but below the bibliography: what the answer
            rests on, then how well it rests on it. */}
        {citationAudit.phase !== "idle" && citationAudit.phase !== "none" && (
          <CitationAuditPanel state={citationAudit} />
        )}

        {/* Copy · 👍 · 👎 · Read aloud · Regenerate ▾ · More ▾, the ChatGPT
            set. Branch, Share, Quote and Copy link live one level down in
            More. The model · tokens · cost receipt sits at the far end of the
            row and shows only while the turn is hovered or focused (TurnMeta);
            on phones it stays in More. */}
        {/* A kept partial answer (failed partway) still gets the row: Copy
            copies what arrived, and the thumbs, Regenerate and More apply to
            it as to any answer. A failure with no text has its own card. */}
        {!isVoice && !message.streaming && (!message.error || hasPartialWithError) && (
          <div className="mt-1.5 flex items-center">
            {pager}
            <div
              className={cn(
                // `fast`: the bar is chrome answering the pointer, and a toolbar
                // that takes a fifth of a second to arrive under the cursor
                // reads as lag rather than as a fade.
                "flex items-center transition-opacity duration-fast ease-out-soft",
                // The newest answer keeps its toolbar. Everything a reader does
                // with a reply — copy it, rate it, regenerate it — they do to
                // the one that just arrived, and a control that is invisible
                // until the pointer finds it is not discoverable on a first
                // visit, and is simply absent on a trackpad-less session.
                // Older turns stay quiet so the transcript reads as prose;
                // hover, focus and coarse pointers still reveal them.
                // A turn being read aloud keeps its row too: its Stop is the
                // control the listener needs, and it must not hide.
                isLast || speaking
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100",
                "motion-reduce:transition-none"
              )}
            >
              {hasTextContent && (
                // The copy glyph cross-fades into a check and back rather than
                // swapping in a frame — the confirmation is the entire feedback
                // now that copying raises no toast.
                <IconAction label={copied ? "Copied" : copyFailed ? "Couldn’t copy" : "Copy"} onClick={copy} shortcut={isLast && !copied ? `${mod}⇧C` : undefined}>
                  <CopyGlyph copied={copied} />
                </IconAction>
              )}
              {!privateMode && canFeedback && (
                // Up swells; down never celebrates and asks what went wrong
                // (message-feedback.tsx).
                <MessageFeedback messageId={message.id} feedback={message.feedback} onFeedback={onFeedback} />
              )}
              {onSpeak && hasTextContent && (
                // On the row, not in More: listening is a way of reading the
                // answer, and a control that starts audio should be one press
                // away and show its own Stop while it plays.
                <IconAction label={speaking ? "Stop reading" : "Read aloud"} onClick={() => onSpeak(message.id, view.content)} active={speaking}>
                  <IconSwap
                    curve="spring"
                    swapped={!!speaking}
                    from={<Volume2 className="size-4" />}
                    to={<Square className="size-3.5 fill-current" />}
                  />
                </IconAction>
              )}
              {/* Every answer can be tried again. The newest is redone in place;
                  an earlier one becomes a new branch at its turn, and the
                  answer it replaces stays, with everything after it, one
                  step back on the pager. */}
              {!isMediaOnly && !busy && !privateMode && (isLast ? onRegenerate : onRegenerateAt) && (
                <RegenerateMenu
                  onRegenerate={isLast ? onRegenerate! : (options) => onRegenerateAt?.(message.id, options)}
                  currentModelId={view.model ?? currentModelId}
                />
              )}
              {showMore && (
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        {/* `branching` used to be set and cleared but never
                            rendered: the fork POST plus a router.push ran with
                            no spinner and no disabled state, so a slow fork
                            looked like a click that never landed. The trigger
                            wears the wait now that Branch lives inside it. */}
                        <Pressable
                          kind="icon"
                          size="md"
                          aria-label="More actions"
                          disabled={branching}
                          aria-busy={branching || undefined}
                          className="data-[state=open]:control-neu data-[state=open]:text-foreground"
                        >
                          {branching ? <Loader2 className="size-4 animate-spin" /> : <ActionIcons.more className="size-4" />}
                        </Pressable>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>More</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="start" className={MENU_W}>
                    {(canBranchSaved || canForkPrivate) && (
                      // One Branch, two destinations. "Branch from here" and
                      // "Fork privately" were two near-identical glyphs on the
                      // bar; the choice that actually differs — saved or
                      // private — is a sub-choice, not a second verb.
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          {/* Raw `GitBranch`, not `CodeIcons.branch`: that mark
                              names a repository ref in Alevr Code. This forks a
                              CONVERSATION. "In new chat", because a branch
                              inside this chat is what Edit and Regenerate make. */}
                          <GitBranch className="size-4" /> Branch in new chat
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className={MENU_W}>
                          {canBranchSaved && (
                            <DropdownMenuItem onSelect={() => void branchInNewChat()}>
                              <GitBranch className="size-4" /> Saved chat
                            </DropdownMenuItem>
                          )}
                          {canForkPrivate && (
                            <DropdownMenuItem onSelect={() => onFork?.(message.id)}>
                              <GitFork className="size-4" /> Private chat
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    )}
                    {canShare && (
                      <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent("juno:share-chat"))}>
                        <ActionIcons.share className="size-4" /> Share chat
                      </DropdownMenuItem>
                    )}
                    {canExport && <ExportChatMenuSection />}
                    {(hasTextContent || canCopyLink) && (canBranchSaved || canForkPrivate || canShare || canExport) && (
                      <DropdownMenuSeparator />
                    )}
                    {hasTextContent && (
                      <DropdownMenuItem
                        onSelect={() => {
                          const quoted = view.content
                            .trim()
                            .split("\n")
                            .map((line) => `> ${line}`)
                            .join("\n");
                          // Appended after the draft, never in place of it.
                          window.dispatchEvent(new CustomEvent("juno:composer-seed", { detail: { text: `${quoted}\n\n`, append: true } }));
                        }}
                      >
                        <TextQuote className="size-4" /> Quote in composer
                      </DropdownMenuItem>
                    )}
                    {skillMarkdown && !privateMode && (
                      // "Create with Juno" drafts a SKILL.md in chat; this
                      // hands it to the importer, which reads it, scans it and
                      // lets the reader name it before anything is saved.
                      <DropdownMenuItem
                        onSelect={() => {
                          try {
                            window.sessionStorage.setItem(PENDING_SKILL_MARKDOWN_KEY, skillMarkdown);
                          } catch {
                            toast.error("Couldn’t hand that to the importer. Copy it and paste it into Import skills.");
                            return;
                          }
                          router.push("/skills/import");
                        }}
                      >
                        <AppIcons.skills className="size-4" /> Save as skill…
                      </DropdownMenuItem>
                    )}
                    {canCopyLink && (
                      <DropdownMenuItem
                        onSelect={() => {
                          const url = `${window.location.origin}/chat/${message.conversationId}?m=${message.id}`;
                          navigator.clipboard
                            .writeText(url)
                            .then(() => toast.success("Link copied."))
                            .catch(() => toast.error("Couldn’t copy the link."));
                        }}
                      >
                        <Link2 className="size-4" /> Copy link
                      </DropdownMenuItem>
                    )}
                    {hasMeta && (
                      <>
                        {/* Phones only: from `sm` up the same receipt sits at
                            the end of the action row (TurnMeta). */}
                        <DropdownMenuSeparator className="sm:hidden" />
                        {/* Information, not an action: disabled so it takes no
                            focus and no hover fill, and never closes the menu. */}
                        <DropdownMenuItem disabled className="flex-col items-start gap-0.5 data-[disabled]:opacity-100 sm:hidden">
                          {modelName && (
                            <span className="text-ui text-foreground">
                              {view.routing ? receiptLine(modelName, view.routing) : modelName}
                            </span>
                          )}
                          {/* The same sentence the desktop popover leads with (AutoReceiptReasons). */}
                          {view.routing && receiptSummary(view.routing) && (
                            <span className="text-label text-foreground">{receiptSummary(view.routing)}</span>
                          )}
                          {view.routing && view.routing.reasons.length > 0 && (
                            <span className="text-caption text-muted-foreground">
                              Selected for {view.routing.reasons.join(", ")}
                            </span>
                          )}
                          {(hasUsage || hasCost) && (
                            <span className="font-mono text-caption text-muted-foreground">
                              {hasUsage
                                ? `${formatTokens((view.promptTokens ?? 0) + (view.completionTokens ?? 0))} tokens (${formatTokens(view.promptTokens ?? 0)} in · ${formatTokens(view.completionTokens ?? 0)} out)`
                                : ""}
                              {hasCost ? `${hasUsage ? " · " : ""}${formatUsd(view.costUsd ?? 0)}` : ""}
                            </span>
                          )}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {hasMeta && (
              <div className="ml-auto hidden min-w-0 pl-4 opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none sm:flex">
                <TurnMeta
                  modelName={modelName}
                  receipt={view.routing}
                  promptTokens={view.promptTokens}
                  completionTokens={view.completionTokens}
                  costUsd={view.costUsd}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {editTarget && onImageEdit && currentModelId && (
        <ImageEditOverlay
          attachment={editTarget}
          sourceModelId={editSourceModel ?? message.model}
          currentModelId={currentModelId}
          originRect={editOrigin}
          open={editOpen}
          onOpenChange={setEditOpen}
          onSubmit={onImageEdit}
        />
      )}
    </div>
  );
});
