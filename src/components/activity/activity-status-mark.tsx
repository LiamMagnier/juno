"use client";

import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { Check, Hand, XCircle } from "@/components/ui/icons";
import type { ActivityState } from "@/lib/activity/model";
import { cn } from "@/lib/utils";

/*
 * The status mark (spec §3.4): one glyph per state, in the state's role token,
 * and never the only signal (every caller prints the word beside it).
 *
 *   Running    galaxy, presence ink; turns only while its row is hovered or
 *              focused (at most one or two per window), still otherwise
 *   Needs you  hand, signal ink
 *   Ready      check, foreground
 *   Blocked    circle-x, destructive ink
 */

export const STATUS_INK: Record<ActivityState, string> = {
  running: "text-status-running",
  needs_you: "text-status-needs-you-ink",
  ready: "text-status-ready",
  blocked: "text-status-blocked",
};

/**
 * The Needs you badge (spec §3.4): a 10 hand on a 16 signal-wash disc, then the
 * count. The words live in the row's accessible name (`detail`), so this is
 * hidden from assistive tech.
 */
export function ActivityNeedsYouBadge({ count, compact = false }: { count: number; compact?: boolean }) {
  if (count <= 0) return null;
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-1 text-status-needs-you-ink">
      <span className="grid size-4 place-items-center rounded-full bg-signal-wash">
        <Hand motion="none" className="size-2.5" />
      </span>
      {!compact && <span className="font-mono text-micro tabular-nums leading-none">{count > 99 ? "99+" : count}</span>}
    </span>
  );
}

export function ActivityStatusMark({
  state,
  active = false,
  size = 12,
  className,
}: {
  state: ActivityState;
  /** The row is hovered or focused: the one case a running galaxy may turn. */
  active?: boolean;
  size?: 10 | 12 | 14;
  className?: string;
}) {
  const box = size === 10 ? "size-2.5" : size === 14 ? "size-3.5" : "size-3";
  if (state === "running") {
    return (
      <span aria-hidden="true" className={cn("inline-grid shrink-0 place-items-center", STATUS_INK.running, className)}>
        <GalaxyMark phase="working" size={size + 2} reducedMotion={!active ? true : undefined} />
      </span>
    );
  }
  const Glyph = state === "needs_you" ? Hand : state === "ready" ? Check : XCircle;
  return <Glyph motion="none" aria-hidden="true" className={cn(box, "shrink-0", STATUS_INK[state], className)} />;
}
