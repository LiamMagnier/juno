"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RefreshCw, RotateCcw, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientWorkGrant, ClientWorkHost } from "@/lib/work/serializers";
import type { WorkCapability } from "@/lib/work/domain";
import { WorkPageFrame } from "@/components/work/work-nav";
import { WorkHostStatePill, hostWorkloadSentence } from "@/components/work/work-host-row";
import { WorkHostSettings } from "@/components/work/work-host-settings";
import {
  WORK_POLL_MS,
  WORK_SYNC_EVENT,
  fetchWorkHost,
  hostUnavailableReason,
  patchWorkHost,
  revokeWorkHost,
  type PatchWorkHostInput,
  type WorkHostToggleKey,
} from "@/components/work/work-transport";
import { WorkStateNote, workTimeAgo } from "@/components/work/work-vocabulary";
import { staggerDelay } from "@/lib/motion";

/**
 * One Mac: whether it is there, what it may do, and how to take that away.
 *
 * Polled on the shared trio, like the list. Presence is the fact this page is
 * mostly about and it changes with nobody clicking — a Mac that goes to sleep
 * while somebody is reading its settings must stop claiming to be ready. The
 * poll is suppressed while a write is in flight (`busy`), because the two
 * answers race and the older one would win: there is no free-text field on this
 * page, so nothing a user has typed can be clobbered, but a toggle they have
 * just flipped can be, and would flip back on its own a moment later.
 *
 * The state on the pill is the server's, computed from `lastSeenAt` on the way
 * out — 90 seconds to `stale`, five minutes to `offline` (HOST_STALE_AFTER_MS /
 * HOST_OFFLINE_AFTER_MS in domain.ts). That is the same narrowing the run
 * dispatcher applies, which is what makes this page's answer and the answer the
 * task actually gets the same answer.
 *
 * Every state is drawn, because none of them can be exercised here: loading,
 * a Mac that is gone, a request that failed, and — the one that is easiest to
 * get wrong — a Mac that was revoked. A revoked Mac is not absent and not
 * offline. It is listed, it is named, it says when it was revoked, and it offers
 * the one thing that can be done about it.
 */
