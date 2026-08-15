"use client";

import * as React from "react";
import { FileSearch, Loader2 } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * What structured extraction made of one uploaded file.
 *
 * Indexing runs *after* the upload response (see `scheduleIngest`), so without
 * this line a user has no way to learn that their scanned PDF produced nothing
 * citable — the file would sit in the library looking perfectly fine. The
 * degraded and failed cases therefore lead with the extractor's own sentence
 * rather than a status word: "This PDF has no text layer" is actionable,
 * "degraded" is not.
 *
 * Files no extractor claims (images, video) pass `null` and render nothing.
 * A photo is not a document that failed to index, and marking it as one would
 * make every screenshot look like a problem.
 */
export interface KnowledgeIndexState {
  /** queued | extracting | ocr | indexing | ready | degraded | failed | stale */
  state: string;
  /** The extractor's reason, already written for a reader. */
  error: string | null;
  blockCount: number;
  pageCount: number | null;
}

const IN_PROGRESS = new Set(["queued", "extracting", "ocr", "indexing"]);

export function IndexStatus({
  status,
  className,
}: {
  status: KnowledgeIndexState | null;
  className?: string;
}) {
  if (!status) return null;

  const shared = "inline-flex min-w-0 items-center gap-1.5 text-caption";

  if (IN_PROGRESS.has(status.state)) {
    return (
      // aria-live: the row is already on screen when indexing finishes, so the
      // change has to be announced rather than merely rendered.
      <span className={cn(shared, "text-muted-foreground", className)} aria-live="polite">
        <Loader2
          className="size-3 shrink-0 motion-safe:animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span className="truncate">Indexing for search…</span>
      </span>
    );
  }

  if (status.state === "failed") {
    return (
      <span className={cn(shared, "text-destructive-ink", className)} aria-live="polite">
        <StatusIcons.error className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate" title={status.error ?? undefined}>
          {status.error ?? "This file could not be indexed."}
        </span>
      </span>
    );
  }

  if (status.state === "degraded") {
    return (
      <span className={cn(shared, "text-warning-foreground", className)} aria-live="polite">
        <StatusIcons.warning className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate" title={status.error ?? undefined}>
          {status.error ?? "Only part of this file could be indexed."}
        </span>
      </span>
    );
  }

  if (status.state !== "ready") return null;

  const detail = status.pageCount
    ? `${status.blockCount} passages across ${status.pageCount} pages`
    : `${status.blockCount} ${status.blockCount === 1 ? "passage" : "passages"}`;

  return (
    <span className={cn(shared, "text-muted-foreground", className)}>
      <FileSearch className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate" title={`Indexed for search — ${detail}`}>
        Indexed · {detail}
      </span>
    </span>
  );
}
