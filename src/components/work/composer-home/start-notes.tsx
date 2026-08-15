"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { WorkDegradation } from "@/lib/work/domain";
import type { ClientWorkSession } from "@/lib/work/serializers";
import type { WorkBlocked } from "@/components/work/work-transport";
import { DegradationNotes, WorkStateNote } from "@/components/work/work-vocabulary";
import { WorkLoadError } from "@/components/work/shell/work-states";
import type { StartFailure } from "@/components/work/composer-home/start-attempt";
import { cn } from "@/lib/utils";

/*
 * The honest answer to "will this actually run", under the composer.
 *
 * Newest fact last: what the browser worked out for itself, then what the server
 * said when it disagreed. Extracted from `work-composer.tsx`, where these five
 * mutually-exclusive-ish branches were a hundred and thirty lines of trailing
 * JSX after the surface had already been rendered — the part of the file a
 * reader reaches after they have stopped expecting anything new.
 *
 * They are exclusive by construction rather than by an `else if` chain, and the
 * guards are worth keeping in one place because each is a different claim:
 *
 *   executorsUnknown  the host list never answered, so Juno cannot say whether
 *                     anything would pick this up. Nothing else is drawn — every
 *                     other note below would be a statement about a fleet this
 *                     page has no facts about.
 *   no target         the local preview reached a dead end. Suppressed once the
 *                     server has spoken, because its sentence is better.
 *   degradation       it WILL run, with less than was asked for.
 *   blocked           the server re-ran the same selection against fresher facts
 *                     and refused.
 *   failure           the request itself did not land.
 *
 * The draft link is shared by the last two. A refused or failed press still
 * leaves a saved draft, and a task that is on the server but not on the screen
 * is a task the reader has to be told how to find.
 */

/** The gap above each note, so five branches cannot end up on four spacings. */
const NOTE_GAP = "mt-2.5";

export function WorkStartNotes({
  executorsUnknown,
  loadingHosts,
  onRetryHosts,
  targetFound,
  targetExplanation,
  degradation,
  blocked,
  failure,
  draft,
  canStart,
  submitting,
  onConfirmExpensive,
  onRetryStart,
}: {
  /** The host list failed and there is nothing to fall back on. */
  executorsUnknown: boolean;
  /** The host list is still in flight. */
  loadingHosts: boolean;
  onRetryHosts: () => void;
  /** False when the local preview found nowhere for this task to run. */
  targetFound: boolean;
  /** `selectForInferred`'s own sentence, either way. */
  targetExplanation: string;
  degradation: readonly WorkDegradation[];
  blocked: WorkBlocked | null;
  failure: StartFailure | null;
  /** The saved draft a refused or failed press left behind. */
  draft: ClientWorkSession | null;
  canStart: boolean;
  submitting: boolean;
  onConfirmExpensive: () => void;
  onRetryStart: () => void;
}) {
  const draftLink =
    draft === null ? null : (
      <Link
        href={`/work/${draft.id}`}
        className="font-medium underline underline-offset-2 hover:text-foreground"
      >
        Open the draft
      </Link>
    );

  // Everything below the first branch is a claim about the fleet, and the fleet
  // is exactly what a failed host load leaves unknown.
  if (executorsUnknown) {
    return (
      <WorkLoadError className={NOTE_GAP} onRetry={onRetryHosts}>
        Juno couldn’t check what is available to run this, so it can’t tell you whether anything
        would pick it up. Starting is held back rather than queued into the dark.
      </WorkLoadError>
    );
  }

  return (
    <>
      {blocked === null && !targetFound && !loadingHosts && (
        <WorkStateNote tone="blocked" className={cn(NOTE_GAP, "motion-safe:animate-rise-in")}>
          {targetExplanation}
        </WorkStateNote>
      )}

      {/* `!loadingHosts` matters here now that the preview yields rather than
          refuses: with the host list still in flight there is no Mac to serve a
          local guess, so the selection carries a "the local part will not run"
          degradation that a Mac two hundred milliseconds away would have
          answered. Showing it and then withdrawing it is a warning the reader
          cannot act on. */}
      {blocked === null && !loadingHosts && targetFound && degradation.length > 0 && (
        // `bg-warning/10` and not `/5` — the same fill `WorkStateNote`'s warning
        // tone uses, which is the box this one sits directly above in several
        // states. `/5` composited to ~2.9% over the black ground, so two warning
        // boxes in one column were drawn at visibly different weights for no
        // difference in what they were saying.
        <div
          className={cn(
            NOTE_GAP,
            "rounded-field border border-warning/35 bg-warning/10 px-3.5 py-2.5 motion-safe:animate-rise-in"
          )}
        >
          <DegradationNotes degradation={degradation} />
        </div>
      )}

      {blocked !== null && (
        <WorkStateNote tone="blocked" className={cn(NOTE_GAP, "motion-safe:animate-rise-in")}>
          <p>{blocked.explanation}</p>
          <DegradationNotes degradation={blocked.degradation} className="mt-2" />
          {blocked.confirmation?.kind === "expensive_work" && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onConfirmExpensive}
                disabled={submitting || !canStart}
                className="border-warning/40 text-foreground hover:bg-warning/10"
              >
                Confirm and start
              </Button>
              <span className="text-caption tabular-nums text-muted-foreground">
                Estimate: ${(blocked.confirmation.estimatedCostMicroUsd / 1_000_000).toFixed(2)}
              </span>
            </div>
          )}
          {draftLink !== null && (
            <p className="mt-2 text-ui">
              Nothing was queued. The task is saved as a draft. {draftLink}
            </p>
          )}
        </WorkStateNote>
      )}

      {/* The failed press. The button appears only where it could work: a wall —
          a 400, a plan that admits no model, something that is gone — answers
          the same way every time, and a Try again beside it costs the reader a
          press to learn what the sentence already told them. */}
      {failure !== null && (
        <WorkLoadError
          className={NOTE_GAP}
          retryLabel="Try again"
          onRetry={failure.retryable ? onRetryStart : undefined}
          retryDisabled={!canStart}
        >
          <p>{failure.message}</p>
          {/* No "nothing was queued" here, unlike the refusal above. A refusal
              is the server saying so; a failed request may have arrived and lost
              only its answer, and the idempotency key is what makes the next
              press safe rather than any claim this line could make. */}
          {draftLink !== null && (
            <p className="mt-2 text-ui">The task is saved as a draft. {draftLink}</p>
          )}
        </WorkLoadError>
      )}
    </>
  );
}
