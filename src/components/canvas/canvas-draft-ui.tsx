"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { History } from "@/components/ui/icons";
import { Phrase, PhraseWithArgs } from "@/lib/i18n-phrase";
import { useUiLocale } from "@/lib/i18n-format";
import { CANVAS_DRAFT_COPY, relativeDraftAge, type CanvasDraftOffer } from "@/lib/canvas-draft";
import type { PhraseLine } from "@/lib/run/types";

/*
 * The two places the canvas talks about an unsaved edit (G12).
 *
 *   - The restore bar, when an artifact opens with an edit kept from last
 *     time: what it is, how old, whether the artifact moved on since, and
 *     Restore or Discard. A bar rather than a dialog, so reading the artifact
 *     is never blocked by a question about it.
 *   - The close dialog, when Close is pressed with an edit in the editor:
 *     Save version, Keep draft, or Discard edits. An incognito canvas keeps
 *     nothing, so there it is Keep editing or Discard edits.
 *
 * Both carry the canvas's own chrome (hairlines, the card rung) and the
 * motion its other bars use: the restore bar fades in on the base rung and
 * nothing else moves.
 */

/** "Unsaved draft · 3 minutes ago · Started before the latest version". */
export function draftOfferLine(offer: Pick<CanvasDraftOffer, "updatedAt" | "stale">, now: number, locale: string): PhraseLine {
  const age = relativeDraftAge(offer.updatedAt, now, locale);
  return [
    { parts: [{ phrase: CANVAS_DRAFT_COPY.restoreTitle }] },
    ...(age ? [{ parts: [age === CANVAS_DRAFT_COPY.justNow ? { phrase: CANVAS_DRAFT_COPY.justNow } : { kind: "label" as const, value: age }] }] : []),
    ...(offer.stale ? [{ parts: [{ phrase: CANVAS_DRAFT_COPY.restoreStale }] }] : []),
  ];
}

export function DraftRestoreBar({
  offer,
  onRestore,
  onDiscard,
}: {
  offer: CanvasDraftOffer;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const locale = useUiLocale();
  // The age is read once per offer: a bar that re-rendered every minute to
  // keep "3 minutes ago" true would be the only thing on the panel moving.
  const [now] = React.useState(() => Date.now());
  return (
    <div
      role="status"
      data-canvas-draft-offer=""
      className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-card px-3 py-2 text-caption text-muted-foreground motion-safe:animate-fade-in"
    >
      <History className="size-3.5 shrink-0" aria-hidden />
      <PhraseWithArgs spec={draftOfferLine(offer, now, locale)} className="min-w-0 flex-1 truncate" />
      <Button variant="ghost" size="xs" onClick={onDiscard} className="px-2 text-caption">
        <Phrase text={CANVAS_DRAFT_COPY.discard} />
      </Button>
      <Button variant="outline" size="xs" onClick={onRestore} className="text-caption">
        <Phrase text={CANVAS_DRAFT_COPY.restore} />
      </Button>
    </div>
  );
}

export function CloseWithDraftDialog({
  open,
  onOpenChange,
  persisted,
  kept,
  saving,
  onSave,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The canvas keeps drafts (not incognito). */
  persisted: boolean;
  /** The edit is already kept somewhere (this device or the server), so Keep draft is honest. */
  kept: boolean;
  saving: boolean;
  onSave: () => void;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-sm" data-canvas-close-dialog="">
        <DialogHeader>
          <DialogTitle>
            <Phrase text={CANVAS_DRAFT_COPY.closeTitle} />
          </DialogTitle>
          <DialogDescription>
            <Phrase text={CANVAS_DRAFT_COPY.closeBody} />
            {!persisted ? (
              <>
                {" "}
                <Phrase text={CANVAS_DRAFT_COPY.closeBodyIncognito} />
              </>
            ) : kept ? (
              <>
                {" "}
                <Phrase text={CANVAS_DRAFT_COPY.closeBodyKept} />
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="destructive-outline" onClick={onDiscard} disabled={saving}>
            <Phrase text={CANVAS_DRAFT_COPY.discardEdits} />
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {persisted ? (
              <>
                {kept && (
                  <Button variant="ghost" onClick={onKeep} disabled={saving}>
                    <Phrase text={CANVAS_DRAFT_COPY.keepDraft} />
                  </Button>
                )}
                <Button onClick={onSave} loading={saving}>
                  <Phrase text={CANVAS_DRAFT_COPY.saveVersion} />
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                <Phrase text={CANVAS_DRAFT_COPY.keepEditing} />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
