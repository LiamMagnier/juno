"use client";

import * as React from "react";
import Image from "next/image";
import { toast } from "sonner";
import { Check, Copy, Download, FileText, Globe, Pencil, RefreshCw, Sparkles, Square, ThumbsDown, ThumbsUp, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "@/components/chat/markdown";
import { ArtifactInlineCard } from "@/components/chat/artifact-inline-card";
import { ActivityTimeline } from "@/components/chat/activity-timeline";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { splitMessageContent } from "@/lib/message-content";
import { cn, formatBytes } from "@/lib/utils";
import type { ChatMessage } from "@/hooks/use-chat";
import type { ClientArtifact, ClientAttachment, ClientSource } from "@/types/chat";

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
      <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
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
              <span className="font-mono text-[10px] text-source">[{i + 1}]</span>
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
            className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs hover:bg-accent"
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
          className={cn(active && "text-primary")}
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
  animateIn?: boolean;
  artifactsByIdentifier: Map<string, ClientArtifact>;
  onOpenArtifact: (identifier: string) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  onEdit: (id: string, content: string) => void;
  onFeedback: (id: string, value: "UP" | "DOWN" | null) => void;
  onSpeak?: (id: string, text: string) => void;
  speaking?: boolean;
  privateMode?: boolean;
}

export function MessageItem({
  message,
  isLast,
  busy,
  animateIn,
  artifactsByIdentifier,
  onOpenArtifact,
  onRegenerate,
  onContinue,
  onEdit,
  onFeedback,
  onSpeak,
  speaking,
  privateMode,
}: MessageItemProps) {
  const [copied, setCopied] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(message.content);
  const [expanded, setExpanded] = React.useState(false);
  const isUser = message.role === "USER";
  const lineCount = message.content ? message.content.split("\n").length : 0;
  const isLong = message.content.length > 700 || lineCount > 14;

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
                className={cn(
                  "relative w-full whitespace-pre-wrap rounded-2xl rounded-br-md border border-border/60 bg-secondary px-4 py-2.5 text-body leading-relaxed shadow-soft",
                  isLong && !expanded && "max-h-60 overflow-hidden"
                )}
              >
                {message.content}
                {isLong && !expanded && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-2xl bg-gradient-to-t from-secondary to-transparent" />
                )}
              </div>
              {isLong && (
                <button
                  type="button"
                  onClick={() => setExpanded((e) => !e)}
                  className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                >
                  {expanded ? "Show less" : `Show more · ${lineCount} lines`}
                </button>
              )}
            </div>
          )
        )}
        {!editing && !message.pending && (
          <div className="mt-1 flex opacity-0 transition-opacity duration-base group-hover:opacity-100 focus-within:opacity-100">
            <IconAction label="Copy" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </IconAction>
            {!busy && !privateMode && (
              <IconAction label="Edit" onClick={() => { setDraft(message.content); setEditing(true); }}>
                <Pencil className="h-4 w-4" />
              </IconAction>
            )}
          </div>
        )}
      </div>
    );
  }

  // Assistant message
  const parts = splitMessageContent(message.content);
  const showCursor = message.streaming && message.content.length === 0;
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
    <div className={cn("group flex gap-3", animateIn && "motion-safe:animate-rise-in")}>
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card shadow-soft">
        {message.streaming ? (
          <svg className="h-4 w-4 text-primary animate-[spin_4s_linear_infinite]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" strokeDasharray="3 3" className="opacity-60" />
            <circle cx="12" cy="12" r="4" fill="currentColor" className="animate-pulse opacity-80" stroke="none" />
          </svg>
        ) : (
          <Sparkles className="h-4 w-4 text-primary" />
        )}
      </div>
      <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="false">
        <ActivityTimeline events={message.activity} reasoning={message.reasoning} streaming={message.streaming} />
        {message.sources && message.sources.length > 0 && <SourcesList sources={message.sources} />}
        {showCursor ? (
          <div className="flex h-6 items-center">
            <ThinkingDots />
          </div>
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
            {message.attachments.some((a) => a.kind === "IMAGE") && (
              <div className="mb-1 flex flex-wrap gap-2">
                {message.attachments
                  .filter((a) => a.kind === "IMAGE")
                  .map((a) => (
                    <a
                      key={a.id}
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
                  ))}
              </div>
            )}
            {parts.map((part, i) =>
              part.type === "text" ? (
                <Markdown key={i} content={part.text} />
              ) : (
                <ArtifactInlineCard
                  key={i}
                  streaming={part.streaming && message.streaming}
                  title={artifactsByIdentifier.get(part.identifier)?.title ?? "Artifact"}
                  type={artifactsByIdentifier.get(part.identifier)?.type ?? "CODE"}
                  onOpen={part.identifier && artifactsByIdentifier.has(part.identifier) ? () => onOpenArtifact(part.identifier) : undefined}
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

        {!message.streaming && !message.error && (
          <div className="mt-1.5 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <IconAction label="Copy" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </IconAction>
            {isLast && !busy && !privateMode && (
              <IconAction label="Regenerate" onClick={onRegenerate}>
                <RefreshCw className="h-4 w-4" />
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
    </div>
  );
}
