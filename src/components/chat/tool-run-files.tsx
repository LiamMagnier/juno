"use client";

/**
 * What a turn's runs MADE, and what they announce: the light half of the run
 * surface (tool-run.tsx holds the rows and the detail).
 *
 * Split out because the run strip renders on every turn and imports this, and
 * the detail's code blocks have no business in that bundle. Every word comes
 * from `@/lib/chat/tool-run`.
 */

import * as React from "react";
import { AttachmentTile, ImageTile } from "@/components/chat/attachment-tile";
import { ReceiptGlyph } from "@/components/chat/tool-receipt";
import { pendingRunAnnouncements, readToolRuns, type ToolRunFile, type ToolRunPhase, type ToolRunView } from "@/lib/chat/tool-run";
import { cn, formatBytes } from "@/lib/utils";
import type { ClientActivityEvent, ClientAttachment } from "@/types/chat";

/* ── Files ──────────────────────────────────────────────────────────────── */

function asAttachment(file: ToolRunFile, index: number): ClientAttachment | null {
  if (!file.url) return null;
  return {
    id: file.attachmentId ?? `run-file-${index}`,
    kind: file.kind === "image" ? "IMAGE" : "FILE",
    fileName: file.name,
    mimeType: file.mime,
    size: file.bytes ?? 0,
    url: file.url,
    width: file.width,
    height: file.height,
  };
}

/** A produced file with no link on this row: named, sized, and said to be attached. */
function UnlinkedFileCard({ file }: { file: ToolRunFile }) {
  return (
    <div className="flex h-12 min-w-0 max-w-[18rem] items-center gap-2.5 rounded-field border border-border/70 bg-card px-3">
      <ReceiptGlyph kind={file.kind === "image" ? "image" : "file"} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span data-no-auto-translate className="block truncate text-caption font-medium text-foreground">
          {file.name}
        </span>
        <span className="block truncate font-mono text-micro text-muted-foreground">
          {[file.bytes !== null ? formatBytes(file.bytes) : null, "In this conversation's files"].filter(Boolean).join(" · ")}
        </span>
      </span>
    </div>
  );
}

/**
 * What runs made: images as themselves, other files as tiles. The files are
 * conversation attachments (`origin: "tool_output"`), so these are the same
 * objects the Library lists under "Made by Alevr".
 */
export function ToolRunFiles({
  files,
  onOpen,
  className,
}: {
  files: readonly ToolRunFile[];
  onOpen?: (attachment: ClientAttachment) => void;
  className?: string;
}) {
  if (files.length === 0) return null;
  return (
    <ul role="list" aria-label="Files this run made" className={cn("flex max-w-full flex-wrap gap-2", className)}>
      {files.map((file, index) => {
        const attachment = asAttachment(file, index);
        return (
          <li key={`${file.attachmentId ?? file.name}-${index}`} className="min-w-0">
            {!attachment ? (
              <UnlinkedFileCard file={file} />
            ) : attachment.kind === "IMAGE" ? (
              <ImageTile attachment={attachment} onOpen={onOpen} />
            ) : (
              <AttachmentTile attachment={attachment} onOpen={onOpen} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ── Announcements ──────────────────────────────────────────────────────── */

/**
 * The polite live region for a turn's runs: one sentence per phase change.
 *
 * A stored conversation announces nothing (the first render seeds what has
 * already been said). Visually hidden; the rows say the same thing on screen.
 */
export function ToolRunAnnouncer({ views, live }: { views: readonly ToolRunView[]; live: boolean }) {
  const seen = React.useRef<Map<string, ToolRunPhase> | null>(null);
  const [message, setMessage] = React.useState("");
  React.useEffect(() => {
    const first = seen.current === null;
    if (first) seen.current = new Map();
    const said = pendingRunAnnouncements(views, seen.current!, { initial: first, live });
    if (said.length) setMessage(said.join(" "));
  }, [views, live]);
  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-run-announcer>
      {message}
    </span>
  );
}

/* ── Turn level ─────────────────────────────────────────────────────────── */

/**
 * The files every run of a turn made, under the run strip and above the
 * answer: the reader sees the chart or the workbook without opening the
 * Thought process. Also the turn's run announcer.
 */
export function ToolRunOutputs({
  events,
  streaming,
  attachments,
  onOpenFile,
  className,
}: {
  events: readonly ClientActivityEvent[] | null | undefined;
  streaming: boolean;
  /** The message's own attachments. A run file already among them is drawn by
   *  the message (as an image or a tile), so it is not drawn here again; one
   *  that is not yet (the reply is still streaming) is drawn here. */
  attachments?: readonly ClientAttachment[];
  onOpenFile?: (attachment: ClientAttachment) => void;
  className?: string;
}) {
  const views = React.useMemo(() => readToolRuns(events, { live: streaming }), [events, streaming]);
  if (views.length === 0) return null;
  const owned = new Set((attachments ?? []).map((a) => a.id));
  const files = views
    .flatMap((view) => (view.phase === "succeeded" || view.phase === "failed" ? view.files : []))
    .filter((file) => !file.attachmentId || !owned.has(file.attachmentId));
  return (
    <>
      <ToolRunAnnouncer views={views} live={streaming} />
      {files.length ? <ToolRunFiles files={files} onOpen={onOpenFile} className={cn("mb-2", className)} /> : null}
    </>
  );
}

