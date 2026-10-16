"use client";

import * as React from "react";
import { AlertTriangle, FileText, RotateCcw, X } from "@/components/ui/icons";
import { useShellString } from "@/components/ui/use-shell-string";
import { cn } from "@/lib/utils";

/**
 * ATTACHMENTS AND QUOTES THAT TRAVEL (spec P2 (15), C17).
 *
 * One component for a file or an image wherever it sits: in the composer's
 * above-slot while it uploads, and in the sent bubble after it travels there
 * (the FLIP lands it at the same size, because it is the same component).
 *
 *   file   224 × 56 at radius 12: a document glyph, the name, the kind and size
 *   image  64 × 64 at radius 10: the picture itself
 *
 * UPLOADING shows a progress arc, never a spinner (spec §3.10). FAILED shows
 * the warning glyph, "Failed" and a Retry button, so a failure is a glyph and a
 * word, never colour alone. `layoutId` is a stable `data-layout-id` for the
 * FLIP. Joining the composer, a chip settles on the reward spring (P5 call
 * site); leaving, it fades.
 */

export type AttachmentState = "ready" | "uploading" | "failed";

export interface AttachmentChipProps {
  kind: "file" | "image";
  name: string;
  /** "PDF · 2.4 MB" — the kind and size, already formatted. */
  meta?: string;
  /** An image's preview URL (object URL or served thumbnail). */
  src?: string;
  state?: AttachmentState;
  /** 0..1 while uploading. */
  progress?: number;
  onRemove?: () => void;
  onRetry?: () => void;
  onOpen?: () => void;
  /** Stable id for the FLIP from the composer into the bubble. */
  layoutId?: string;
  className?: string;
}

export const ATTACHMENT_CHIP_SIZE = {
  file: { width: 224, height: 56, radius: 12 },
  image: { width: 64, height: 64, radius: 10 },
} as const;

/** The progress arc's dash offset for a 0..1 progress on a circle of `circumference`. */
export function progressDashOffset(progress: number, circumference: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return circumference * (1 - p);
}

function ProgressArc({ progress, size = 20 }: { progress: number; size?: number }) {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border))" strokeWidth={2} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={progressDashOffset(progress, c)}
        className="transition-[stroke-dashoffset] duration-fast ease-out-soft"
      />
    </svg>
  );
}

export function AttachmentChip({
  kind,
  name,
  meta,
  src,
  state = "ready",
  progress = 0,
  onRemove,
  onRetry,
  onOpen,
  layoutId,
  className,
}: AttachmentChipProps) {
  const size = ATTACHMENT_CHIP_SIZE[kind];
  const failed = state === "failed";
  const uploading = state === "uploading";
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const status = failed ? "Failed" : uploading ? `${percent}%` : null;
  const Body = onOpen && !failed ? "button" : "div";
  return (
    <div
      className={cn("ui-attachment-chip group relative shrink-0 bg-card text-left", failed ? "border border-destructive" : "border border-border", className)}
      style={{ width: size.width, height: size.height, borderRadius: size.radius }}
      data-kind={kind}
      data-state={state}
      data-layout-id={layoutId}
      data-tone-step=""
    >
      <Body
        {...(Body === "button" ? { type: "button" as const, onClick: onOpen } : {})}
        className={cn("flex h-full w-full min-w-0 items-center overflow-hidden", kind === "file" ? "gap-2.5 px-2.5" : "justify-center")}
        style={{ borderRadius: size.radius }}
        aria-label={kind === "image" ? name : undefined}
      >
        {kind === "image" ? (
          src ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local object URL or a served thumbnail, not an optimisable asset
            <img src={src} alt="" className={cn("h-full w-full object-cover", (uploading || failed) && "opacity-60")} />
          ) : (
            <FileText className="size-5 text-muted-foreground" />
          )
        ) : (
          <>
            <span className="grid size-9 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground">
              {failed ? <AlertTriangle className="size-4 text-destructive" /> : uploading ? <ProgressArc progress={progress} /> : <FileText className="size-4" />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-ui text-foreground">{name}</span>
              <span className={cn("truncate text-label", failed ? "text-destructive" : "text-muted-foreground")}>{status ?? meta}</span>
            </span>
          </>
        )}
      </Body>
      {kind === "image" && (uploading || failed) ? (
        <span className="pointer-events-none absolute inset-0 grid place-items-center text-foreground">
          {failed ? <AlertTriangle className="size-5 text-destructive" /> : <ProgressArc progress={progress} size={24} />}
        </span>
      ) : null}
      {kind === "image" && failed ? <span className="sr-only">Failed</span> : null}
      {uploading ? (
        <span className="sr-only" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={name} />
      ) : null}
      {failed && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "absolute inline-flex items-center gap-1 rounded-control bg-background px-1.5 py-0.5 text-ui text-foreground hover:bg-accent",
            kind === "file" ? "right-8 top-1/2 -translate-y-1/2" : "bottom-1 left-1/2 -translate-x-1/2"
          )}
        >
          <RotateCcw className="size-3.5" aria-hidden />
          <span>Retry</span>
        </button>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/**
 * A quoted selection, travelling from the answer into the composer and then
 * into the sent bubble (C17): labelled "Selection" (the shared table), the
 * quote clamped to three lines. Same component in both places, same layoutId.
 */
export function QuoteCard({
  text,
  onRemove,
  layoutId,
  className,
}: {
  text: string;
  onRemove?: () => void;
  layoutId?: string;
  className?: string;
}) {
  const t = useShellString();
  const label = t("transcript.selection");
  return (
    <figure
      className={cn("ui-quote-card group relative max-w-full rounded-card border border-border bg-card px-3 py-2", className)}
      data-layout-id={layoutId}
      data-tone-step=""
      aria-label={label}
    >
      <figcaption className="text-label text-muted-foreground">{label}</figcaption>
      <blockquote className="mt-0.5 line-clamp-3 border-s-2 border-border ps-2 text-ui text-foreground">{text}</blockquote>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label.toLowerCase()}`}
          className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </figure>
  );
}
