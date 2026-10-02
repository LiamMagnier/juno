"use client";

import * as React from "react";
import Image from "next/image";
import { FilePreview } from "@/components/chat/file-preview";
import { requiresViewerCredentials } from "@/lib/image-source";
import { formatLabelOf, fileExtension } from "@/lib/documents/viewer-kind";
import { cn, formatBytes } from "@/lib/utils";
import type { ClientAttachment } from "@/types/chat";

/* ─────────────────────────────────────────────────────────────────────────────
 * WHAT YOU SENT, AS SOMETHING YOU CAN OPEN.
 *
 * A sent file used to be a pill — glyph, name, size, and a download arrow —
 * and pressing it downloaded the file. Two things were wrong with that. The
 * pill said nothing about the document: three reports in one conversation were
 * three identical pills. And the only thing it did was take the file out of
 * Juno, when the reason it was here was to be asked about.
 *
 * So a file is a square now, like the one in the composer a moment before it
 * was sent: the document's first page on a sheet of paper, its name, what kind
 * of file it is and how big — and pressing it opens the file beside the chat,
 * where it can be read, searched, and asked about by the passage or the figure.
 * Downloading moved into the viewer, where it is one press away and no longer
 * the default consequence of looking.
 *
 * The page comes from `FilePreview`: a rendered first page for a PDF, the
 * opening lines for text and office files, the extension where neither exists —
 * the same ladder the Library and the composer draw, so a file looks like
 * itself in all three places.
 * ───────────────────────────────────────────────────────────────────────────── */

export function AttachmentTile({
  attachment,
  onOpen,
}: {
  attachment: ClientAttachment;
  onOpen?: (attachment: ClientAttachment) => void;
}) {
  const ext = fileExtension(attachment.fileName);
  const stem = ext ? attachment.fileName.slice(0, -(ext.length + 1)) : attachment.fileName;
  const meta = [formatLabelOf(attachment), attachment.size ? formatBytes(attachment.size) : null].filter(Boolean).join(" · ");

  const body = (
    <>
      {/* The sheet, set into a tinted well and cropped by the caption band —
          the top of a page, which is the part a document is recognised by. */}
      <span aria-hidden className="absolute inset-x-0 top-0 bottom-12 overflow-hidden bg-secondary">
        <span
          className={cn(
            "absolute inset-x-3.5 -bottom-px top-3 overflow-hidden rounded-t-xs border border-b-0 border-border/70 bg-card shadow-raised",
            "transition-transform duration-base ease-out-soft group-hover/tile:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover/tile:translate-y-0",
          )}
        >
          <FilePreview
            item={{
              id: attachment.id,
              kind: "FILE",
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              url: attachment.url,
            }}
            className="absolute inset-0"
            sizes="120px"
            badge={false}
          />
        </span>
      </span>
      <span className="absolute inset-x-0 bottom-0 flex h-12 flex-col justify-center gap-0.5 border-t border-border/60 bg-card px-3">
        <span data-no-auto-translate className="truncate text-caption font-medium leading-tight text-foreground">
          {stem || attachment.fileName}
        </span>
        <span className="truncate font-mono text-micro text-muted-foreground">{meta}</span>
      </span>
    </>
  );

  const frame =
    "group/tile relative block size-36 shrink-0 overflow-hidden rounded-card border border-border/70 bg-card text-left transition-[border-color,box-shadow] duration-fast ease-out-soft";

  if (!onOpen) {
    return (
      <a href={attachment.url} download={attachment.fileName} title={attachment.fileName} className={cn(frame, "hover:border-border")}>
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(attachment)}
      title={attachment.fileName}
      aria-label={`Open ${attachment.fileName}`}
      className={cn(frame, "hover:border-foreground/25 hover:shadow-raised")}
    >
      {body}
    </button>
  );
}

/** A sent image: itself, at the transcript's thumbnail height, opening in the viewer. */
export function ImageTile({ attachment, onOpen }: { attachment: ClientAttachment; onOpen?: (attachment: ClientAttachment) => void }) {
  const image = (
    <Image
      src={attachment.url}
      unoptimized={requiresViewerCredentials(attachment.url)}
      alt={attachment.fileName}
      width={attachment.width ?? 160}
      height={attachment.height ?? 160}
      className="h-36 w-auto max-w-[18rem] object-cover transition-transform duration-base ease-out-soft group-hover/tile:scale-[1.015] motion-reduce:transition-none motion-reduce:group-hover/tile:scale-100"
    />
  );
  const frame = "group/tile block overflow-hidden rounded-card border border-border/70 bg-secondary transition-[border-color,box-shadow] duration-fast ease-out-soft hover:border-foreground/25 hover:shadow-raised";
  if (!onOpen) {
    return (
      <a href={attachment.url} target="_blank" rel="noopener noreferrer" className={frame}>
        {image}
      </a>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(attachment)} aria-label={`Open ${attachment.fileName}`} className={frame}>
      {image}
    </button>
  );
}

export function MessageAttachments({
  attachments,
  onOpen,
  className,
}: {
  attachments: ClientAttachment[];
  onOpen?: (attachment: ClientAttachment) => void;
  className?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className={cn("mb-2 flex max-w-full flex-wrap justify-end gap-2", className)}>
      {attachments.map((a) =>
        a.kind === "IMAGE" ? (
          <ImageTile key={a.id} attachment={a} onOpen={onOpen} />
        ) : (
          <AttachmentTile key={a.id} attachment={a} onOpen={onOpen} />
        ),
      )}
    </div>
  );
}
