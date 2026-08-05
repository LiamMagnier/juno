"use client";

import * as React from "react";
import { Cloud, Laptop, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeCapability, type WorkHostState } from "@/lib/work/domain";
import type { ClientWorkHost } from "@/lib/work/serializers";
import {
  HOST_STATE_LABEL,
  hostCapabilities,
  hostUnavailableReason,
  hostWithheldCapabilities,
} from "@/components/work/work-transport";
import { WorkStateNote, workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * The executors: Juno's cloud, and each Mac that has been switched on for Work.
 *
 * Presence and permission are shown as two separate facts, because they are
 * two separate facts — a Mac can be awake, signed in, and still refuse to touch
 * a file. Collapsing them into one green dot is how a user ends up waiting for
 * a task that the machine in front of them was never going to accept.
 *
 * The cloud card carries no status light, and that is not an omission. Nothing
 * this page can fetch reports whether the cloud executor is accepting work —
 * `/api/work/hosts` describes Macs and only Macs — so a green dot beside it
 * would be decoration asserting a fact nobody checked. Whether the cloud will
 * take a task is answered by starting one, and refused in a sentence if not.
 */

const STATE_DOT: Record<WorkHostState, string> = {
  online: "bg-primary motion-safe:animate-pulse",
  idle: "bg-success",
  stale: "bg-warning",
  offline: "bg-muted-foreground/40",
};

export function WorkHostPanel({
  hosts,
  failed,
  onRetry,
}: {
  hosts: ClientWorkHost[] | null;
  failed: boolean;
  onRetry: () => void;
}) {
  // A failure with nothing previously loaded is the only case where this panel
  // has nothing true to show. A failure after a successful load leaves the last
  // known list standing, with the staleness called out below it.
  if (failed && hosts === null) {
    return (
      <WorkStateNote
        tone="error"
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
          </Button>
        }
      >
        Couldn’t load your executors, so Juno can’t say what is available to run a task right now.
      </WorkStateNote>
    );
  }

  return (
    <div className="space-y-2.5">
      {failed && (
        <WorkStateNote
          tone="warning"
          action={
            <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
            </Button>
          }
        >
          Juno couldn’t re-check your Macs just now, so what follows is the last thing it knew
          rather than what is true this second.
        </WorkStateNote>
      )}

      <div className="rounded-xl border border-border/60 bg-card/60 px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Cloud className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">Juno cloud</span>
            <span className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">
              Researches the web, uses your connected apps and writes documents. Keeps going once
              every one of your devices is offline. Cannot touch anything on your Mac.
            </span>
          </span>
        </div>
      </div>

      {hosts === null ? (
        <>
          {[...Array(2)].map((_, index) => (
            <Skeleton
              key={index}
              className="h-[92px] w-full rounded-xl"
              style={{ animationDelay: `${index * 70}ms` }}
            />
          ))}
        </>
      ) : hosts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 px-3.5 py-4 text-[13px] leading-relaxed text-muted-foreground">
          No Mac is switched on for Juno Work. Until one is, Juno can research, use your connected
          apps and produce documents — but it cannot open your own files, drive an app, or use the
          browser you are signed in to.
        </p>
      ) : (
        hosts.map((host) => <HostCard key={host.id} host={host} />)
      )}
    </div>
  );
}

function HostCard({ host }: { host: ClientWorkHost }) {
  const unavailable = hostUnavailableReason(host);
  const granted = hostCapabilities(host);
  const withheld = hostWithheldCapabilities(host);

  return (
    <div
      className={cn(
        "rounded-xl border px-3.5 py-3",
        unavailable === null ? "border-border/60 bg-card/60" : "border-warning/35 bg-warning/[0.04]"
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Laptop className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{host.displayName}</span>
          <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
            {HOST_STATE_LABEL[host.state]} · seen {workTimeAgo(host.lastSeenAt)}
          </span>
        </span>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_DOT[host.state])} aria-hidden="true" />
        <span className="sr-only">{HOST_STATE_LABEL[host.state]}</span>
      </div>

      {unavailable !== null && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-warning-foreground">{unavailable}</p>
      )}

      {granted.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {granted.map((capability) => (
            <span
              key={capability}
              className="inline-flex items-center rounded-full border border-border/70 bg-background/50 px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground"
            >
              {describeCapability(capability)}
            </span>
          ))}
        </div>
      )}

      {/* A capability the Mac advertises but has switched off is the single most
          useful thing this card can say: it is the difference between "wake the
          machine" and "change a setting on it", and only one of those helps. */}
      {withheld.length > 0 && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
          Turned off in this Mac’s Juno settings: {withheld.map(describeCapability).join(", ")}.
        </p>
      )}

      {(host.activeRunCount > 0 || host.queuedRunCount > 0) && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground tabular-nums">
          {host.activeRunCount} running · {host.queuedRunCount} queued
        </p>
      )}
    </div>
  );
}
