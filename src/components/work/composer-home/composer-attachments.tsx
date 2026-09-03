"use client";

import { ComposerAttachmentRow } from "@/components/ui/composer-shell";
import type { PendingUpload } from "@/hooks/use-uploads";
import { DOC_MIME } from "@/lib/uploads";

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
 * The thumbnails, above the field: the product-wide 56px tile row, so a file
 * handed to a task looks exactly like one attached to a chat. Tiles pop in and
 * out on the spring; the row takes no space while it is empty.
 */
export function WorkComposerAttachments({
  uploads,
  onRemove,
}: {
  uploads: readonly PendingUpload[];
  onRemove: (localId: string) => void;
}) {
  return <ComposerAttachmentRow uploads={uploads} onRemove={onRemove} />;
}
