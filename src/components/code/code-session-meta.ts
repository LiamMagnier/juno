"use client";

import * as React from "react";

import { deviceOffersWorkspace, type DeviceRow } from "@/components/code/device-presence";
import { CODE_SYNC_EVENT } from "@/hooks/use-code-session";

/*
 * What a code session IS, as opposed to what it is saying.
 *
 * Both hooks below used to sit at the top of code-session-view.tsx, ahead of
 * 1,400 lines of composer JSX, and neither renders anything: they answer "which
 * machine runs this" and "is that machine reachable". Splitting them out is not
 * filing — it is what lets the banner take the answers as plain props and be
 * read on its own, and it keeps the two poll loops (a 30s device poll and a
 * sync-event-driven task refetch) somewhere a reader can find them without
 * scrolling past a textarea.
 */

export type PresenceState = "checking" | "online" | "offline" | "none" | "error";
export type Presence = { state: PresenceState; device: { id: string; name: string } | null };

const PRESENCE_POLL_MS = 30_000;

/** The Mac that owns this session's workspace, and whether it's reachable.
 *  Gentle poll while the tab is visible; refreshes immediately on refocus.
 *
 *  `enabled` is false for a cloud session, which has no Mac in the loop at all:
 *  it used to poll /api/code/devices every 30 seconds forever, and — because a
 *  workspace matches on NAME when it has no key — a user with a synced local
 *  folder named like the repo was told "Mac connected" on a run that never
 *  touches their Mac. */
export function useDevicePresence(
  workspaceKey: string | null,
  workspaceName: string | null,
  enabled: boolean,
) {
  const [presence, setPresence] = React.useState<Presence>({ state: "checking", device: null });

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/code/devices");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { devices?: DeviceRow[] };
      const candidates = (Array.isArray(data.devices) ? data.devices : [])
        .filter((d) => deviceOffersWorkspace(d, workspaceKey, workspaceName))
        .sort((a, b) => {
          if (!!a.online !== !!b.online) return a.online ? -1 : 1;
          return new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
        });
      const device = candidates[0];
      setPresence(
        device
          ? { state: device.online ? "online" : "offline", device: { id: device.id, name: device.name } }
          : { state: "none", device: null }
      );
    } catch {
      // Keep the last honest reading if we had one; otherwise say we don't know.
      setPresence((prev) => (prev.state === "checking" ? { state: "error", device: null } : prev));
    }
  }, [workspaceKey, workspaceName]);

  React.useEffect(() => {
    if (!enabled) return;
    void refresh();
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const interval = window.setInterval(tick, PRESENCE_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, refresh]);

  /*
   * `refresh` is handed out as-is for the blocked note's "Check again", and
   * deliberately does NOT blank the reading to "checking" first. A manual
   * re-check that wipes the state re-renders the note into the one branch that
   * has no button, so the control the user just pressed disappears under their
   * finger and comes back a round trip later. The note owns a local busy flag
   * for the wait instead, and the last honest reading stays on screen.
   */
  return { presence, refresh };
}

export type CodeTaskMeta = {
  loaded: boolean;
  isCloud: boolean;
  repoOwner: string | null;
  repoName: string | null;
  baseRef: string | null;
  prUrl: string | null;
};

type TaskMetaRow = {
  target?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  baseRef?: string | null;
  prUrl?: string | null;
};

/** Whether this session runs in the cloud, and its repo / PR — read from the
 *  session's tasks (serializeTask carries target/repo/prUrl). The latest task
 *  defines the surface; the PR link is the newest task that has one. Refreshes
 *  on the code-sync signal so a completed run's PR appears without a reload. */
export function useCodeTaskMeta(conversationId: string): CodeTaskMeta & { refresh: () => void } {
  const [meta, setMeta] = React.useState<CodeTaskMeta>({
    loaded: false,
    isCloud: false,
    repoOwner: null,
    repoName: null,
    baseRef: null,
    prUrl: null,
  });

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/code/tasks?conversationId=${encodeURIComponent(conversationId)}&limit=20`);
      // Throw rather than return: the catch below is what releases `loaded`.
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { tasks?: TaskMetaRow[] };
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      const latest = tasks[0];
      const withRepo = tasks.find((t) => t.repoOwner && t.repoName);
      const prUrl = tasks.find((t) => typeof t.prUrl === "string" && t.prUrl)?.prUrl ?? null;
      setMeta({
        loaded: true,
        isCloud: latest?.target === "cloud",
        repoOwner: latest?.repoOwner ?? withRepo?.repoOwner ?? null,
        repoName: latest?.repoName ?? withRepo?.repoName ?? null,
        baseRef: latest?.baseRef ?? withRepo?.baseRef ?? null,
        prUrl,
      });
    } catch {
      // Keep the last reading; a device session simply stays non-cloud. But
      // mark it read: now that `loaded` gates the banner and the composer, a
      // failed lookup that left it false would park the session in "getting
      // ready" forever, with the composer disabled and no way out.
      setMeta((prev) => (prev.loaded ? prev : { ...prev, loaded: true }));
    }
  }, [conversationId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  React.useEffect(() => {
    const on = () => void refresh();
    window.addEventListener(CODE_SYNC_EVENT, on);
    return () => window.removeEventListener(CODE_SYNC_EVENT, on);
  }, [refresh]);

  return { ...meta, refresh };
}

/*
 * FULL-STRENGTH FILLS, and that is a contrast fix rather than a taste one.
 *
 * The two most-seen states were drawn as opacity-thinned dots — /40 for checking
 * and /50 for offline and none — alphas tuned against the old 9%-lightness
 * ground. That ground is now `0 0% 0%`, where /40 composites to ~2.1:1 and /50
 * to ~2.8:1, both under the 3:1 minimum for a non-text indicator. The dot is the
 * only mark in the banner that says whether this session can run anything, so it
 * has to survive.
 *
 * `offline` takes `bg-warning`, not a grey: a Mac that exists but is asleep is a
 * recoverable blocker, and it should not read the same as `none`, which is a
 * project no Mac has ever synced.
 */
export const PRESENCE_META: Record<PresenceState, { label: string; dot: string }> = {
  checking: { label: "Checking your Mac…", dot: "bg-muted-foreground motion-safe:animate-pulse" },
  online: { label: "Mac connected", dot: "bg-success" },
  offline: { label: "Mac offline", dot: "bg-warning" },
  none: { label: "No Mac has synced this project", dot: "bg-muted-foreground" },
  error: { label: "Presence unavailable", dot: "bg-warning" },
};
