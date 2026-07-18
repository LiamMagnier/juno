"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Copy, Download, FileText, GitBranch, GitFork, Pencil, RefreshCw, Square, SquareDashed, ThumbsDown, ThumbsUp, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "@/components/chat/markdown";
import { ArtifactInlineCard } from "@/components/chat/artifact-inline-card";
import { VisualLearningBlockRenderer } from "@/components/chat/learning/visual-learning-renderer";
import { ActivityTimeline } from "@/components/chat/activity-timeline";
import { SourcesPill } from "@/components/chat/sources-pill";
import { GenerationPlaceholder } from "@/components/chat/generation-placeholder";
import { ImageEditOverlay } from "@/components/chat/image-edit-overlay";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { JunoMark } from "@/components/brand/logo";
import { splitMessageContent } from "@/lib/message-content";
import { resolveModel } from "@/lib/models";
import { cn, formatBytes, formatTokens, formatUsd } from "@/lib/utils";
import type { ChatMessage, ImageEditInput } from "@/hooks/use-chat";
import type { ClientArtifact, ClientAttachment, ClientMessageVersionDetail, GenerationStatus } from "@/types/chat";

/**
 * Premium "thinking → writing" indicator shown in the transcript while the
 * assistant works with no visible content yet. The dot constellation carries the
 * motion; the label crossfades and shimmers as the phase changes.
 */
function StreamStatus({ status }: { status?: GenerationStatus }) {
  const label = status === "writing" ? "Writing" : status === "checking" ? "Checking" : "Thinking";
  return (
    <div className="flex items-center gap-2.5 py-1 motion-safe:animate-fade-in">
      <JunoMark className="h-4 w-4 shrink-0 motion-safe:animate-icon-breathe" />
      <ThinkingDots className="text-primary/90" />
      <span
        key={label}
        className="font-mono text-label uppercase text-muted-foreground text-shimmer motion-safe:animate-fade-in"
      >
        {label}
      </span>
    </div>
  );
}

