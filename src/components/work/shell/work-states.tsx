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
 * A list still loading, as rows rather than as a spinner.
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
  height = WORK_ROW_HEIGHT,
  className,
}: {
  count?: number;
  height?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2.5", className)} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton
          key={index}
          // The entrance as well as the delay. Without it the delay is inert —
          // `animation-delay` on an element with no animation is nothing — and
          // the six lists that wrote this block by hand were split on it: the
          // route-level placeholders rose in, the in-page ones appeared.
          className="w-full rounded-field [animation-fill-mode:backwards] motion-safe:animate-rise-in"
          style={{ height, ...staggerDelay(index, "tight") }}
        />
      ))}
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
