"use client";

import * as React from "react";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, GitBranch, GitFork, ImageOff, Image as ImageIcon, Loader2, Square, SquareDashed, ThumbsDown, ThumbsUp, Video as VideoIcon, Volume2 } from "lucide-react";
import { ActionIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "@/components/chat/markdown";
import { ArtifactInlineCard } from "@/components/chat/artifact-inline-card";
import { VisualLearningBlockRenderer } from "@/components/chat/learning/visual-learning-renderer";
import { ThinkingState } from "@/components/aicss/thinking-state";
import { ActivityTimeline } from "@/components/chat/activity-timeline";
import { ApprovalCard } from "@/components/chat/approval-card";
import { SourcesPill } from "@/components/chat/sources-pill";
import { CitationAuditPanel, isAuditableAnswer, useCitationAudit } from "@/components/chat/citation-audit";
import { GenerationPlaceholder } from "@/components/chat/generation-placeholder";
import { ImageEditOverlay } from "@/components/chat/image-edit-overlay";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { splitMessageContent } from "@/lib/message-content";
import { resolveModel } from "@/lib/models";
import { MESSAGE_DISPLAY_COLLAPSE_CHARS, sampleLineCount } from "@/lib/prompt-limits";
import { cn, formatBytes, formatTokens, formatUsd } from "@/lib/utils";
import type { ChatMessage, ImageEditInput, SendResult } from "@/hooks/use-chat";
import type { ClientArtifact, ClientAttachment, ClientMessageVersionDetail, GenerationStatus } from "@/types/chat";

function formatStreamElapsed(totalSec: number): string {
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/**
 * Premium "thinking → writing" indicator shown in the transcript while the
 * assistant works with no visible content yet. Elapsed time + progressive copy
 * keep long silent reasoning from looking hung.
 */
function StreamStatus({ status }: { status?: GenerationStatus }) {
  const startRef = React.useRef(Date.now());
  const [elapsedSec, setElapsedSec] = React.useState(0);
  React.useEffect(() => {
    startRef.current = Date.now();
    setElapsedSec(0);
    const timer = window.setInterval(
      () => setElapsedSec(Math.floor((Date.now() - startRef.current) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, [status]);

  const writing = status === "writing";
  const checking = status === "checking";
  const submitting = status === "submitting";
  let statusCopy = "Thinking about your request";
  if (writing) statusCopy = "Writing the response";
  else if (checking) statusCopy = "Checking your request";
  else if (submitting) statusCopy = "Starting your request";
  else if (elapsedSec >= 600) {
    statusCopy = "Still thinking deeply — safe to leave; the answer will be here when you return";
  } else if (elapsedSec >= 120) {
    statusCopy = "Still thinking — working in the background";
  }

  const showClock = !writing && !checking && !submitting && elapsedSec > 0;

  return (
    <div role="status" className="flex min-h-10 items-center gap-3 py-1.5 motion-safe:animate-fade-in">
      <ThinkingDots className="text-muted-foreground/65" />
      {/* AIcss's Thinking State, matching the live strip in ActivityTimeline —
          the two are the same moment reached by different routes (this one is
          the window before any run event has landed), so they must not breathe
          differently. */}
      <ThinkingState key={statusCopy} className="min-w-0 truncate text-body-lg leading-6">
        {statusCopy}
        {showClock && (
          <span className="whitespace-nowrap tabular-nums"> · {formatStreamElapsed(elapsedSec)}</span>
        )}
      </ThinkingState>
    </div>
  );
}

/**
 * A generated image keeps the same square footprint as its in-flight card while
 * the browser fetches and decodes the final pixels. The neutral frame arrives
 * immediately; only the pixels dissolve in, so completion never collapses and
 * re-expands the transcript.
 */
function GeneratedImageAttachment({ attachment, onEdit }: { attachment: ClientAttachment; onEdit?: () => void }) {
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const protectedLocalUrl = requiresViewerCredentials(attachment.url);

  const revealAfterDecode = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const reveal = () => {
      setFailed(false);
      setReady(true);
    };
    // `load` can fire before a large bitmap has finished decoding. Waiting for
    // decode avoids revealing one blank frame; older browsers simply fall back
    // to the normal load event.
    if (typeof image.decode === "function") {
      void image.decode().catch(() => undefined).then(reveal);
    } else {
      reveal();
    }
  };

  return (
    <div className="group/media relative w-full max-w-[320px] motion-safe:animate-fade-in">
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={
          failed
            ? `Preview unavailable. Open ${attachment.fileName} in a new tab`
            : `Open ${attachment.fileName} in a new tab`
        }
        // `bg-muted` at full strength, not `/35`. The placeholder frame is drawn
        // on the transcript ground, which is now #000, so muted at 35% resolved
        // to ~3% lightness — a frame the same colour as the page, holding a
        // "Preparing image" label with nothing behind it. Named rung instead.
        className="relative block aspect-square w-full overflow-hidden rounded-field border border-border/60 bg-muted shadow-soft motion-safe:transition-[border-color,box-shadow] motion-safe:duration-base hover:border-border hover:shadow-lift"
      >
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 z-10 grid place-items-center bg-muted text-muted-foreground motion-safe:transition-opacity motion-safe:duration-base",
            ready && "opacity-0"
          )}
        >
          <span className="flex flex-col items-center gap-2 px-5 text-center">
            {failed ? <ImageOff className="size-5" /> : <ImageIcon className="size-5 opacity-70" />}
            <span className="font-mono text-caption">
              {failed ? "Preview unavailable · open original" : "Preparing image"}
            </span>
          </span>
        </div>
        <Image
          src={attachment.url}
          alt={attachment.fileName}
          fill
          // The protected local-storage route requires the browser's session
          // cookie. Next's internal optimizer fetch does not forward it.
          unoptimized={protectedLocalUrl}
          sizes="(max-width: 640px) calc(100vw - 2rem), 320px"
          onLoad={revealAfterDecode}
          onError={() => {
            setReady(false);
            setFailed(true);
          }}
          className={cn(
            "object-contain opacity-0 motion-safe:transition-opacity motion-safe:duration-slow motion-safe:ease-out-soft",
            ready && "opacity-100"
          )}
        />
      </a>
      {failed && (
        <span role="status" aria-live="polite" className="sr-only">
          Preview unavailable for {attachment.fileName}. Open the original file instead.
        </span>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${attachment.fileName}`}
          // `caption`, matching the video card's "Open" pill — the same
          // media-overlay action role. `label` is the uppercase-eyebrow rung;
          // its 0.10em tracking has no business on a mixed-case verb.
          className="absolute right-2 top-2 z-20 inline-flex h-8 items-center gap-1.5 rounded-full border border-border/60 bg-card/85 px-2.5 font-mono text-caption text-foreground/85 opacity-0 shadow-soft backdrop-blur transition-[transform,opacity,color] duration-base ease-out-soft hover:text-foreground active:scale-95 group-hover/media:opacity-100 focus-visible:opacity-100 coarse:h-10 coarse:opacity-100 motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <SquareDashed className="size-3.5" aria-hidden="true" /> Edit
        </button>
      )}
    </div>
  );
}

/** Generated video (kind FILE, video/*) — stable 16:9 chrome, revealed when playable. */
function VideoAttachment({ attachment }: { attachment: ClientAttachment }) {
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const visibleStatus = failed ? "Preview unavailable" : ready ? "Ready" : "Preparing";
  const accessibleStatus = failed
    ? `Video preview unavailable for ${attachment.fileName}`
    : ready
      ? `${attachment.fileName} is ready`
      : `Preparing ${attachment.fileName}`;

  return (
    // Named rungs, not alpha. `bg-card/75` and `bg-muted/35` were tuned against
    // the old 9%-lightness ground; over #000 they resolve to ~4.9% and ~3.3%,
    // so the card, its stage and the page were three shades of nothing.
    <div className="group/video grid w-full max-w-[480px] grid-rows-[auto_3.25rem] overflow-hidden rounded-field border border-border/60 bg-card shadow-soft motion-safe:animate-fade-in motion-safe:transition-[border-color,box-shadow] motion-safe:duration-base hover:border-border hover:shadow-lift">
      <div className="relative aspect-video min-w-0 overflow-hidden bg-muted">
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 z-10 grid place-items-center bg-muted text-muted-foreground motion-safe:transition-opacity motion-safe:duration-base",
            ready && "opacity-0"
          )}
        >
          <span className="flex flex-col items-center gap-2 px-5 text-center">
            <VideoIcon className="size-5 opacity-70" />
            <span className="font-mono text-caption">
              {failed ? "Video preview unavailable" : "Preparing video"}
            </span>
          </span>
        </div>
        <video
          controls={ready}
          playsInline
          preload="auto"
          src={attachment.url}
          title={attachment.fileName}
          aria-label={attachment.fileName}
          aria-hidden={!ready}
          tabIndex={ready ? 0 : -1}
          onLoadStart={() => {
            setReady(false);
            setFailed(false);
          }}
          onLoadedData={() => {
            setFailed(false);
            setReady(true);
          }}
          onError={() => {
            setReady(false);
            setFailed(true);
          }}
          className={cn(
            "absolute inset-0 size-full object-contain opacity-0 motion-safe:transition-opacity motion-safe:duration-slow motion-safe:ease-out-soft",
            ready ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          )}
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 border-t border-border/60 bg-card px-3.5">
        <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <VideoIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0 font-mono text-caption text-foreground/75">Video</span>
          <span aria-hidden="true" className="text-border">·</span>
          <span role="status" aria-live="polite" className="min-w-0 truncate text-caption">
            <span aria-hidden="true">{visibleStatus}</span>
            <span className="sr-only">{accessibleStatus}</span>
          </span>
        </div>
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${attachment.fileName} in a new tab`}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-secondary px-2.5 font-mono text-caption text-foreground/80 transition-[background-color,border-color,color,transform] duration-base ease-out-soft hover:border-border hover:bg-accent hover:text-foreground active:scale-95 coarse:h-10 motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          Open
          <ActionIcons.external className="size-3" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

/**
 * Deep-research reports are prompted to end with a "## Sources" section listing
 * every citation as "[n] Title — URL" (see buildResearchContext). Once the same
 * list renders as the sources pill, that tail is a duplicate wall of naked URLs
 * — so drop it from the RENDERED markdown. Copy still yields the full text.
 *
 * Conservative on purpose: only the last such heading, only when every line
 * under it is a citation entry (a "Sources" section the model wrote prose into
 * is the model saying something, not a list we already render), and only when
 * the heading isn't inside a code fence.
 */
function stripTrailingSourcesSection(content: string): string {
  const lines = content.split("\n");
  let start = -1;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(lines[i])) fenced = !fenced;
    else if (!fenced && /^#{1,6}\s+sources\s*$/i.test(lines[i])) start = i;
  }
  if (start === -1) return content;
  const isEntry = (line: string) => line.trim() === "" || /^\s*(?:[-*]\s+)?\[\d{1,3}\]/.test(line);
  if (!lines.slice(start + 1).every(isEntry)) return content;
  return lines.slice(0, start).join("\n").trimEnd();
}

function AttachmentList({ attachments }: { attachments: ClientAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap justify-end gap-2">
      {attachments.map((a) =>
        a.kind === "IMAGE" ? (
          <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer">
            <Image
              src={a.url}
              unoptimized={requiresViewerCredentials(a.url)}
              alt={a.fileName}
              width={160}
              height={160}
              className="max-h-40 w-auto rounded-md border object-cover"
            />
          </a>
        ) : (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            // rounded-md, matching the composer's upload chip (composer.tsx). The
            // same ~34px chip was rounded-lg (24) here and rounded-md (8) there,
            // so a file visibly turned into a stadium the instant it was sent.
            className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs transition-colors duration-fast hover:bg-accent"
          >
            <CodeIcons.file className="size-4 text-muted-foreground" />
            <span className="max-w-[180px] truncate font-medium">{a.fileName}</span>
            <span className="text-muted-foreground">{formatBytes(a.size)}</span>
            <ActionIcons.download className="size-3.5 text-muted-foreground" />
          </a>
        )
      )}
    </div>
  );
}

/**
 * ChatGPT-style "‹ 2/3 ›" version pager, shown whenever a message has preserved
 * prior versions (regenerate and edit-and-resend never overwrite history). It
 * sits in the action-toolbar row but OUTSIDE the hover-revealed cluster so the
 * existence of history stays discoverable at a glance.
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
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  /** In flight. Shows a spinner and blocks a second press. */
  busy?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pressable
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
          {busy ? <Loader2 className="size-4 animate-spin" /> : children}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface MessageItemProps {
  message: ChatMessage;
  isLast: boolean;
  busy: boolean;
  /** Live generation phase — only meaningful for the streaming last message. */
  status?: GenerationStatus;
  animateIn?: boolean;
  artifactsByIdentifier: Map<string, ClientArtifact>;
  onOpenArtifact: (identifier: string, opts?: { fullscreen?: boolean }) => void;
  /** Chat-only turn actions. Omitted on surfaces without a chat pipeline
   *  (code sessions), which hides the corresponding buttons entirely —
   *  an action that cannot run must not render. */
  onRegenerate?: () => void;
  onContinue?: () => void;
  onEdit?: (id: string, content: string) => void;
  onFeedback: (id: string, value: "UP" | "DOWN" | null) => void;
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
}

export function MessageItem({
  message,
  isLast,
  busy,
  status,
  animateIn,
  artifactsByIdentifier,
  onOpenArtifact,
  onRegenerate,
  onContinue,
  onEdit,
  onFeedback,
  canFeedback = true,
  onFork,
  onSpeak,
  speaking,
  privateMode,
  onImageEdit,
  currentModelId,
}: MessageItemProps) {
  const router = useRouter();
  const [copied, setCopied] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(message.content);
  const [expanded, setExpanded] = React.useState(false);
  // Image-edit dialog target; kept mounted through the close animation.
  const [editTarget, setEditTarget] = React.useState<ClientAttachment | null>(null);
  const [editOpen, setEditOpen] = React.useState(false);
  // Max-height clamp stays on while collapsed or animating; it's removed once the
  // expand transition settles so extremely long messages are never clipped.
  const [heightCapped, setHeightCapped] = React.useState(true);
  const isUser = message.role === "USER";
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
        toast.error("Couldn't load that version.");
        return;
      } finally {
        setVersionsLoading(false);
      }
    }
    if (next < versionCount && !details?.[next]) return; // server/client count drifted — stay put
    setVersionIndex(next);
  };

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
        // Activity timeline and finish state describe the CURRENT answer only.
        activity: undefined,
        finishReason: null,
        errorMessage: null,
      }
    : message;

  // Branch from here: server-side fork — copies the thread up to this message
  // into a new saved conversation and navigates there. Self-contained (needs
  // only the message row), so it requires no plumbing through chat-view.
  const [branching, setBranching] = React.useState(false);
  const branch = async () => {
    if (branching || !message.conversationId) return;
    setBranching(true);
    try {
      const res = await fetch(`/api/conversations/${message.conversationId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ atMessageId: message.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { conversation?: { id: string }; error?: string };
      if (!res.ok || !data.conversation) throw new Error(data.error ?? "Couldn't branch the conversation.");
      toast.success("Branched into a new chat.");
      router.push(`/chat/${data.conversation.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't branch the conversation.");
      setBranching(false);
    }
  };

  // For multi-MB pastes, never put the full string into the DOM while collapsed
  // (that freezes / blanks the tab). Expand loads the rest on demand.
  // Avoid content.split("\n") on huge strings — that alone can OOM the tab.
  const HUGE_PASTE = MESSAGE_DISPLAY_COLLAPSE_CHARS;
  const lineCount = sampleLineCount(view.content);
  const isLong = view.content.length > 700 || lineCount > 14;
  const isHuge = view.content.length > HUGE_PASTE;
  const userDisplayContent =
    isUser && isHuge && !expanded
      ? `${view.content.slice(0, HUGE_PASTE)}\n\n… (${view.content.length.toLocaleString()} characters — expand to show all)`
      : view.content;

  const toggleExpanded = () => {
    if (!expanded) {
      setExpanded(true);
      return;
    }
    // Restore the clamp first so the collapse animates from a real length.
    setHeightCapped(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(false)));
  };
  // Stable ref (message.sources / a version's sources) — safe as a memo dep and
  // as a prop into the memoized Markdown.
  const sources = view.sources;
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


  const copy = async () => {
    await navigator.clipboard.writeText(view.content).catch(() => {});
    setCopied(true);
    // The button is its own receipt — the glyph swaps to a check and the
    // tooltip reads "Copied" — so no toast: a corner notification for an act
    // completed under the cursor is a second voice saying the same thing.
    // Two seconds of dwell: long enough to be seen after the eye has moved
    // back to the text, short enough that the control is itself again before
    // anyone wants it twice.
    setTimeout(() => setCopied(false), 2000);
  };

  if (isUser) {
    return (
      <div className={cn("group flex flex-col items-end", animateIn && "motion-safe:animate-rise-in")}>
        {/* Turn marker. On screen the alignment and bubble say who is speaking;
            in a screen reader nothing did, and a transcript with no headings is
            a wall of text with no way to move through it. */}
        <h2 className="sr-only">You said</h2>
        <AttachmentList attachments={message.attachments} />
        {editing ? (
          <div className="w-full max-w-2xl space-y-2">
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-[80px]" autoFocus />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setDraft(message.content); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  if (draft.trim() && draft.trim() !== message.content) onEdit?.(message.id, draft.trim());
                  setEditing(false);
                }}
              >
                Save &amp; resend
              </Button>
            </div>
          </div>
        ) : (
          view.content && (
            <div className="flex max-w-[85%] flex-col items-end">
              <div
                data-no-auto-translate
                onTransitionEnd={(e) => {
                  if (e.target === e.currentTarget && e.propertyName === "max-height" && expanded) setHeightCapped(false);
                }}
                className={cn(
                  // break-words: pre-wrap alone only wraps at whitespace, so a
                  // pasted URL/token longer than the bubble overflows on phones.
                  "relative w-full whitespace-pre-wrap break-words rounded-card rounded-br-md border border-border/50 bg-secondary px-4 py-2.5 text-body leading-relaxed [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-soft)]",
                  isLong && heightCapped && "overflow-hidden transition-[max-height] duration-slow ease-out-expo",
                  isLong && heightCapped && (expanded ? "max-h-[4000px]" : "max-h-60")
                )}
              >
                {userDisplayContent}
                {isLong && (
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-card bg-gradient-to-t from-secondary to-transparent transition-opacity duration-base ease-out-soft",
                      expanded ? "opacity-0" : "opacity-100"
                    )}
                  />
                )}
              </div>
              {isLong && (
                <button
                  type="button"
                  onClick={toggleExpanded}
                  // `caption` — the mono metadata voice this row shares with
                  // the version pager and the model/cost line below it.
                  className="mt-1 font-mono text-caption text-muted-foreground transition-colors duration-fast hover:text-foreground"
                >
                  {expanded ? "Show less" : `Show more · ${lineCount} lines`}
                </button>
              )}
            </div>
          )
        )}
        {!editing && !message.pending && !isVoice && (
          <div className="mt-1 flex items-center">
            {totalVersions > 1 && (
              <VersionPager index={versionIndex} total={totalVersions} loading={versionsLoading} onStep={stepVersion} />
            )}
            <div className="flex opacity-0 transition-opacity duration-base group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100">
              <IconAction label={copied ? "Copied" : "Copy"} onClick={copy}>
                {copied ? <StatusIcons.success className="size-4 motion-safe:animate-pop-in" /> : <ActionIcons.copy className="size-4" />}
              </IconAction>
              {onEdit && !busy && !privateMode && (
                // Prefill from the DISPLAYED version, so paging back and editing
                // is a one-step "resend an earlier wording".
                <IconAction label="Edit" onClick={() => { setDraft(view.content); setEditing(true); }}>
                  <ActionIcons.edit className="size-4" />
                </IconAction>
              )}
              {onFork && !busy && !privateMode && (
                <IconAction label="Fork privately" onClick={() => onFork(message.id)}>
                  <GitFork className="size-4" />
                </IconAction>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Assistant message
  const showCursor = message.streaming && message.content.length === 0;
  const hasRunTrace = !!view.reasoning?.trim() || !!view.activity?.length;
  // Generated media: image attachments + video files (kind FILE, video/* mime).
  const mediaAttachments = message.attachments.filter((a) => a.kind === "IMAGE" || a.mimeType.startsWith("video/"));
  const hasTextContent = view.content.trim().length > 0;
  const isMediaOnly = mediaAttachments.length > 0 && !hasTextContent;
  const hasPartialWithError = !!message.error && !!message.errorMessage && !!message.content && message.content !== message.errorMessage;
  // Finish state comes from `view`: paging back to an older version hides the
  // current answer's continue/finish chrome (it doesn't describe that version).
  const canContinue = !!onContinue && isLast && !busy && (view.finishReason === "length" || view.finishReason === "network_error");
  // Which model produced the DISPLAYED answer — matters after mid-thread model
  // switches and when paging across regenerations made with different models.
  const modelName = view.model ? resolveModel(view.model)?.name ?? view.model : null;
  const hasUsage = view.promptTokens != null || view.completionTokens != null;
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
    <div className={cn("group flex flex-col gap-2", animateIn && "motion-safe:animate-rise-in")}>
      {/* Turn marker — see the note on the user branch. */}
      <h2 className="sr-only">Juno replied</h2>
      {/*
        Silent while streaming, polite once the turn is settled.
        Markdown re-renders the final block on every delta, so a polite region
        during streaming re-announces the growing paragraph token by token —
        which is noise, not access. MessageList's role="status" announcer says
        "Response complete, N words" on the finishing edge instead. This was
        already the behaviour for realtime voice; it is right for every turn.
      */}
      <div className="min-w-0 flex-1" aria-live={message.streaming ? "off" : "polite"} aria-atomic="false">
        <ActivityTimeline
          messageId={message.id}
          events={view.activity}
          reasoning={view.reasoning}
          reasoningParts={view.reasoningParts}
          streaming={message.streaming}
          // Threaded down to the panel's Notice block. Resolved here, once, so
          // the inline finish row below and the panel cannot word it differently.
          finishNote={finishNote}
        />
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
        {message.progress && !message.error ? (
          <GenerationPlaceholder progress={message.progress} />
        ) : showCursor && !hasRunTrace ? (
          <StreamStatus status={status} />
        ) : message.error && !hasPartialWithError ? (
          // `rounded-field` is the inline-note rung; `rounded-lg` is 16px, the
          // SURFACE rung, which made this two-line notice rounder than the
          // finish-note box directly below it. And the dark tint is separated
          // out: destructive at 5% over a #000 ground computes to ~2.5%
          // lightness, so on dark the error block had no fill at all — it was a
          // red border around the page. 5% is still right against 97% paper.
          // `text-ui` is shared with the finish-note box for the same sibling
          // reason: one slot, one register (they sat at 14 and 12 before).
          <div className="space-y-2.5 rounded-field border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-ui text-destructive dark:bg-destructive/[0.14]">
            <p>{message.content}</p>
            {onRegenerate && isLast && !busy && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRegenerate}
                className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <ActionIcons.refresh className="size-3.5" /> Try again
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {mediaAttachments.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-2">
                {mediaAttachments.map((a) =>
                  a.mimeType.startsWith("video/") ? (
                    <VideoAttachment key={a.id} attachment={a} />
                  ) : (
                    <GeneratedImageAttachment
                      key={a.id}
                      attachment={a}
                      onEdit={
                        onImageEdit && currentModelId && !privateMode && !busy
                          ? () => {
                              setEditTarget(a);
                              setEditOpen(true);
                            }
                          : undefined
                      }
                    />
                  )
                )}
              </div>
            )}
            {/* The tail fade wraps the prose ONLY. On the whole answer body it
                landed on the trailing dot's own line instead of the line being
                written, and it would have dimmed the bottom edge of a message
                that ends in an image.
                The length gate matters: the gradient is one line tall, so on an
                answer only one line long it covers the whole thing and the
                reply sits dimmed for its whole life. ~140 characters is past
                the first wrap at every column width, which is the point where
                the fade has a line of its own to sit on. */}
            <div className={cn("space-y-1", message.streaming && message.content.length > 140 && "stream-tail")}>
            {parts.map((part, i) =>
              part.type === "text" ? (
                <Markdown key={i} content={part.text} streaming={message.streaming} sources={sources} />
              ) : part.type === "artifact" ? (
                (() => {
                  const artifact = artifactsByIdentifier.get(part.identifier);
                  return (
                    <ArtifactInlineCard
                      key={i}
                      streaming={part.streaming && message.streaming}
                      title={artifact?.title ?? part.title ?? "Artifact"}
                      type={artifact?.type ?? part.artifactType ?? "CODE"}
                      language={artifact?.language ?? part.language}
                      content={artifact?.content ?? part.content}
                      version={artifact?.currentVersion}
                      updated={!!artifact && artifact.messageId != null && artifact.messageId !== message.id}
                      onOpen={part.identifier && artifact ? () => onOpenArtifact(part.identifier, { fullscreen: false }) : undefined}
                    />
                  );
                })()
              ) : (
                <VisualLearningBlockRenderer
                  key={part.parsed.blockId}
                  parsed={part.parsed}
                  messageStreaming={message.streaming}
                />
              )
            )}
            </div>
            {/* No trailing dot. A coral ball parked under the text was the
                loudest thing on the page while a reply arrived, and it is
                redundant now: the tail fade already says "still writing", and
                the composer is showing its stop button throughout. */}
            {(view.errorMessage || finishNote || canContinue) && (
              // Same rung, same fill logic and same `text-ui` register as the
              // error notice above — these two are siblings in the same slot
              // and were disagreeing about all three. `bg-muted/45` over black
              // resolved to ~4.3%, between the page and --card and equal to
              // neither.
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-field border border-border/70 bg-muted px-3.5 py-2.5 text-ui text-muted-foreground">
                <span className="min-w-0 flex-1">{view.errorMessage ?? finishNote}</span>
                {canContinue && (
                  <Button type="button" variant="outline" size="sm" onClick={onContinue} className="h-7 gap-1.5">
                    <ActionIcons.refresh className="size-3.5" /> Continue
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer, below the answer it backs — the inline chips are the citation,
            this is the bibliography. */}
        {sources && sources.length > 0 && (
          <SourcesPill sources={sources} audit={citationAudit.phase === "ready" ? citationAudit.audit : undefined} />
        )}
        {/* Above the model/cost line but below the bibliography: what the answer
            rests on, then how well it rests on it. */}
        <CitationAuditPanel state={citationAudit} />

        {!isVoice && !message.streaming && !message.error && (modelName || hasUsage) && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* No /60 modifier: at this size it computes to 2.43:1 light /
                  3.35:1 dark, and WCAG 1.4.3 wants 4.5:1. The token at full
                  opacity is 5.32 / 7.07 and already reads as secondary. */}
              <p className="mt-1 w-fit cursor-default font-mono text-caption text-muted-foreground">
                {modelName}
                {hasUsage ? `${modelName ? " · " : ""}${formatTokens((view.promptTokens ?? 0) + (view.completionTokens ?? 0))} tokens` : ""}
                {view.costUsd != null && view.costUsd > 0 ? ` · ${formatUsd(view.costUsd)}` : ""}
              </p>
            </TooltipTrigger>
            <TooltipContent>
              {view.model}
              {hasUsage ? `${view.model ? " · " : ""}${formatTokens(view.promptTokens ?? 0)} in · ${formatTokens(view.completionTokens ?? 0)} out` : ""}
              {view.costUsd != null && view.costUsd > 0 ? ` · ${formatUsd(view.costUsd)}` : ""}
            </TooltipContent>
          </Tooltip>
        )}

        {!isVoice && !message.streaming && !message.error && (
          <div className="mt-1.5 flex items-center">
            {totalVersions > 1 && (
              <VersionPager index={versionIndex} total={totalVersions} loading={versionsLoading} onStep={stepVersion} />
            )}
            <div className="flex items-center opacity-0 transition-opacity duration-base group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100">
              {hasTextContent && (
                // The check POPS in (one-shot, on the motion ladder) rather
                // than swapping silently — the confirmation is the entire
                // feedback now that copying no longer raises a toast.
                <IconAction label={copied ? "Copied" : "Copy"} onClick={copy}>
                  {copied ? <StatusIcons.success className="size-4 motion-safe:animate-pop-in" /> : <ActionIcons.copy className="size-4" />}
                </IconAction>
              )}
              {!isMediaOnly && onRegenerate && isLast && !busy && !privateMode && (
                <IconAction label="Regenerate" onClick={onRegenerate}>
                  <ActionIcons.refresh className="size-4" />
                </IconAction>
              )}
              {message.conversationId && !busy && !privateMode && (
                // `branching` was set and cleared but never rendered: the fork
                // POST plus a router.push ran with no spinner, no disabled state
                // and no dimming, so a slow fork looked like a click that never
                // landed and only an invisible guard stopped a second one.
                <IconAction label="Branch from here" onClick={branch} busy={branching}>
                  {/* Raw `GitBranch`, not `CodeIcons.branch`: that mark names a
                      repository ref in Juno Code. This forks a CONVERSATION,
                      and it pairs with the GitFork beside it. */}
                  <GitBranch className="size-4" />
                </IconAction>
              )}
              {onFork && !busy && !privateMode && (
                <IconAction label="Fork privately" onClick={() => onFork(message.id)}>
                  <GitFork className="size-4" />
                </IconAction>
              )}
              {!privateMode && canFeedback && (
                <>
                  <IconAction label="Good response" onClick={() => onFeedback(message.id, message.feedback === "UP" ? null : "UP")} active={message.feedback === "UP"}>
                    <ThumbsUp className="size-4" />
                  </IconAction>
                  <IconAction label="Bad response" onClick={() => onFeedback(message.id, message.feedback === "DOWN" ? null : "DOWN")} active={message.feedback === "DOWN"}>
                    <ThumbsDown className="size-4" />
                  </IconAction>
                </>
              )}
              {onSpeak && hasTextContent && (
                <IconAction
                  label={speaking ? "Stop" : "Read aloud"}
                  onClick={() => onSpeak(message.id, view.content)}
                  active={speaking}
                >
                  {speaking ? <Square className="size-4 fill-current" /> : <Volume2 className="size-4" />}
                </IconAction>
              )}
            </div>
          </div>
        )}
      </div>

      {editTarget && onImageEdit && currentModelId && (
        <ImageEditOverlay
          attachment={editTarget}
          sourceModelId={message.model}
          currentModelId={currentModelId}
          open={editOpen}
          onOpenChange={setEditOpen}
          onSubmit={onImageEdit}
        />
      )}
    </div>
  );
}
