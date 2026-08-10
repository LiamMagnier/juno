"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { ClientWorkHost } from "@/lib/work/serializers";
import type { WorkHostState } from "@/lib/work/domain";
import { HOST_STATE_LABEL, hostUnavailableReason } from "@/components/work/work-transport";
import { workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

/*
 * One Mac in a list, and the mark that says whether it is there.
 *
 * The row answers the three questions somebody opens this page with: is this Mac
 * reachable, is it doing anything, and which Mac is it. Everything else — what
 * it may do, what folders it has, how to take it away — is a page.
 *
 * Presence is NOT derived here. `state` is computed by the server on the way out
 * (`effectiveHostState`, src/app/api/work/protocol.ts), which narrows the host's
 * own claim by the heartbeat clock: `hostStateFor` calls a Mac stale after
 * HOST_STALE_AFTER_MS (90s) and offline after HOST_OFFLINE_AFTER_MS (5 minutes),
 * and those two numbers are the staleness threshold this surface uses. Deriving
 * it again in the browser would be a second answer to a question the dispatcher
 * already answers — and the dispatcher's is the one that decides whether a task
 * actually goes to this Mac, so a row disagreeing with it would be wrong in the
 * way that costs the user a task queued at a machine that is not listening.
 *
 * What the browser owns instead is freshness: the list page re-reads on the
 * shared WORK_POLL_MS interval, which is 30s, so the label here is never more
 * than one interval behind the clock the server used. `lastSeenAt` is printed
 * beside it so a reader can check that for themselves.
 *
 * Revocation beats presence, always. A revoked Mac's row says "Revoked" and not
 * "Offline", because sending somebody to wake a machine whose access they
 * themselves withdrew is the most expensive way to be unhelpful here.
 */

const STATE_DOT: Record<WorkHostState, string> = {
  online: "bg-primary motion-safe:animate-pulse",
  idle: "bg-success",
  stale: "bg-warning",
  offline: "bg-muted-foreground/50",
};

const STATE_PILL: Record<WorkHostState, string> = {
  online: "border-primary/25 bg-primary/10 text-primary",
  idle: "border-success/30 bg-success/10 text-success-ink",
  stale: "border-warning/35 bg-warning/10 text-warning-foreground",
  offline: "border-border/70 bg-background/50 text-muted-foreground",
};

/**
 * Whether this Mac can be reached, as a chip.
 *
 * Coral (`--primary`) is reserved across Work for "this is happening now", which
 * is exactly what `online` means for a host: `hostStateFor` only returns it when
 * the heartbeat is fresh AND there is at least one active run. A Mac that is
 * awake and unoccupied is `idle`, and it gets the green of a good state rather
 * than the accent, so the accent keeps meaning what it means everywhere else on
 * this surface.
 */
export function WorkHostStatePill({
  host,
  className,
}: {
  host: ClientWorkHost;
  className?: string;
}) {
  const revoked = host.revokedAt !== null;
  const reason = hostUnavailableReason(host);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
        revoked ? "border-destructive/35 bg-destructive/10 text-destructive" : STATE_PILL[host.state],
        className
      )}
      title={reason ?? "This Mac is checking in and will take work."}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          revoked ? "bg-destructive" : STATE_DOT[host.state]
        )}
        aria-hidden="true"
      />
      {revoked ? "Revoked" : HOST_STATE_LABEL[host.state]}
    </span>
  );
}

/**
 * What this Mac is doing, as a sentence, or null when the answer is "nothing".
 *
 * The two counts are separate columns and they mean different things — a run
 * that is under way versus one that has been placed here and not started — so
 * they are said separately. A single "5 tasks" would hide the case worth seeing:
 * nothing running and four queued is a Mac that has stopped picking work up.
 */
export function hostWorkloadSentence(host: ClientWorkHost): string | null {
  const parts: string[] = [];
  if (host.activeRunCount > 0) {
    parts.push(host.activeRunCount === 1 ? "1 task running" : `${host.activeRunCount} tasks running`);
  }
  if (host.queuedRunCount > 0) {
    parts.push(`${host.queuedRunCount} queued`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

export function WorkHostRow({ host, index = 0 }: { host: ClientWorkHost; index?: number }) {
  const revokedAt = host.revokedAt;
  const revoked = revokedAt !== null;
  const workload = hostWorkloadSentence(host);
  return (
    <Link
      href={`/work/hosts/${host.id}`}
      className={cn(
        "group flex items-start gap-3 rounded-field border border-border/60 bg-card/60 px-3.5 py-3 transition-[background-color,border-color] duration-base ease-out-soft hover:border-border hover:bg-card motion-safe:animate-rise-in",
        "[animation-fill-mode:backwards]",
        // Dimmed for the same reason a paused schedule and a switched-off skill
        // are: it is still yours, it is still listed, and it is not going to do
        // anything. The chip is what says which of the two it is.
        (revoked || !host.enabled) && "opacity-75",
        revoked && "border-destructive/25"
      )}
      style={staggerDelay(index, "tight")}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {host.displayName}
          </span>
          <WorkHostStatePill host={host} />
          {/* Only when it adds something the chip has not. A revoked Mac is
              already switched off by the DELETE handler, and two chips saying
              the same thing would make the second one look like a second fact. */}
          {!revoked && !host.enabled && (
            <span className="shrink-0 rounded-full border border-border/70 bg-background/50 px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
              Work off
            </span>
          )}
        </span>
        <span className="mt-1 block truncate text-[13px] leading-relaxed text-muted-foreground">
          {revokedAt !== null
            ? `Revoked ${workTimeAgo(revokedAt)}. It cannot claim anything.`
            : (workload ?? "Nothing running on it right now.")}
        </span>
        <span className="mt-1.5 block truncate font-mono text-[10px] text-muted-foreground/70">
          {host.platform} · Juno {host.appVersion} · last seen {workTimeAgo(host.lastSeenAt)}
        </span>
      </span>
      <ChevronRight
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform duration-base ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground"
        aria-hidden="true"
      />
    </Link>
  );
}
