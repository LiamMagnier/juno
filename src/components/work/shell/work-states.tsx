"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionIcons } from "@/lib/app-icons";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * The two shapes every Work list wears before it has rows: "this is still
 * loading" and "this did not load".
 *
 * Both were being written out by hand on every surface. The failure note in
 * particular had ten copies — Work home, the thread page, schedules, skills,
 * hosts, the two host and skill detail pages, the composer twice, and the
 * documents panel — each one repeating the same twenty-five characters of
 * destructive Button overrides:
 *
 *   className="gap-1.5 border-destructive/30 text-destructive
 *              hover:bg-destructive/10 hover:text-destructive"
 *
 * Ten copies of a class list is ten chances for one of them to drift, and two of
 * them already had: the hosts page's Refresh spun a 12px glyph where every other
 * one was 14px, and the composer's said "Try again" where the pages said
 * "Retry" for the identical act. Neither is a decision anybody made.
 *
 * The skeletons had the same problem in a quieter form. Six lists each declared
 * their own placeholder height — 86px, 76px, 64px, 16 — for rows that are all
 * the same row: title, subtitle, mono meta line, `px-3.5 py-3`. A placeholder
 * that is not the height of the thing it stands in for is a layout shift dressed
 * as a loading state, and three different wrong heights is three different
 * shifts on three sibling pages.
 */

/**
 * The height of a Work list row's placeholder.
 *
 * Derived from the row rather than chosen: `px-3.5 py-3` is 24px of vertical
 * padding, over a `text-body` title (24px), a `text-ui` subtitle (20px, +4 gap)
 * and a `text-micro` meta line (16px, +6 gap). That is 94px, and every list row
 * in Work — task, schedule, skill, Mac — is built to that same three-line
 * pattern, so they share one number and the swap from placeholder to row moves
 * nothing.
 */
const WORK_ROW_HEIGHT = 94;

/**
 * Line widths for the placeholder rows, varied per row so a stack of them reads
 * as a list of different things rather than one stamped shape. Indexed modulo
 * their length; the three columns are title, subtitle and meta line.
 */
const LINE_WIDTHS = [
  ["w-2/5", "w-3/4", "w-1/3"],
  ["w-1/3", "w-2/3", "w-2/5"],
  ["w-1/2", "w-4/5", "w-1/4"],
] as const;

/**
 * A list still loading, as rows rather than as a spinner.
 *
 * Inside a `WorkList` (no `height`), each placeholder is the ROW: the same
 * `px-3.5 py-3` box and the same three line boxes — title, subtitle, mono meta
 * — with a bar set in each at the height of its text. A 94px slab stood in for
 * a row that is text on the panel, so the swap changed the shape of the list
 * even though it did not move it; now the bars are where the words land. The
 * line boxes add up to `WORK_ROW_HEIGHT`, so nothing moves either.
 *
 * With a `height`, it is a plain block for a list whose rows are genuinely a
 * different shape (a document, a run) and which the caller has measured.
 *
 * The cascade is `staggerDelay(i, "tight")` — the same rung the real rows arrive
 * on — so the placeholder and the content it becomes are dealt out at one tempo.
 * A skeleton that appears all at once and is replaced by rows that cascade reads
 * as two different lists.
 *
 * `aria-hidden`, and every caller is responsible for saying "loading" once
 * somewhere a screen reader can hear it. The route-level `loading.tsx` files put
 * `role="status"` with a label on the page frame; the in-page callers are
 * replacing content that was already announced. What must not happen is this
 * component announcing itself per row.
 */