/** Generated video (kind FILE, video/*) — same chrome as image thumbnails, fades in when playable. */
function VideoAttachment({ attachment }: { attachment: ClientAttachment }) {
  const [ready, setReady] = React.useState(false);
  return (
    <div className="overflow-hidden rounded-xl border bg-muted shadow-soft transition-shadow duration-base hover:shadow-float">
      <video
        controls
        playsInline
        preload="metadata"
        src={attachment.url}
        title={attachment.fileName}
        onLoadedMetadata={() => setReady(true)}
        // Still show the player (with its own error UI) if metadata never loads.
        onError={() => setReady(true)}
        className={cn(
          "max-h-[420px] w-auto max-w-full transition-opacity duration-slow ease-out-soft",
          ready ? "opacity-100" : "opacity-0"
        )}
      />
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
              alt={a.fileName}
              width={160}
              height={160}
              className="max-h-40 w-auto rounded-lg border object-cover"
            />
          </a>
        ) : (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs transition-colors duration-fast hover:bg-accent"
          >
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="max-w-[180px] truncate font-medium">{a.fileName}</span>
            <span className="text-muted-foreground">{formatBytes(a.size)}</span>
            <Download className="h-3.5 w-3.5 text-muted-foreground" />
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
  const navClass =
    "flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-fast hover:text-foreground disabled:pointer-events-none disabled:opacity-35 coarse:h-9 coarse:w-9";
  return (
    <div className="mr-1 flex items-center font-mono text-caption text-muted-foreground/70">
      <button type="button" onClick={() => onStep(-1)} disabled={loading || index === 0} aria-label="Previous version" className={navClass}>
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-[3ch] text-center tabular-nums" aria-live="polite">
        {index + 1}/{total}
      </span>
      <button type="button" onClick={() => onStep(1)} disabled={loading || index === total - 1} aria-label="Next version" className={navClass}>
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function IconAction({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn("coarse:h-10 coarse:w-10", active && "text-primary")}
        >
          {children}
        </Button>
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
  onImageEdit?: (input: ImageEditInput) => void;
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

  const lineCount = view.content ? view.content.split("\n").length : 0;
  const isLong = view.content.length > 700 || lineCount > 14;

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


  const copy = async () => {
    await navigator.clipboard.writeText(view.content).catch(() => {});
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1500);
  };

  if (isUser) {
    return (
      <div className={cn("group flex flex-col items-end", animateIn && "motion-safe:animate-rise-in")}>
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
                  "relative w-full whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-border/50 bg-secondary px-4 py-2.5 text-body leading-relaxed [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-soft)]",
                  isLong && heightCapped && "overflow-hidden transition-[max-height] duration-slow ease-out-expo",
                  isLong && heightCapped && (expanded ? "max-h-[4000px]" : "max-h-60")
                )}
              >
                {view.content}
                {isLong && (
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-2xl bg-gradient-to-t from-secondary to-transparent transition-opacity duration-base ease-out-soft",
                      expanded ? "opacity-0" : "opacity-100"
                    )}
                  />
                )}
              </div>
              {isLong && (
                <button
                  type="button"
                  onClick={toggleExpanded}
                  className="mt-1 font-mono text-label uppercase text-muted-foreground transition-colors duration-fast hover:text-foreground"
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
              <IconAction label="Copy" onClick={copy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </IconAction>
              {onEdit && !busy && !privateMode && (
                // Prefill from the DISPLAYED version, so paging back and editing
                // is a one-step "resend an earlier wording".
                <IconAction label="Edit" onClick={() => { setDraft(view.content); setEditing(true); }}>
                  <Pencil className="h-4 w-4" />
                </IconAction>
              )}
              {onFork && !busy && !privateMode && (
                <IconAction label="Fork privately" onClick={() => onFork(message.id)}>
                  <GitFork className="h-4 w-4" />
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
  // Generated media: image attachments + video files (kind FILE, video/* mime).
  const mediaAttachments = message.attachments.filter((a) => a.kind === "IMAGE" || a.mimeType.startsWith("video/"));
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
      <div className="min-w-0 flex-1" aria-live={isVoice && message.streaming ? "off" : "polite"} aria-atomic="false">
        <ActivityTimeline
          messageId={message.id}
          events={view.activity}
          reasoning={view.reasoning}
          reasoningParts={view.reasoningParts}
          streaming={message.streaming}
        />
        {message.progress && !message.error ? (
          <GenerationPlaceholder progress={message.progress} />
        ) : showCursor ? (
          <StreamStatus status={status} />
        ) : message.error && !hasPartialWithError ? (
          <div className="space-y-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-sm text-destructive">
            <p>{message.content}</p>
            {onRegenerate && isLast && !busy && (
              <Button
                variant="outline"
                size="sm"
                onClick={onRegenerate}
                className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Try again
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
                    <div key={a.id} className="group/media relative">
                      <a
                        href={a.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block overflow-hidden rounded-xl border shadow-soft transition-shadow duration-base hover:shadow-float"
                      >
                        <Image
                          src={a.url}
                          alt={a.fileName}
                          width={512}
                          height={512}
                          className="max-h-[420px] w-auto object-contain"
                        />
                      </a>
                      {onImageEdit && currentModelId && !privateMode && !busy && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditTarget(a);
                            setEditOpen(true);
                          }}
                          aria-label={`Edit ${a.fileName}`}
                          className="absolute right-2 top-2 inline-flex h-8 items-center gap-1.5 rounded-full border border-border/60 bg-card/85 px-2.5 font-mono text-label uppercase text-foreground/85 opacity-0 shadow-soft backdrop-blur transition-all duration-base ease-out-soft hover:text-foreground active:scale-95 group-hover/media:opacity-100 focus-visible:opacity-100 coarse:h-10 coarse:opacity-100"
                        >
                          <SquareDashed className="h-3.5 w-3.5" aria-hidden="true" /> Edit
                        </button>
                      )}
                    </div>
                  )
                )}
              </div>
            )}
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
            {message.streaming && message.content.length > 0 && (
              <span
                className="ml-1 inline-block h-2 w-2 translate-y-[1px] rounded-full bg-primary align-middle motion-safe:animate-pulse"
                aria-hidden="true"
              />
            )}
            {(view.errorMessage || finishNote || canContinue) && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">{view.errorMessage ?? finishNote}</span>
                {canContinue && (
                  <Button type="button" variant="outline" size="sm" onClick={onContinue} className="h-7 gap-1.5">
                    <RefreshCw className="h-3.5 w-3.5" /> Continue
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer, below the answer it backs — the inline chips are the citation,
            this is the bibliography. */}
        {sources && sources.length > 0 && <SourcesPill sources={sources} />}

        {!isVoice && !message.streaming && !message.error && (modelName || hasUsage) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="mt-1 w-fit cursor-default font-mono text-caption text-muted-foreground/60">
                {modelName}
                {hasUsage ? `${modelName ? " · " : ""}${formatTokens((view.promptTokens ?? 0) + (view.completionTokens ?? 0))} tokens` : ""}
                {view.costUsd != null && view.costUsd > 0 ? ` · ~${formatUsd(view.costUsd)}` : ""}
              </p>
            </TooltipTrigger>
            <TooltipContent>
              {view.model}
              {hasUsage ? `${view.model ? " · " : ""}${formatTokens(view.promptTokens ?? 0)} in · ${formatTokens(view.completionTokens ?? 0)} out` : ""}
              {view.costUsd != null && view.costUsd > 0 ? ` · estimated ${formatUsd(view.costUsd)}` : ""}
            </TooltipContent>
          </Tooltip>
        )}

        {!isVoice && !message.streaming && !message.error && (
          <div className="mt-1.5 flex items-center">
            {totalVersions > 1 && (
              <VersionPager index={versionIndex} total={totalVersions} loading={versionsLoading} onStep={stepVersion} />
            )}
            <div className="flex items-center opacity-0 transition-opacity duration-base group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100">
              <IconAction label="Copy" onClick={copy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </IconAction>
              {onRegenerate && isLast && !busy && !privateMode && (
                <IconAction label="Regenerate" onClick={onRegenerate}>
                  <RefreshCw className="h-4 w-4" />
                </IconAction>
              )}
              {message.conversationId && !busy && !privateMode && (
                <IconAction label="Branch from here" onClick={branch}>
                  <GitBranch className="h-4 w-4" />
                </IconAction>
              )}
              {onFork && !busy && !privateMode && (
                <IconAction label="Fork privately" onClick={() => onFork(message.id)}>
                  <GitFork className="h-4 w-4" />
                </IconAction>
              )}
              {!privateMode && canFeedback && (
                <>
                  <IconAction label="Good response" onClick={() => onFeedback(message.id, message.feedback === "UP" ? null : "UP")} active={message.feedback === "UP"}>
                    <ThumbsUp className="h-4 w-4" />
                  </IconAction>
                  <IconAction label="Bad response" onClick={() => onFeedback(message.id, message.feedback === "DOWN" ? null : "DOWN")} active={message.feedback === "DOWN"}>
                    <ThumbsDown className="h-4 w-4" />
                  </IconAction>
                </>
              )}
              {onSpeak && (
                <IconAction
                  label={speaking ? "Stop" : "Read aloud"}
                  onClick={() => onSpeak(message.id, view.content)}
                  active={speaking}
                >
                  {speaking ? <Square className="h-4 w-4 fill-current" /> : <Volume2 className="h-4 w-4" />}
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
