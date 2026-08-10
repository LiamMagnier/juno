"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientWorkHost } from "@/lib/work/serializers";
import { WorkPageFrame } from "@/components/work/work-nav";
import { WorkHostRow } from "@/components/work/work-host-row";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkHosts,
} from "@/components/work/work-transport";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { staggerDelay } from "@/lib/motion";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Every Mac that has registered itself with Juno Work.
 *
 * This is the first surface in the browser that admits these machines exist. A
 * Mac has been able to register, heartbeat and execute tasks for some time, and
 * `/api/work/hosts` has been listing them the whole time — the composer reads
 * that list to decide whether a task can run locally, and never showed it. So a
 * user could watch a task be refused for want of a Mac with no way to find out
 * which of their Macs was asleep, what it was allowed to do, or how to stop it.
 *
 * Polled on the shared trio — interval, visibility, sync event — because
 * presence is the thing this page is for and it changes with nobody clicking.
 * The state on each row was computed by the server from `lastSeenAt` when the
 * response was written (90s to stale, 5 minutes to offline; see the note in
 * work-host-row.tsx), so a WORK_POLL_MS-old response is never more than one
 * 30-second interval behind the clock the dispatcher uses.
 *
 * Revoked Macs are in the list, deliberately, and the route sends them for the
 * same reason: a Mac switched off for Work is still one of the user's Macs, and
 * a page that stopped listing it could not show that it was revoked, when, or
 * offer to switch it back on.
 */
export default function WorkHostsPage() {
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    const result = await fetchWorkHosts();
    if (result.kind === "ok") {
      setHosts(result.value);
      setFailed(false);
      return;
    }
    // `hosts` is deliberately not touched. Before the first success it is still
    // null, and the note below renders instead of an empty list — an empty list
    // and a failed request are the same picture, and only one of them means "you
    // have no Macs". After a success it holds the last real answer, and a dropped
    // poll establishes nothing about the fleet that would justify replacing it.
    setFailed(true);
  }, []);

  React.useEffect(() => {
    void load();
    const tick = () => {
      if (!document.hidden) void load();
    };
    const interval = window.setInterval(tick, WORK_POLL_MS);
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  /**
   * Revoked Macs last, and otherwise exactly the order the route sent.
   *
   * The route orders by `lastSeenAt` descending, which is the right order for
   * the ones that still work — the Mac you were just using is the one you came
   * here about. It is the wrong place for a revoked machine, which heartbeated
   * recently precisely because it was in use right up until it was revoked, and
   * would otherwise sit at the top of the list looking like the live one. This
   * is a stable partition rather than a second sort, the same way the Work home
   * lifts pinned tasks without re-ordering the rest.
   */
  const ordered = React.useMemo(() => {
    const rows = hosts ?? [];
    return [
      ...rows.filter((host) => host.revokedAt === null),
      ...rows.filter((host) => host.revokedAt !== null),
    ];
  }, [hosts]);

  return (
    <WorkPageFrame
      title="Macs"
      description="The Macs signed in to Juno Work. Anything a task needs a real machine for — a folder on disk, an app, your signed-in browser — happens on one of these, so this is where you say what each of them may do, and where you take it back."
      action={
        hosts === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="h-7 gap-1.5 px-2 font-mono text-[10px] text-muted-foreground"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh
          </Button>
        )
      }
    >
      {failed && hosts === null ? (
        <WorkStateNote
          tone="error"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
            </Button>
          }
        >
          Couldn’t load your Macs. This page is empty because the request failed, not because you
          have none — anything already signed in is still reachable by Juno, with whatever
          permissions it had.
        </WorkStateNote>
      ) : hosts === null ? (
        <div className="space-y-2.5">
          {[...Array(2)].map((_, index) => (
            <Skeleton
              key={index}
              className="h-[86px] w-full rounded-field"
              style={staggerDelay(index, "tight")}
            />
          ))}
        </div>
      ) : hosts.length === 0 ? (
        <EmptyState
          title="No Macs yet"
          description="A Mac appears here on its own once you install Juno on it, sign in and switch Work on from the app. Until one does, every task runs in the cloud — which means a task that needs a folder on your disk, an app or your signed-in browser cannot run at all."
        />
      ) : (
        <>
          {/* Shown above a list that still has real rows in it. Blanking the
              list would state that the fleet is unknown, which the failed poll
              did not establish; the rows are what we last actually knew. */}
          {failed && (
            <WorkStateNote tone="warning" className="mb-2.5">
              These are the last answers Juno got. The most recent check failed, so a Mac may have
              woken or gone away since.
            </WorkStateNote>
          )}
          <div className="space-y-2.5">
            {ordered.map((host, index) => (
              <WorkHostRow key={host.id} host={host} index={index} />
            ))}
          </div>
        </>
      )}
    </WorkPageFrame>
  );
}
