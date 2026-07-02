"use client";

import * as React from "react";
import Image from "next/image";
import { toast } from "sonner";
import { Check, Copy, Download, FileText, GitFork, Globe, Pencil, RefreshCw, Sparkles, Square, SquareDashed, ThumbsDown, ThumbsUp, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "@/components/chat/markdown";
import { ArtifactInlineCard } from "@/components/chat/artifact-inline-card";
import { VisualLearningBlockRenderer } from "@/components/chat/learning/visual-learning-renderer";
import { ActivityTimeline } from "@/components/chat/activity-timeline";
import { GenerationPlaceholder } from "@/components/chat/generation-placeholder";
import { ImageEditOverlay } from "@/components/chat/image-edit-overlay";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { splitMessageContent } from "@/lib/message-content";
import { cn, formatBytes, formatTokens, formatUsd } from "@/lib/utils";
import type { ChatMessage, ImageEditInput } from "@/hooks/use-chat";
import type { ClientArtifact, ClientAttachment, ClientSource, GenerationStatus } from "@/types/chat";

/**
 * Premium "thinking → writing" indicator shown in the transcript while the
 * assistant works with no visible content yet. The dot constellation carries the
 * motion; the label crossfades and shimmers as the phase changes.
 */
function StreamStatus({ status }: { status?: GenerationStatus }) {
  const label = status === "writing" ? "Writing" : status === "checking" ? "Checking" : "Thinking";
  return (
    <div className="flex items-center gap-2.5 py-1 motion-safe:animate-fade-in">
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

function SourcesList({ sources }: { sources: ClientSource[] }) {
  const domainOf = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  return (
    <div className="mb-2">
      <p className="mb-1.5 flex items-center gap-1.5 font-mono text-label uppercase text-muted-foreground">
        <Globe className="h-3 w-3" /> {sources.length} {sources.length === 1 ? "source" : "sources"}
      </p>
      <div className="flex flex-wrap gap-2">
        {sources.map((s, i) => {
          const domain = domainOf(s.url);
          // Prefer a human title; fall back to the domain when the title is just the URL.
          const label = s.title && s.title !== s.url && !/^https?:\/\//.test(s.title) ? s.title : domain;
          return (
            <a
              key={i}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              title={s.title || s.url}
              className="group inline-flex max-w-[230px] items-center gap-1.5 rounded-lg border border-border/70 bg-card px-2 py-1 text-xs shadow-soft transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:border-source/40 hover:shadow-float"
            >
              <span className="font-mono text-caption text-source">[{i + 1}]</span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://www.google.com/s2/favicons?domain=${domain}&sz=32`}
                alt=""
                className="h-3.5 w-3.5 shrink-0 rounded-sm"
                loading="lazy"
              />
              <span className="min-w-0 flex-1 truncate text-foreground/85">{label}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
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
  onRegenerate: () => void;
  onContinue: () => void;
  onEdit: (id: string, content: string) => void;
  onFeedback: (id: string, value: "UP" | "DOWN" | null) => void;
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
  onFork,
  onSpeak,
  speaking,
  privateMode,
  onImageEdit,
  currentModelId,
}: MessageItemProps) {
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
  const lineCount = message.content ? message.content.split("\n").length : 0;
  const isLong = message.content.length > 700 || lineCount > 14;

  const toggleExpanded = () => {
    if (!expanded) {
      setExpanded(true);
      return;
    }
    // Restore the clamp first so the collapse animates from a real length.
    setHeightCapped(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setExpanded(false)));
  };
  const parts = React.useMemo(() => (isUser ? [] : splitMessageContent(message.content)), [isUser, message.content]);

  const copy = async () => {
    await navigator.clipboard.writeText(message.content).catch(() => {});
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
                  if (draft.trim() && draft.trim() !== message.content) onEdit(message.id, draft.trim());
                  setEditing(false);
                }}
              >
                Save &amp; submit
              </Button>
            </div>
          </div>
        ) : (
          message.content && (
            <div className="flex max-w-[85%] flex-col items-end">
              <div
                onTransitionEnd={(e) => {
                  if (e.target === e.currentTarget && e.propertyName === "max-height" && expanded) setHeightCapped(false);
                }}
                className={cn(
                  "relative w-full whitespace-pre-wrap rounded-2xl rounded-br-md border border-border/50 bg-secondary px-4 py-2.5 text-body leading-relaxed [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-soft)]",
                  isLong && heightCapped && "overflow-hidden transition-[max-height] duration-slow ease-out-expo",
                  isLong && heightCapped && (expanded ? "max-h-[4000px]" : "max-h-60")
                )}
              >
                {message.content}
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
        {!editing && !message.pending && (
          <div className="mt-1 flex opacity-0 transition-opacity duration-base group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100">
            <IconAction label="Copy" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </IconAction>
            {!busy && !privateMode && (
              <IconAction label="Edit" onClick={() => { setDraft(message.content); setEditing(true); }}>
                <Pencil className="h-4 w-4" />
              </IconAction>
            )}
            {onFork && !busy && !privateMode && (
              <IconAction label="Fork from here" onClick={() => onFork(message.id)}>
                <GitFork className="h-4 w-4" />
              </IconAction>
            )}
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
  const canContinue = isLast && !busy && (message.finishReason === "length" || message.finishReason === "network_error");
  const finishNote =
    message.finishReason === "length"
      ? "The model stopped at its token limit."
      : message.finishReason === "network_error"
        ? "The stream was interrupted. The partial answer was preserved."
        : message.finishReason === "user_stopped"
          ? "Stopped by user."
          : message.finishReason === "tool_calls"
            ? "The model requested tools, but no tool flow is enabled for this request."
            : message.finishReason === "sensitive"
              ? "The provider stopped the response for safety reasons."
              : null;

  return (
    <div className={cn("group flex flex-col gap-2", animateIn && "motion-safe:animate-rise-in")}>
      <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="false">
        <ActivityTimeline events={message.activity} reasoning={message.reasoning} streaming={message.streaming} />
        {message.sources && message.sources.length > 0 && <SourcesList sources={message.sources} />}
        {message.progress && !message.error ? (
          <GenerationPlaceholder progress={message.progress} />
        ) : showCursor ? (
          <StreamStatus status={status} />
        ) : message.error && !hasPartialWithError ? (
          <div className="space-y-2.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3.5 py-3 text-sm text-destructive">
            <p>{message.content}</p>
            {isLast && !busy && (
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
                <Markdown key={i} content={part.text} streaming={message.streaming} />
              ) : part.type === "artifact" ? (
                (() => {
                  const artifact = artifactsByIdentifier.get(part.identifier);
                  return (
                    <ArtifactInlineCard
                      key={i}
                      streaming={part.streaming && message.streaming}
                      title={artifact?.title ?? "Artifact"}
                      type={artifact?.type ?? "CODE"}
                      language={artifact?.language}
                      content={artifact?.content}
                      onOpen={part.identifier && artifact ? () => onOpenArtifact(part.identifier, { fullscreen: true }) : undefined}
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
            {(message.errorMessage || finishNote || canContinue) && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/45 px-3 py-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1">{message.errorMessage ?? finishNote}</span>
                {canContinue && (
                  <Button type="button" variant="outline" size="sm" onClick={onContinue} className="h-7 gap-1.5">
                    <RefreshCw className="h-3.5 w-3.5" /> Continue
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {!message.streaming && !message.error && (message.promptTokens != null || message.completionTokens != null) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="mt-1 w-fit cursor-default font-mono text-caption text-muted-foreground/60">
                {formatTokens((message.promptTokens ?? 0) + (message.completionTokens ?? 0))} tokens
                {message.costUsd != null && message.costUsd > 0 ? ` · ~${formatUsd(message.costUsd)}` : ""}
              </p>
            </TooltipTrigger>
            <TooltipContent>
              {formatTokens(message.promptTokens ?? 0)} in · {formatTokens(message.completionTokens ?? 0)} out
              {message.costUsd != null && message.costUsd > 0 ? ` · estimated ${formatUsd(message.costUsd)}` : ""}
            </TooltipContent>
          </Tooltip>
        )}

        {!message.streaming && !message.error && (
          <div className="mt-1.5 flex items-center opacity-0 transition-opacity duration-base group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100">
            <IconAction label="Copy" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </IconAction>
            {isLast && !busy && !privateMode && (
              <IconAction label="Regenerate" onClick={onRegenerate}>
                <RefreshCw className="h-4 w-4" />
              </IconAction>
            )}
            {onFork && !busy && !privateMode && (
              <IconAction label="Fork from here" onClick={() => onFork(message.id)}>
                <GitFork className="h-4 w-4" />
              </IconAction>
            )}
            {!privateMode && (
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
                onClick={() => onSpeak(message.id, message.content)}
                active={speaking}
              >
                {speaking ? <Square className="h-4 w-4 fill-current" /> : <Volume2 className="h-4 w-4" />}
              </IconAction>
            )}
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