export default function WorkHostPage() {
  const { id } = useParams<{ id: string }>();

  const [host, setHost] = React.useState<ClientWorkHost | null>(null);
  const [grants, setGrants] = React.useState<ClientWorkGrant[] | null>(null);
  const [capabilities, setCapabilities] = React.useState<WorkCapability[]>([]);
  const [pendingCommands, setPendingCommands] = React.useState(0);
  const [missing, setMissing] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = React.useState(false);

  // Read by the poll, which must not fire mid-write. A ref rather than the state
  // itself so the interval does not have to be torn down and rebuilt on every
  // toggle — an effect that re-subscribes on `busy` would reset its own clock
  // each time and, on a page somebody is adjusting, would never actually tick.
  const busyRef = React.useRef(false);
  React.useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  const load = React.useCallback(async () => {
    const result = await fetchWorkHost(id);
    if (result.kind === "ok") {
      setHost(result.value.host);
      setGrants(result.value.grants);
      setCapabilities(result.value.routableCapabilities);
      setPendingCommands(result.value.pendingCommands);
      setFailed(false);
      return;
    }
    if (result.kind === "failed" && result.cause === "not_found") {
      setMissing(true);
      return;
    }
    // What was last known is left standing. A dropped request says nothing about
    // this Mac, and blanking the page would state that it is unreachable — which
    // is a claim about the machine rather than about the connection to Juno.
    setFailed(true);
  }, [id]);

  React.useEffect(() => {
    void load();
    const tick = () => {
      if (!document.hidden && !busyRef.current) void load();
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
   * One change to this Mac's settings.
   *
   * The row that comes back is what gets rendered, never the value that was
   * asked for. The route narrows: a switch the Mac has not advertised comes back
   * off and is named in `refused`, and a policy looser than the Mac's comes back
   * as the Mac's. Rendering the request optimistically would show the user a
   * permission they do not have, which is the single worst thing a page like
   * this can do.
   */
  const applyPatch = React.useCallback(
    async (patch: PatchWorkHostInput) => {
      setBusy(true);
      const result = await patchWorkHost(id, patch);
      setBusy(false);
      if (result.kind === "ok") {
        setHost(result.value.host);
        if (result.value.refused.length > 0) {
          toast.error(refusalSentence(result.value.refused));
        }
        return;
      }
      if (result.kind === "failed" && result.cause === "not_found") {
        setMissing(true);
        return;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : // The route's own sentence when it wrote one. A revoked Mac answers
            // 403 with the refusal that explains itself, and replacing it with
            // "couldn't change that" would drop the only actionable half.
            (result.message ??
              "Couldn’t change that. This Mac is exactly as it was — nothing was half-applied.")
      );
    },
    [id]
  );

  const revoke = React.useCallback(async () => {
    setBusy(true);
    const result = await revokeWorkHost(id);
    setBusy(false);
    setConfirmingRevoke(false);
    if (result.kind === "ok") {
      setHost(result.value.host);
      // Other Work surfaces poll on their own clock, and the composer decides
      // whether a task can run locally from the host list. Without this, a task
      // could be dispatched at a Mac that was revoked seconds earlier and would
      // sit unclaimed until that page's next poll.
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
      toast.success(
        result.value.cancelledCommands === 0
          ? "Revoked. This Mac can no longer claim anything."
          : result.value.cancelledCommands === 1
            ? "Revoked. One instruction that was on its way to this Mac has been cancelled."
            : `Revoked. ${result.value.cancelledCommands} instructions that were on their way to this Mac have been cancelled.`
      );
      return;
    }
    if (result.kind === "failed" && result.cause === "not_found") {
      setMissing(true);
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : (result.message ??
          "Couldn’t revoke this Mac. Its access is unchanged, so it is safe to try again.")
    );
  }, [id]);

  if (missing) {
    return (
      <WorkPageFrame title="Mac not found" back={{ href: "/work/hosts", label: "Back to Macs" }}>
        <WorkStateNote tone="error">
          This Mac is no longer registered with Juno Work. Signing out of Juno on a Mac, or removing
          the app, takes it off this list.
        </WorkStateNote>
      </WorkPageFrame>
    );
  }

  if (failed && host === null) {
    return (
      <WorkPageFrame title="Mac" back={{ href: "/work/hosts", label: "Back to Macs" }}>
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
          Couldn’t load this Mac. Nothing has been changed by the attempt — it still has whatever
          permissions it had, and this page not loading has not taken any of them away.
        </WorkStateNote>
      </WorkPageFrame>
    );
  }

  if (host === null) {
    return (
      <WorkPageFrame title="Mac" back={{ href: "/work/hosts", label: "Back to Macs" }}>
        <div className="space-y-3">
          {[...Array(4)].map((_, index) => (
            <Skeleton
              key={index}
              className="h-16 w-full rounded-field"
              style={staggerDelay(index, "tight")}
            />
          ))}
        </div>
      </WorkPageFrame>
    );
  }

  const revokedAt = host.revokedAt;
  const workload = hostWorkloadSentence(host);
  const unavailable = hostUnavailableReason(host);

  return (
    <WorkPageFrame
      title={host.displayName}
      description={`${host.platform} · Juno ${host.appVersion} · last seen ${workTimeAgo(host.lastSeenAt)}`}
      back={{ href: "/work/hosts", label: "Back to Macs" }}
      action={
        revokedAt !== null ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void applyPatch({ revoked: false })}
            className="gap-1.5"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Restore access
          </Button>
        ) : (
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmingRevoke(true)}
            className="gap-1.5"
          >
            <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" /> Revoke
          </Button>
        )
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <WorkHostStatePill host={host} />
          <span className="text-[13px] text-muted-foreground">
            {revokedAt !== null
              ? `Revoked ${workTimeAgo(revokedAt)}.`
              : (workload ?? "Nothing running on it right now.")}
          </span>
          {revokedAt === null && pendingCommands > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {pendingCommands === 1
                ? "1 instruction waiting to be picked up"
                : `${pendingCommands} instructions waiting to be picked up`}
            </span>
          )}
        </div>

        {revokedAt !== null ? (
          <WorkStateNote tone="blocked">
            Access to this Mac was revoked. It cannot claim any command, nothing already queued for
            it survived, and no task will be sent here while it stays this way. It keeps
            heartbeating and stays on this list so you can put it back — restoring access brings
            back the settings below exactly as they were, and does not re-queue anything that was
            cancelled.
          </WorkStateNote>
        ) : unavailable !== null ? (
          <WorkStateNote tone="warning">
            {unavailable} Work will not be sent here until it checks in again. Nothing below has
            been lost — these settings are what this Mac comes back to.
          </WorkStateNote>
        ) : null}

        {/* A failed poll over a page that already has real content. Blanking it
            would state that this Mac is unreachable, which the dropped request
            did not establish. */}
        {failed && (
          <WorkStateNote
            tone="warning"
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load()}
                className="gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
              </Button>
            }
          >
            This is what Juno last knew about this Mac. The most recent check failed, so it may have
            woken, gone away or been changed from another device since.
          </WorkStateNote>
        )}
      </div>

      <div className="mt-7">
        <WorkHostSettings
          host={host}
          grants={grants}
          routableCapabilities={capabilities}
          busy={busy}
          onPatch={(patch) => void applyPatch(patch)}
        />
      </div>

      <Dialog open={confirmingRevoke} onOpenChange={setConfirmingRevoke}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Revoke access for “{host.displayName}”?</DialogTitle>
            <DialogDescription>
              {/* Said plainly, in the order the server does it. The second
                  sentence is the one people are surprised by: revocation is not
                  only about the future — the queue is retired in the same write,
                  because a command left pending for a Mac that is never coming
                  back sits there for five minutes and then expires with nothing
                  saying why. */}
              This Mac stops being able to claim any command, from the moment you confirm. Work
              already queued for it is cancelled rather than left waiting, and running work on it
              stops. Anything it has already changed on your disk stays changed — revoking cannot
              reach back into work that has finished.
              {workload !== null && ` Right now: ${workload.toLowerCase()}.`}
              {pendingCommands > 0 &&
                ` ${pendingCommands === 1 ? "1 instruction is" : `${pendingCommands} instructions are`} waiting to be picked up and will be cancelled.`}
              {" "}You can restore access from this page afterwards, and the Mac keeps its settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingRevoke(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void revoke()} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Revoke access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkPageFrame>
  );
}

/**
 * What to say when the route refused to widen something.
 *
 * Named rather than swallowed, because the switch snapping back with nothing
 * beside it reads as a bug in this page, and it is not one: the Mac has not
 * advertised the capability, and the fix is on the Mac. `refused` is a list
 * because a single patch can carry more than one switch, though this page only
 * ever sends one at a time.
 */
const TOGGLE_NOUN: Record<WorkHostToggleKey, string> = {
  enabled: "Juno Work",
  allowsFileWork: "file access",
  allowsBrowser: "your browser",
  allowsComputerUse: "screen control",
  allowsShell: "shell commands",
  allowsBackground: "working while you are away",
};

function refusalSentence(refused: readonly WorkHostToggleKey[]): string {
  const names = refused.map((key) => TOGGLE_NOUN[key]);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `This Mac has not offered ${list}, so it stays off. Switch it on in Juno on the Mac itself first.`;
}