export function WorkRowSkeletons({
  count = 3,
  /** Override only for a list whose rows are genuinely a different shape. */
  height,
  className,
}: {
  count?: number;
  height?: number;
  className?: string;
}) {
  if (height !== undefined) {
    return (
      <div className={cn("space-y-2.5", className)} aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <Skeleton
            key={index}
            // The entrance as well as the delay. Without it the delay is inert —
            // `animation-delay` on an element with no animation is nothing.
            className="w-full rounded-field [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={{ height, ...staggerDelay(index, "tight") }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("space-y-0.5", className)} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => {
        const [title, subtitle, meta] = LINE_WIDTHS[index % LINE_WIDTHS.length];
        return (
          <div
            key={index}
            // The row's own box: the same transparent hairline and padding, so
            // the bars sit exactly where the row's text will.
            className="rounded-control border border-transparent px-3.5 py-3 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={{ minHeight: WORK_ROW_HEIGHT + 2, ...staggerDelay(index, "tight") }}
          >
            <div className="flex h-6 items-center">
              <Skeleton className={cn("h-3.5 rounded-sm", title)} />
            </div>
            <div className="mt-1 flex h-5 items-center">
              <Skeleton className={cn("h-3 rounded-sm", subtitle)} />
            </div>
            <div className="mt-1.5 flex h-4 items-center">
              <Skeleton className={cn("h-2.5 rounded-sm", meta)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A list that could not be loaded, and the one press that could fix it.
 *
 * `onRetry` is optional and its absence is meaningful rather than lazy: a 404,
 * a 401 and a request this deployment refuses all answer the same way the second
 * time, and a button that re-asks a settled question costs the reader a press to
 * learn what the sentence already told them. Every caller that omits it has that
 * reason.
 *
 * The children carry the sentence, and the sentence every caller writes has the
 * same second clause for the same reason — an empty list and a failed request
 * are the same picture, so the note has to say which one the reader is looking
 * at. That is left to the caller because only it knows what "none" would mean.
 */
export function WorkLoadError({
  onRetry,
  /**
   * Offered but not pressable — for a retry that is genuinely possible and
   * genuinely not possible *yet*, which is not the same as a wall. The composer
   * is the only caller: its Try again re-sends the task, so it has to wait for
   * an upload to finish the same way the Start button does.
   */
  retryDisabled = false,
  /** "Retry" everywhere except where the act is genuinely re-attempting work. */
  retryLabel = "Retry",
  className,
  children,
}: {
  onRetry?: () => void;
  retryDisabled?: boolean;
  retryLabel?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <WorkStateNote
      tone="error"
      className={cn("motion-safe:animate-rise-in", className)}
      action={
        onRetry === undefined ? undefined : (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={retryDisabled}
            className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
            {retryLabel}
          </Button>
        )
      }
    >
      {children}
    </WorkStateNote>
  );
}

/**
 * The refresh mark on a list's Refresh button, turning while the reload it
 * started is in flight.
 *
 * The mark itself turns rather than a spinner replacing it (ActionIcons.refresh
 * already means "run again"), so nothing in the button changes width. The
 * caller owns the flag and it means only "the request this press started has
 * not answered yet": a background poll does not spin it, because a mark that
 * turns every few seconds on its own is an idle loop, and loops are for live
 * state only.
 *
 * It FINISHES THE TURN IT IS ON. Dropping `animate-spin` the moment the
 * answer lands would snap the arrow back to 0deg from wherever it was, which
 * reads as a glitch at exactly the moment the reader is watching it; instead
 * it keeps turning until the next iteration boundary (at most one more turn)
 * and stops where it started. A fast answer therefore still shows one whole
 * turn, which is the confirmation that the press did something.
 *
 * Reduced motion: the bare `animate-spin` class is swapped for the slow fade in
 * place by the unlayered block at the end of globals.css, and the iteration
 * boundary still ends it.
 */
export function WorkRefreshGlyph({
  spinning,
  className,
}: {
  /** True while the request this button started is in flight. */
  spinning: boolean;
  className?: string;
}) {
  const [turning, setTurning] = React.useState(spinning);
  // Adjusted during render rather than in an effect, so the first frame of a
  // press already turns.
  if (spinning && !turning) setTurning(true);
  return (
    <ActionIcons.refresh
      aria-hidden="true"
      className={cn(className, turning && "animate-spin")}
      onAnimationIteration={() => {
        if (!spinning) setTurning(false);
      }}
    />
  );
}
