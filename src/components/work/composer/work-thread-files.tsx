"use client";

import * as React from "react";
import { useUploads } from "@/hooks/use-uploads";
import type { WorkThreadContextState } from "@/components/work/composer/use-work-thread-context";
import { DOC_MIME } from "@/lib/uploads";

/**
 * Documents on their way to a running task.
 *
 * ── Why this is a hook and not a section of the [+] panel ──────────────────
 *
 * It was inside `WorkThreadAddPanel`, which lives inside a Radix popover, and
 * Radix unmounts a popover's content when it closes. So `useUploads` — and with
 * it every in-flight upload, every finished-but-not-yet-handed-over attachment
 * and the whole upload list — was destroyed the moment the reader dismissed the
 * menu. That was not an unlikely path: handing files over is deliberately a
 * SECOND press ("Give it this file"), so the reader has every reason to close
 * the menu, read the transcript and come back, and doing so silently threw the
 * upload away. Owned by the composer, the uploads outlive the menu and finally
 * have somewhere to be seen — a chip strip above the field, the same one the
 * home composer draws.
 *
 * ── Handing over is still a press ──────────────────────────────────────────
 *
 * Not a side effect of the upload finishing. A reader who picked three files
 * gets one request and one sentence instead of three, and a request that fails
 * leaves the button exactly where it was — a retry that costs nothing and needs
 * no machinery to offer. The WHOLE list is sent, not the new ids alone:
 * `WorkFileGrant` rows are what the next dispatch reads, and a partial list is
 * only safe if the route is certain to treat it as an addition. Sending what the
 * task should end up with is correct under either reading.
 */

/**
 * What the picker offers — the chat composer's document list with every image
 * type removed, for the reason the home composer gives: `attachedSources` in
 * scripts/work-runner.ts reads `Attachment.extractedText`, which is null for a
 * photo. Offering images would promise Juno a look at a picture it can never
 * get.
 *
 * This is the second copy of that list in the product and the duplication is
 * deliberate rather than lazy: `work-composer.tsx` holds the other, each with
 * its own statement of the reason, so that anybody widening one is told by the
 * comment beside it what the exclusion is protecting. There is no third.
 */
const WORK_ACCEPT_ATTRIBUTE = [
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

export interface WorkThreadFiles {
  /** Everything picked this session, whatever state it is in. */
  uploads: ReturnType<typeof useUploads>["uploads"];
  /** Opens the file picker. */
  pick: () => void;
  /** Takes one back off before it has been handed over. */
  remove: (localId: string) => void;
  /** At least one upload is still going. Holds the hand-over button. */
  isUploading: boolean;
  /** Uploaded, and not yet on the task. */
  pending: ReturnType<typeof useUploads>["readyAttachments"];
  /** Sends the whole attachment list through `PATCH /sessions/[id]/context`. */
  hand: () => void;
  /** Adds ids the library dialog produced, skipping any the task already holds. */
  attachFromLibrary: (attachments: readonly { id: string }[]) => void;
  /** Render once, anywhere inside the composer. Owns nothing visible. */
  input: React.ReactNode;
}

export function useWorkThreadFiles(context: WorkThreadContextState): WorkThreadFiles {
  // `null` conversation: these files belong to a Work task, not to a chat. The
  // upload route accepts that and the ids are handed to the session separately.
  const { uploads, addFiles, remove, isUploading, readyAttachments } = useUploads(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const pending = readyAttachments.filter(
    (attachment) => !context.attachmentIds.includes(attachment.id)
  );

  const pick = React.useCallback(() => inputRef.current?.click(), []);

  const hand = React.useCallback(() => {
    if (pending.length === 0 || context.saving) return;
    context.change({
      attachmentIds: [...context.attachmentIds, ...pending.map((attachment) => attachment.id)],
    });
  }, [context, pending]);

  const attachFromLibrary = React.useCallback(
    (attachments: readonly { id: string }[]) => {
      const added = attachments
        .map((attachment) => attachment.id)
        .filter((id) => !context.attachmentIds.includes(id));
      if (added.length === 0) return;
      context.change({ attachmentIds: [...context.attachmentIds, ...added] });
    },
    [context]
  );

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={WORK_ACCEPT_ATTRIBUTE}
      className="hidden"
      onChange={(event) => {
        if (event.target.files?.length) addFiles(event.target.files);
        // Cleared so picking the same file twice still fires a change event.
        event.target.value = "";
      }}
    />
  );

  return { uploads, pick, remove, isUploading, pending, hand, attachFromLibrary, input };
}
