"use client";

import * as React from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { Pressable } from "@/components/ui/pressable";
import { ActionIcons, CodeIcons } from "@/lib/app-icons";
import type { PendingUpload } from "@/hooks/use-uploads";
import { requiresViewerCredentials } from "@/lib/image-source";
import { DOC_MIME } from "@/lib/uploads";
import { cn, formatBytes } from "@/lib/utils";

/*
 * The documents a task is being handed, as chips above the field.
 *
 * Extracted from `work-composer.tsx`, where it was ninety lines of JSX inside
 * the `above` prop of `ComposerShell` — nested four levels deep in a component
 * that was already two thousand lines long, and the one part of that file with
 * no bearing whatsoever on whether the task can start.
 */

/**
 * What the file picker offers, which is deliberately narrower than the chat
 * composer's `ACCEPT_ATTRIBUTE`: the same list with every image type removed.
 *
 * A Work run is handed its attachments by `attachedSources` in
 * scripts/work-runner.ts, which reads `Attachment.extractedText` and nothing
 * else. That column is null for an image, so a photo reached the model as a file
 * name with no content behind it — the reader saw a thumbnail in the composer
 * and got an agent that had never seen the picture. Offering the picker and
 * then reporting that nothing could be read out of the file is a worse answer
 * than not offering it, because nothing in the menu distinguishes the two.
 *
 * The document types stay, PDFs included, even though a PDF has no extracted
 * text either. The difference is what is being promised: a document is handed
 * over to be worked from, the run now says out loud when it could not read one,
 * and the reader can act on that. "Photos" promised Juno would look at a
 * picture, which is the one thing this path can never do.
 *
 * The Code composer keeps its Photos entry. That path sends attachments to a
 * different runtime and is not affected by any of this.
 */
export const WORK_ACCEPT_ATTRIBUTE = [
  ...DOC_MIME,
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".py",
].join(",");

/**
 * How long a chip is left playing its exit before the upload is dropped from
 * state.
 *
 * Matched to `--dur-exit` by eye rather than by import, because the exit is a
 * CSS keyframe (`animate-pop-out`) and there is no way to read its length back
 * from here. Too short and the chip vanishes mid-fade; too long and the row
 * holds a gap after the chip has finished leaving. Both are recoverable, which
 * is why a hand-kept number is acceptable and a hand-kept LAYOUT number would
 * not be.
 */
const REMOVE_EXIT_MS = 180;

/**
 * The chips, and the strip that grows to hold them.
 *
 * The strip is a `grid-rows-[0fr]` → `[1fr]` transition rather than a height
 * animation: the row's height is whatever the chips wrap to, and a composer
 * whose attachment area jumped from 0 to 56px the instant a file was picked
 * pushed the whole utility strip — the one part of this surface that is supposed
 * to sit still — down the page in a single frame.
 */
export function WorkComposerAttachments({
  uploads,
  onRemove,
}: {
  uploads: readonly PendingUpload[];
  onRemove: (localId: string) => void;
}) {
  /** The chips playing their exit, which are still in `uploads` until it ends. */
  const [leaving, setLeaving] = React.useState<string[]>([]);
  const timers = React.useRef(new Map<string, number>());

  // Every pending timeout is cleared on unmount. Without this, a reader who
  // takes a file off and immediately presses Start leaves a callback that fires
  // `onRemove` into a composer that has already navigated away.
  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const remove = React.useCallback(
    (localId: string) => {
      if (timers.current.has(localId)) return;
      setLeaving((current) => [...current, localId]);
      timers.current.set(
        localId,
        window.setTimeout(() => {
          timers.current.delete(localId);
          onRemove(localId);
          setLeaving((current) => current.filter((id) => id !== localId));
        }, REMOVE_EXIT_MS)
      );
    },
    [onRemove]
  );

  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
        uploads.length > 0 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="flex flex-wrap gap-2 px-3 pb-0 pt-2.5 sm:px-3.5">
          {uploads.map((upload) => (
            <AttachmentChip
              key={upload.localId}
              upload={upload}
              leaving={leaving.includes(upload.localId)}
              onRemove={() => remove(upload.localId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AttachmentChip({
  upload,
  leaving,
  onRemove,
}: {
  upload: PendingUpload;
  leaving: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        // `rounded-control`, the same rung the thread composer's attachment rows
        // sit on — these were 8px there and 24px here for the same object in the
        // same product.
        //
        // `bg-secondary`, not `bg-background` + `shadow-soft`. The shell around
        // this chip is `bg-card`; on a pure-black ground `bg-background` made the
        // chip darker than the surface holding it, and `--shadow-soft` in dark is
        // black ink, so the elevation cue did nothing at all. On black the lift
        // has to come from lightness.
        "flex items-center gap-2 rounded-control border border-border/60 bg-secondary px-2.5 py-2 text-caption",
        leaving ? "pointer-events-none motion-safe:animate-pop-out" : "motion-safe:animate-rise-in"
      )}
    >
      {upload.attachment?.kind === "IMAGE" ? (
        <Image
          src={upload.attachment.url}
          unoptimized={requiresViewerCredentials(upload.attachment.url)}
          alt={upload.fileName}
          width={32}
          height={32}
          className="size-8 rounded-field object-cover"
        />
      ) : (
        <CodeIcons.file className="size-5 text-muted-foreground" aria-hidden="true" />
      )}
      <div className="max-w-[140px]">
        <p className="truncate font-medium">{upload.fileName}</p>
        <p className={cn(upload.status === "error" ? "text-destructive" : "text-muted-foreground")}>
          {upload.status === "uploading"
            ? `${upload.progress}%`
            : // Said in the destructive ink rather than in the same muted grey as
              // a byte count. A failed upload read exactly like a successful one
              // at a glance, on the one line that decides whether the task will
              // be given the file at all.
              upload.status === "error"
              ? "Failed"
              : formatBytes(upload.size)}
        </p>
      </div>
      {upload.status === "uploading" && (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
      )}
      {/* Taking a file back off is one affordance in both Work composers: a
          circular `Pressable kind="icon"` at one hit size, inline. This was an
          inverted badge floated outside the chip and hidden until hover, against
          an ~18px square glyph in the thread — two shapes and two target sizes
          for the same act. */}
      <Pressable
        kind="icon"
        size="sm"
        onClick={onRemove}
        className="-mr-1 shrink-0"
        aria-label={`Remove ${upload.fileName}`}
      >
        <ActionIcons.dismiss className="size-3.5" aria-hidden="true" />
      </Pressable>
    </div>
  );
}
