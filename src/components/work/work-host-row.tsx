"use client";

import Link from "next/link";
import { ChevronRight } from "@/components/ui/icons";
import type { ClientWorkHost } from "@/lib/work/serializers";
import { HOST_STATE_LABEL, hostUnavailableReason } from "@/components/work/work-transport";
import {
  workRowChevronClass,
  workRowClass,
  workRowEnterClass,
} from "@/components/work/shell/work-section";
import { WorkTag, workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";
import { PhaseOrb } from "@/components/effects/phase-orb";
import { StatusIcons } from "@/lib/app-icons";
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

/**
 * Whether this Mac can be reached, AS WORDS (owner directive, 2026-09-26: it
 * was a tinted pill with a dot, the busy state pulsing coral). Online and idle
 * are muted words, busy adds a Thinking orb on the line; a stale heartbeat
 * and a revoked Mac, the two states that ask for the reader, keep their ink
 * and a small mark. Still no container.
 *
 * Revocation beats presence, as before.
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
        "inline-flex shrink-0 items-center gap-1.5 font-mono text-micro leading-none",
        revoked
          ? "font-medium text-destructive"
          : host.state === "stale"
            ? "font-medium text-warning-foreground"
            : "text-muted-foreground",
        className
      )}
      title={reason ?? "This Mac is checking in and will take work."}
    >
      {revoked ? (
        <StatusIcons.error className="size-3 shrink-0" aria-hidden="true" />
      ) : host.state === "stale" ? (
        <StatusIcons.warning className="size-3 shrink-0" aria-hidden="true" />
      ) : host.state === "online" ? (
        <PhaseOrb state="working" className="-my-1.5 -ml-1" />
      ) : null}
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
      href={`/permissions/${host.id}`}
      className={cn(
        // The shared list-row recipe (work-section.tsx): text on the well at
        // rest, a tonal fill under the pointer, a darker one while pressed, and
        // the global focus outline.
        workRowClass,
        workRowEnterClass,
        "active:bg-selected",
        // Dimmed for the same reason a paused schedule and a switched-off skill
        // are: it is still yours, it is still listed, and it is not going to do
        // anything. The chip is what says which of the two it is.
        (revoked || !host.enabled) && "opacity-75",
        // The one row in the well that keeps an edge at rest: a Mac whose
        // access was withdrawn is still listed, and the hairline is what keeps
        // it from reading as one more machine that is merely asleep.
        revoked && "border-destructive/25"
      )}
      style={staggerDelay(index, "tight")}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* `text-body`, matching the task row's title — see the note there. */}
          <span className="min-w-0 truncate text-body font-medium leading-snug text-foreground">
            {host.displayName}
          </span>
          <WorkHostStatePill host={host} />
          {/* Only when it adds something the chip has not. A revoked Mac is
              already switched off by the DELETE handler, and two chips saying
              the same thing would make the second one look like a second fact. */}
          {!revoked && !host.enabled && <WorkTag>Work off</WorkTag>}
        </span>
        <span className="mt-1 block truncate text-ui leading-relaxed text-muted-foreground">
          {revokedAt !== null
            ? `Revoked ${workTimeAgo(revokedAt)}. It cannot claim anything.`
            : (workload ?? "Nothing running on it right now.")}
        </span>
        <span className="mt-1.5 block truncate font-mono text-micro tabular-nums text-muted-foreground">
          {host.platform} · Juno {host.appVersion} · last seen {workTimeAgo(host.lastSeenAt)}
        </span>
      </span>
      <ChevronRight className={workRowChevronClass} aria-hidden="true" />
    </Link>
  );
}
